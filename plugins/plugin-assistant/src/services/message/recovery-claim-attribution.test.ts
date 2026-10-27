/**
 * Reply recovery through the real runtime dispatcher with a controlled
 * renderer and grounding judge. The judge attributes each claim; only the
 * assistant's own changes need this turn's receipt.
 */
import {
  type ActionResult,
  type EffectReceipt,
  type Memory,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import { resolvePlannedReplyEgress } from "./egress-policy";
import type { RecoveredReplyClaim } from "./recovery-grounding";

const REVIEW_PREFIX = "Review recovered reply grounding.";
const SENDER_REPORT =
  "Shipped all of this, here is the commit diff: removed the 25-point cap, typed the nulls, wired charged: false.";
const REVIEW_OF_SENDER_WORK =
  "solid. removed the cap, typed the nulls and wired charged: false. i'd still glance at the fail-closed path.";
const ASSISTANT_CLAIM =
  "pushed the fix for you: i removed the 25-point cap and it's live on the worker now.";

const runtimes: ReturnType<typeof createSQLiteTestRuntime>[] = [];
afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

function fixture(
  renders: { response: string; effectReceiptIds?: string[] }[],
  reviews: { grounded: boolean; claims: RecoveredReplyClaim[] }[],
) {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Recovery", bio: "test", settings: {} },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  const renderPrompts: string[] = [];
  const reviewPrompts: string[] = [];
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, params) => {
      if (params.prompt.startsWith(REVIEW_PREFIX)) {
        const verdict = reviews[reviewPrompts.length];
        reviewPrompts.push(params.prompt);
        if (!verdict) throw new Error("Unexpected grounding review");
        return JSON.stringify(verdict);
      }
      const render = renders[renderPrompts.length];
      renderPrompts.push(params.prompt);
      if (!render) throw new Error("Unexpected recovery render");
      return JSON.stringify({
        response: render.response,
        effectReceiptIds: render.effectReceiptIds ?? [],
      });
    },
    "claim-attribution-test",
  );
  const message: Memory = {
    id: stringToUuid("claim-attribution-turn"),
    roomId: stringToUuid("claim-attribution-room"),
    entityId: stringToUuid("claim-attribution-dev"),
    agentId: runtime.agentId,
    content: { text: SENDER_REPORT },
  };
  return {
    recover: (actionResults: ActionResult[] = []) =>
      resolvePlannedReplyEgress({
        runtime,
        message,
        reply: "",
        actionResults,
      }),
    renderPrompts,
    reviewPrompts,
  };
}

const senderClaim = (quote: string): RecoveredReplyClaim => ({
  quote,
  actor: "sender",
  change: true,
  supported: true,
  evidence: SENDER_REPORT,
});
const assistantChange = (supported: boolean): RecoveredReplyClaim => ({
  quote: "i removed the 25-point cap",
  actor: "assistant",
  change: true,
  supported,
  evidence: "",
});

it("delivers a review of changes the sender reports without an assistant receipt", async () => {
  const f = fixture(
    [{ response: REVIEW_OF_SENDER_WORK }],
    [
      {
        grounded: true,
        claims: [
          senderClaim("removed the cap"),
          senderClaim("typed the nulls and wired charged: false"),
        ],
      },
    ],
  );
  await expect(f.recover()).resolves.toEqual({
    text: REVIEW_OF_SENDER_WORK,
    effectReceiptIds: [],
  });
  expect(f.renderPrompts).toHaveLength(1);
  expect(f.reviewPrompts).toHaveLength(1);
});

it.each([
  ["an assistant change without a receipt", assistantChange(false)],
  [
    "an unsupported third-party claim",
    {
      quote: "the worker team deployed it",
      actor: "third_party",
      change: true,
      supported: false,
      evidence: "",
    } satisfies RecoveredReplyClaim,
  ],
])("rejects %s", async (_label, claim) => {
  const f = fixture(
    [{ response: ASSISTANT_CLAIM }],
    [{ grounded: false, claims: [claim] }],
  );
  await expect(f.recover()).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
    message: "Recovered reply asserts an unsupported outcome",
  });
  expect(f.renderPrompts).toHaveLength(1);
  expect(f.reviewPrompts).toHaveLength(1);
});

it("delivers an assistant change bound to this turn's applied receipt", async () => {
  const observedAt = "2026-10-25T00:00:00.000Z";
  const receipt: EffectReceipt = {
    receiptId: "worker-config-1",
    operation: "worker.config.update",
    resource: { kind: "worker.config", id: "score-cap" },
    artifacts: [],
    idempotency: { key: "cap-request", replayed: false },
    observedAt,
    outcome: "applied",
    commit: { kind: "durable", id: "commit-1", committedAt: observedAt },
  };
  const f = fixture(
    [
      {
        response: "i removed the 25-point cap from the worker config.",
        effectReceiptIds: [receipt.receiptId],
      },
    ],
    [
      {
        grounded: true,
        claims: [{ ...assistantChange(true), evidence: receipt.receiptId }],
      },
    ],
  );
  await expect(
    f.recover([
      {
        success: true,
        text: "Removed the score cap.",
        effectReceipts: [receipt],
      },
    ]),
  ).resolves.toEqual({
    text: "i removed the 25-point cap from the worker config.",
    effectReceiptIds: [receipt.receiptId],
  });
  expect(f.reviewPrompts).toHaveLength(1);
});

it("fails an invented receipt selection before review", async () => {
  const f = fixture(
    [{ response: ASSISTANT_CLAIM, effectReceiptIds: ["invented-receipt"] }],
    [],
  );
  await expect(f.recover()).rejects.toMatchObject({
    code: "REPLY_GROUNDING_FAILED",
  });
  expect(f.renderPrompts).toHaveLength(1);
  expect(f.reviewPrompts).toHaveLength(0);
});
