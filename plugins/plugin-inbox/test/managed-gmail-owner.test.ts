import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "@elizaos/plugin-assistant";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedGmailReadAdapter } from "../src/inbox/managed-gmail-adapter.ts";
import { inboxPlugin } from "../src/plugin.ts";

describe("managed Gmail owner boundary", () => {
  beforeEach(() => {
    __resetDefaultTriageServiceForTests();
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_READ_BROKER",
      "http://127.0.0.1:5209/__alpha-owner-gmail",
    );
    vi.stubEnv("ELIZA_API_TOKEN", "a".repeat(64));
  });
  afterEach(() => {
    __resetDefaultTriageServiceForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("can initialize a second runtime without duplicating or disabling the managed source", async () => {
    const runtime = { agentId: "owned-agent" } as IAgentRuntime;
    if (!inboxPlugin.init) throw new Error("Missing inbox initialization");
    await inboxPlugin.init({}, runtime);
    const first = getDefaultTriageService().getAdapter("gmail");
    expect(first).toBeInstanceOf(ManagedGmailReadAdapter);
    if (!inboxPlugin.init) throw new Error("Missing inbox initialization");
    await inboxPlugin.init({}, runtime);
    const second = getDefaultTriageService().getAdapter("gmail");
    expect(second).toBeInstanceOf(ManagedGmailReadAdapter);
    expect(
      getDefaultTriageService()
        .listAdapters()
        .filter((adapter) => adapter.source === "gmail"),
    ).toHaveLength(1);
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
    const runtime = { agentId: "owned-agent" } as IAgentRuntime;
    await expect(
      adapter.listMessages(runtime, {
        requester: { agentId: "another-agent" } as Memory,
      }),
    ).rejects.toThrow("restricted to its owner");
    expect(network).not.toHaveBeenCalled();
  });
});
