/** Optional private host transport for owner-only INBOX Gmail reads.
 * The host retains provider credentials. This source never sends or changes mail. */
import { ElizaError } from "@elizaos/core";
import type { InboxFetcher, InboxItem } from "../actions/inbox.ts";

const MAX_BYTES = 256 * 1024;
const failure = (message: string) =>
  new ElizaError(message, { code: "MANAGED_GMAIL_READ_UNAVAILABLE" });
export function managedGmailReadFetcher(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): InboxFetcher | undefined {
  const endpoint = env.ELIZA_MANAGED_GMAIL_READ_BROKER;
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw failure("Invalid managed Gmail host.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/__alpha-owner-gmail" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw failure("Managed Gmail requires its private loopback host.");
  const token = env.ELIZA_API_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw failure("Managed Gmail host authentication is unavailable.");
  return async ({ limit = 25, query, since }) => {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (query !== undefined &&
        (typeof query !== "string" || query.length > 4096)) ||
      (since !== undefined &&
        (typeof since !== "string" || !Number.isFinite(Date.parse(since))))
    )
      throw failure("Choose a valid Gmail read range of at most 50 messages.");
    const response = await request(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        limit,
        ...(query === undefined ? {} : { query }),
        ...(since === undefined ? {} : { since }),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure("The owner Gmail connection could not be verified.");
    }
    if (!response.body) throw failure("The Gmail host returned no result.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BYTES)
          throw failure("The Gmail host response is too large.");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    } catch {
      throw failure("The Gmail host returned an invalid result.");
    }
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !("items" in data) ||
      !Array.isArray(data.items) ||
      data.items.length > limit
    )
      throw failure("The Gmail host returned an invalid message list.");
    const ids = new Set<string>();
    return data.items.map((value: unknown): InboxItem => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw failure("Invalid Gmail message.");
      const row = value as Record<string, unknown>;
      for (const key of [
        "id",
        "channel",
        "senderName",
        "snippet",
        "receivedAt",
      ])
        if (typeof row[key] !== "string")
          throw failure("Invalid Gmail message fields.");
      if (
        row.platform !== "gmail" ||
        typeof row.id !== "string" ||
        !row.id ||
        ids.has(row.id) ||
        !Number.isFinite(Date.parse(row.receivedAt as string)) ||
        (row.threadTopic !== undefined &&
          typeof row.threadTopic !== "string") ||
        (row.unread !== undefined && typeof row.unread !== "boolean")
      )
        throw failure("Invalid Gmail message identity.");
      ids.add(row.id);
      return {
        id: row.id,
        platform: "gmail",
        channel: row.channel as string,
        senderName: row.senderName as string,
        snippet: row.snippet as string,
        receivedAt: row.receivedAt as string,
        ...(row.threadTopic === undefined
          ? {}
          : { threadTopic: row.threadTopic as string }),
        ...(row.unread === undefined ? {} : { unread: row.unread as boolean }),
      };
    });
  };
}
