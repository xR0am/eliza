/**
 * Bounded conditional fetch for capability-bearing ICS subscription URLs.
 *
 * Every hop goes through the shared pinned-DNS SSRF guard. Public DTOs expose
 * only an origin and SHA-256 fingerprint; callers vault the full URL.
 */

import { createHash } from "node:crypto";
import {
  ElizaError,
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
} from "@elizaos/core";
import type { IcsFetchResult, IcsFetchValidators } from "./types.js";

export const MAX_ICS_FEED_BYTES = 5 * 1024 * 1024;
const ICS_FETCH_TIMEOUT_MS = 15_000;
const MAX_ICS_REDIRECTS = 5;
const MAX_SOURCE_URL_LENGTH = 4096;

export type IcsFetchTransport = Pick<
  GuardedFetchOptions,
  "fetchImpl" | "pinnedFetchImpl" | "lookupFn"
>;

function fetchError(
  code: string,
  message: string,
  context: Record<string, unknown>,
  severity: "ephemeral" | "fatal" = "fatal",
): never {
  throw new ElizaError(message, { code, context, severity });
}

function safeValidator(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/[\r\n]/.test(value)) {
    fetchError(
      "ICS_INVALID_HTTP_VALIDATOR",
      "Calendar feed validator contains forbidden control characters.",
      {},
    );
  }
  return value;
}

export function normalizeIcsSourceUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_SOURCE_URL_LENGTH) {
    return fetchError(
      "ICS_INVALID_SOURCE_URL",
      "Calendar source URL is empty or above the length limit.",
      { maxLength: MAX_SOURCE_URL_LENGTH },
    );
  }
  const normalized = trimmed.replace(/^webcal:/i, "https:");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new ElizaError("Calendar source URL is invalid.", {
      code: "ICS_INVALID_SOURCE_URL",
      cause: error,
      severity: "fatal",
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return fetchError(
      "ICS_INVALID_SOURCE_PROTOCOL",
      "Calendar source URL must use webcal, HTTPS, or HTTP.",
      { protocol: parsed.protocol },
    );
  }
  if (parsed.username || parsed.password) {
    return fetchError(
      "ICS_SOURCE_USERINFO_FORBIDDEN",
      "Calendar source URL cannot embed username or password credentials.",
      { origin: parsed.origin },
    );
  }
  parsed.hash = "";
  return parsed;
}

export function fingerprintIcsSourceUrl(url: URL): string {
  return createHash("sha256").update(url.href).digest("hex");
}

/** Length of a line fold (a line break and one space or tab) at `index`. */
function foldLengthAt(bytes: Uint8Array, index: number): number {
  const first = bytes[index];
  const breakLength =
    first === 0x0d
      ? bytes[index + 1] === 0x0a
        ? 2
        : 1
      : first === 0x0a
        ? 1
        : 0;
  const next = bytes[index + breakLength];
  return breakLength > 0 && (next === 0x20 || next === 0x09)
    ? breakLength + 1
    : 0;
}

/**
 * RFC 5545 section 3.1 counts line length in octets, so a producer can fold a
 * line between the octets of one UTF-8 character. Such a body does not decode
 * as UTF-8 until it is unfolded. This moves each such fold to the end of its
 * character: the decoded text is then the same text with the fold one
 * character later, and the parser removes the fold as usual.
 */
function moveFoldsOutOfUtf8Sequences(bytes: Uint8Array): Uint8Array {
  const moved = new Uint8Array(bytes.length);
  let written = 0;
  // Continuation octets (10xxxxxx) that the current character still needs.
  let pending = 0;
  for (let index = 0; index < bytes.length; ) {
    const foldLength = pending > 0 ? foldLengthAt(bytes, index) : 0;
    if (foldLength > 0) {
      const rest = bytes.subarray(
        index + foldLength,
        index + foldLength + pending,
      );
      if (
        rest.length === pending &&
        rest.every((octet) => (octet & 0xc0) === 0x80)
      ) {
        moved.set(rest, written);
        moved.set(bytes.subarray(index, index + foldLength), written + pending);
        written += pending + foldLength;
        index += foldLength + pending;
        pending = 0;
        continue;
      }
    }
    const octet = bytes[index] ?? 0;
    moved[written] = octet;
    written += 1;
    index += 1;
    if (pending > 0 && (octet & 0xc0) === 0x80) pending -= 1;
    else if (octet >= 0xf0) pending = 3;
    else if (octet >= 0xe0) pending = 2;
    else if (octet >= 0xc0) pending = 1;
    else pending = 0;
  }
  return moved;
}

async function readBoundedUtf8Body(
  response: Response,
  sourceFingerprint: string,
): Promise<{ body: string; byteLength: number }> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_ICS_FEED_BYTES
  ) {
    return fetchError(
      "ICS_FEED_TOO_LARGE",
      "Calendar feed exceeds the response-size limit.",
      { sourceFingerprint, limit: MAX_ICS_FEED_BYTES },
    );
  }
  if (!response.body) {
    return fetchError(
      "ICS_FEED_BODY_MISSING",
      "Calendar feed response has no body.",
      { sourceFingerprint },
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  const decode = (value: Uint8Array): string => {
    try {
      return decoder.decode(value);
    } catch (error) {
      // error-policy:J2 Preserve the decoder failure and add only the opaque
      // source identity; capability-bearing URLs never enter the error chain.
      throw new ElizaError("Calendar feed body is not valid UTF-8.", {
        code: "ICS_FEED_INVALID_UTF8",
        context: { sourceFingerprint },
        cause: error,
        severity: "fatal",
      });
    }
  };

  const read = async () => {
    try {
      return await reader.read();
    } catch (error) {
      // error-policy:J2 Preserve transport/read failures with a redacted
      // source fingerprint so they are not mislabeled as parse failures.
      throw new ElizaError("Calendar feed body read failed.", {
        code: "ICS_FEED_BODY_READ_FAILED",
        context: { sourceFingerprint },
        cause: error,
        severity: "ephemeral",
      });
    }
  };

  try {
    while (true) {
      const chunk = await read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_ICS_FEED_BYTES) {
        await reader.cancel("calendar feed exceeded size limit");
        return fetchError(
          "ICS_FEED_TOO_LARGE",
          "Calendar feed exceeds the response-size limit.",
          { sourceFingerprint, limit: MAX_ICS_FEED_BYTES },
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = decode(moveFoldsOutOfUtf8Sequences(Buffer.concat(chunks)));
  return { body, byteLength };
}

export async function fetchIcsFeed(args: {
  sourceUrl: string;
  validators?: IcsFetchValidators;
  transport?: IcsFetchTransport;
  signal?: AbortSignal;
}): Promise<IcsFetchResult> {
  const parsed = normalizeIcsSourceUrl(args.sourceUrl);
  const sourceFingerprint = fingerprintIcsSourceUrl(parsed);
  const headers = new Headers({
    accept: "text/calendar, text/plain;q=0.9, application/octet-stream;q=0.5",
  });
  const etag = safeValidator(args.validators?.etag);
  const lastModified = safeValidator(args.validators?.lastModified);
  if (etag) headers.set("if-none-match", etag);
  if (lastModified) headers.set("if-modified-since", lastModified);

  const guarded = await fetchWithSsrfGuard({
    url: parsed.href,
    init: {
      method: "GET",
      headers,
      redirect: "manual",
    },
    maxRedirects: MAX_ICS_REDIRECTS,
    timeoutMs: ICS_FETCH_TIMEOUT_MS,
    signal: args.signal,
    ...args.transport,
  });
  try {
    const finalUrl = new URL(guarded.finalUrl);
    const responseEtag = guarded.response.headers.get("etag");
    const responseLastModified = guarded.response.headers.get("last-modified");
    if (guarded.response.status === 304) {
      return {
        state: "not_modified",
        finalOrigin: finalUrl.origin,
        etag: responseEtag ?? etag ?? null,
        lastModified: responseLastModified ?? lastModified ?? null,
      };
    }
    if (!guarded.response.ok) {
      return fetchError(
        "ICS_FEED_HTTP_ERROR",
        `Calendar feed returned HTTP ${guarded.response.status}.`,
        {
          sourceFingerprint,
          finalOrigin: finalUrl.origin,
          status: guarded.response.status,
        },
        guarded.response.status >= 500 ? "ephemeral" : "fatal",
      );
    }
    const { body, byteLength } = await readBoundedUtf8Body(
      guarded.response,
      sourceFingerprint,
    );
    return {
      state: "fetched",
      finalOrigin: finalUrl.origin,
      etag: responseEtag,
      lastModified: responseLastModified,
      body,
      byteLength,
    };
  } finally {
    await guarded.release();
  }
}
