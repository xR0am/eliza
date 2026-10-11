/** Keeps live configuration references aligned with committed durable state. */
import type { ElizaConfig } from "@elizaos/host/protocol";

/** Replace a live config in place so references held by callers stay valid. */
export function replaceConfigInPlace(
  state: ElizaConfig,
  next: ElizaConfig,
): void {
  const stateRecord = state as ElizaConfig & Record<string, unknown>;
  const nextRecord = next as ElizaConfig & Record<string, unknown>;
  for (const key of Object.keys(stateRecord)) {
    if (!(key in nextRecord)) {
      delete stateRecord[key];
    }
  }
  for (const [key, value] of Object.entries(nextRecord)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    stateRecord[key] = value;
  }
}

let liveConfigSource: (() => ElizaConfig) | null = null;

/**
 * The API server registers its in-memory config here. Writers outside the
 * routes (chat actions, character persistence) save straight to disk; the
 * next route save writes the in-memory copy, so they must mirror into it.
 * Returns a release that only clears the source it registered.
 */
export function setLiveElizaConfigSource(read: () => ElizaConfig): () => void {
  liveConfigSource = read;
  return () => {
    if (liveConfigSource === read) liveConfigSource = null;
  };
}

/** Mirror a config just written with saveElizaConfig into the live copy. */
export function mirrorSavedConfigToLive(saved: ElizaConfig): void {
  const live = liveConfigSource?.();
  if (live && live !== saved)
    replaceConfigInPlace(live, structuredClone(saved));
}
