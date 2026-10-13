/** Public WEB_FETCH only; never loads the Node coding plugin or grants its role. */

import {
  isBlockedHostname,
  isPrivateIpAddress,
  isSensitiveKeyName,
  redactSensitiveText,
} from "@elizaos/core";
import { fetchKeylessWeb } from "@elizaos/plugin-web-search/edge";
import {
  createWebFetchAction,
  type WebFetchReader,
} from "./actions/web-fetch-core.js";

function isFreshPublicWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.href !== value ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      isBlockedHostname(url.hostname) ||
      isPrivateIpAddress(url.hostname)
    )
      return false;
    for (const [key, value] of url.searchParams)
      if (
        isSensitiveKeyName(key) ||
        redactSensitiveText(value) !== value ||
        /^(?:token|key|auth|sig|signature|session|session[_-]?id|code)$/iu.test(
          key,
        )
      )
        return false;
    return true;
  } catch {
    return false;
  }
}
export function createWebFetchEdgeAction() {
  const reader: WebFetchReader = async (url, signal) => {
    signal?.throwIfAborted();
    if (!isFreshPublicWebUrl(url))
      throw new Error("A safe canonical public HTTPS URL is required");
    const result = await fetchKeylessWeb([url], {
      signal,
      timeoutMs: 5000,
      maxResponseBytes: 262144,
      objective:
        "Read this URL and return its source content, including exact numeric values and units. If it is a JSON API, preserve the JSON. Report inability to read it; do not invent data.",
      fullContent: true,
    });
    if (!result) throw new Error("Public URL reader returned no content");
    const body = JSON.parse(result.text) as {
      results?: Array<{
        url?: unknown;
        title?: unknown;
        excerpts?: unknown;
        full_content?: unknown;
      }>;
      errors?: unknown[];
    };
    if (
      !Array.isArray(body.results) ||
      body.results.length !== 1 ||
      !Array.isArray(body.errors) ||
      body.errors.length !== 0
    )
      throw new Error("Public URL reader returned incomplete evidence");
    const record = body.results[0];
    if (
      record.url !== url ||
      typeof record.title !== "string" ||
      !Array.isArray(record.excerpts) ||
      !record.excerpts.every((value) => typeof value === "string") ||
      (!record.excerpts.some(
        (value) => typeof value === "string" && value.trim(),
      ) &&
        !(
          typeof record.full_content === "string" && record.full_content.trim()
        ))
    )
      throw new Error("Public URL reader returned mismatched evidence");
    signal?.throwIfAborted();
    return {
      kind: "provider-extract",
      provider: "parallel",
      url,
      text: JSON.stringify(record),
      observedAt: Date.now(),
      truncated: false,
    };
  };
  return createWebFetchAction(reader, {
    roleGate: { minRole: "GUEST" },
    contexts: ["web", "general"],
    contextGate: { anyOf: ["web", "general"] },
    routingHint:
      "Read one specific public HTTPS URL, including a known public JSON API -> WEB_FETCH; discover unknown URLs -> WEB_SEARCH.",
    description:
      "Read one public HTTPS URL through an anonymous provider. Returns source-bound extracted content; it is not a direct origin HTTP response or a guarantee of freshness. JSON paths are not applied to provider extracts. Private addresses, credentials and sensitive query parameters are rejected.",
  });
}
