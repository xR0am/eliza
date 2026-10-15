import type { IAgentRuntime, UUID } from "@elizaos/core";
import { runWithActionRoutingContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedGmailReadAdapter } from "../src/inbox/managed-gmail-adapter.ts";

describe("managed Gmail owner boundary", () => {
  beforeEach(() => {
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_READ_BROKER",
      "http://127.0.0.1:5209/__alpha-owner-gmail",
    );
    vi.stubEnv("ELIZA_API_TOKEN", "a".repeat(64));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("refuses a source call without an executing owner action before network access", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const adapter = new ManagedGmailReadAdapter();
    await expect(
      adapter.listMessages({ agentId: "owned-agent" } as IAgentRuntime, {}),
    ).rejects.toThrow("current owner request");
    expect(network).not.toHaveBeenCalled();
  });
  it("refuses a message from another agent before any provider read", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const adapter = new ManagedGmailReadAdapter();
    const runtime = {
      agentId: "owned-agent",
      getMemoryById: vi.fn(async () => ({ agentId: "another-agent" })),
    } as unknown as IAgentRuntime;
    await expect(
      runWithActionRoutingContext(
        {
          actionName: "MESSAGE",
          modelClass: undefined,
          messageId: "11111111-1111-4111-8111-111111111111" as UUID,
        },
        () => adapter.listMessages(runtime, {}),
      ),
    ).rejects.toThrow("restricted to its owner");
    expect(network).not.toHaveBeenCalled();
  });
});
