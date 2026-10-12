/** Actual public runtime and capture buffer; only the anonymous HTTP boundary is mocked. */
import { expect, spyOn, test } from "bun:test";
import { ChannelType } from "@elizaos/core/protocol";
import { runSharedAgentTurn } from "./run-shared-agent-turn";
import {
  createOwnerCaptureBuffer,
  type OwnerModelCapture,
} from "./shared-owner-model-capture";

test("actual public preflight capture retains refused provider evidence and isolates observer failure", async () => {
  const priorKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = "csk-offline-public-capture-fixture";
  const providerPayload = {
    results: [
      {
        url: "http://127.0.0.1/not-a-public-source",
        title: "BTC report",
        excerpts: ["BTC report"],
        retainedField: { complete: true },
      },
    ],
  };
  let publicCalls = 0;
  const attemptedHttpUrls: string[] = [];
  const unexpectedHttpUrls: string[] = [];
  const http = spyOn(globalThis, "fetch").mockImplementation(
    async (url, init) => {
      const target = String(url);
      attemptedHttpUrls.push(target);
      if (target !== "https://search.parallel.ai/mcp")
        unexpectedHttpUrls.push(target);
      expect(target).toBe("https://search.parallel.ai/mcp");
      const request = JSON.parse(String(init?.body));
      expect(request.params.name).toBe("web_search");
      publicCalls++;
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(providerPayload) }],
        },
      });
    },
  );
  const capture = createOwnerCaptureBuffer(
    {
      organizationId: "11111111-1111-4111-a111-111111111111",
      userId: "22222222-2222-4222-a222-222222222222",
      roomId: "33333333-3333-4333-a333-333333333333",
      traceId: "a".repeat(32),
    },
    { maxCalls: 16, maxBytes: 1024 * 1024, expiresAt: Date.now() + 60_000 },
    () => {},
  );
  const input = {
    character: {
      name: "Public capture fixture",
      system: "You are a test persona.",
      model: "zai-glm-4.7",
    },
    history: [],
    message: "what is btc price rn",
    capabilityText: "what is btc price rn",
    execution: {
      agentKey: "personal-shared:public-capture-fixture",
      roomKey: "dm:public-capture-fixture",
      channel: { type: ChannelType.DM, source: "blooio" },
    },
  };
  try {
    const normal = await runSharedAgentTurn({
      ...input,
      ownerCapture: capture,
    });
    const events = capture
      .snapshot()
      .events.filter((event) => event.kind === "preflight")
      .map(
        (event) =>
          event.payload as {
            stage: string;
            requestedAt: number;
            observedAt: number;
            result: { success: boolean; text: string };
          },
      );
    expect(events.map((event) => event.stage)).toEqual([
      "provider-result",
      "authority-result",
    ]);
    expect(events[0].result.success).toBe(true);
    expect(JSON.parse(events[0].result.text)).toEqual(providerPayload);
    expect(events[1].result.success).toBe(false);
    expect(Number.isSafeInteger(events[0].requestedAt)).toBe(true);
    expect(events[0].observedAt).toBeGreaterThanOrEqual(events[0].requestedAt);
    const throwing: OwnerModelCapture = {
      ...capture,
      observe() {
        throw new Error("owner observer failed");
      },
      omission() {
        throw new Error("owner omission failed");
      },
    };
    const unchanged = await runSharedAgentTurn({
      ...input,
      ownerCapture: throwing,
    });
    expect(unchanged.reply).toBe(normal.reply);
    expect(unchanged.degraded).toBe(normal.degraded);
    expect(publicCalls).toBe(2);
    expect(attemptedHttpUrls).toEqual([
      "https://search.parallel.ai/mcp",
      "https://search.parallel.ai/mcp",
    ]);
    expect(unexpectedHttpUrls).toEqual([]);
    expect(
      attemptedHttpUrls.filter(
        (url) => url !== "https://search.parallel.ai/mcp",
      ),
    ).toHaveLength(0);
  } finally {
    http.mockRestore();
    if (priorKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = priorKey;
  }
});
