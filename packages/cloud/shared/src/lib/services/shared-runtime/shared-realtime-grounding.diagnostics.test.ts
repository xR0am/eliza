import { describe, expect, test } from "bun:test";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import {
  finalizeSharedRealtimeReply,
  hasSharedRealtimeIntent,
  resolveSharedPublicSearchIntent,
  resolveSharedRealtimeRequirement,
  type SharedRealtimeBindingDiagnostic,
} from "./shared-realtime-grounding";

const observedAt = Date.UTC(2026, 7, 22, 7, 0, 0);
const grounding: SharedRuntimePublicGrounding = {
  kind: "web_search",
  query: "what is btc price rn",
  provider: "parallel",
  observedAt,
  sourceUrls: ["https://coin.example/bitcoin"],
  sources: [
    {
      url: "https://coin.example/bitcoin",
      text: JSON.stringify({
        url: "https://coin.example/bitcoin",
        title: "Bitcoin price",
        excerpt: "Bitcoin is 77,357.93 USD at 07:00 UTC.",
      }),
    },
  ],
  text: JSON.stringify({
    results: [
      {
        url: "https://coin.example/bitcoin",
        title: "Bitcoin price",
        excerpt: "Bitcoin is 77,357.93 USD at 07:00 UTC.",
      },
    ],
  }),
  truncated: false,
};

describe("Shared realtime binding refusal diagnostics", () => {
  test("missing markers expose only bounded diagnostic fields, never the draft", () => {
    const diagnostics: SharedRealtimeBindingDiagnostic[] = [];
    const draft = "PRIVATE_DRAFT_SENTINEL 12345";
    const reply = finalizeSharedRealtimeReply(draft, grounding, (value) => diagnostics.push(value));
    expect(reply).toContain("couldn’t safely bind");
    expect(diagnostics).toEqual([
      {
        reason: "marker_missing",
        markerCount: 0,
        knownSourceMarkerCount: 0,
        failedPredicateMask: 0,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(draft);
    expect(JSON.stringify(diagnostics)).not.toContain(grounding.sources?.[0].text ?? "");
  });

  test("a marker outside the receipt has a source reason without logging its URL", () => {
    const diagnostics: SharedRealtimeBindingDiagnostic[] = [];
    const otherUrl = "https://different.example/private-draft-sentinel";
    finalizeSharedRealtimeReply(
      `Bitcoin is 77,357.93 USD. [[SOURCE_URL:${otherUrl}]]`,
      grounding,
      (value) => diagnostics.push(value),
    );
    expect(diagnostics[0]).toEqual({
      reason: "source_not_in_receipt",
      markerCount: 1,
      knownSourceMarkerCount: 0,
      failedPredicateMask: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(otherUrl);
  });

  test("unit mismatch records the predicate while preserving the refusal", () => {
    const diagnostics: SharedRealtimeBindingDiagnostic[] = [];
    const draft = "Bitcoin is 77,357.93 EUR. [[SOURCE_URL:https://coin.example/bitcoin]]";
    const reply = finalizeSharedRealtimeReply(draft, grounding, (value) => diagnostics.push(value));
    expect(reply).toBe(finalizeSharedRealtimeReply(draft, grounding));
    expect(diagnostics[0]?.reason).toBe("claim_not_supported");
    expect((diagnostics[0]?.failedPredicateMask ?? 0) & 4).toBe(4);
  });

  test("an observer failure cannot change the refusal or escape the boundary", () => {
    const draft = "A draft without a source marker";
    const expected = finalizeSharedRealtimeReply(draft, grounding);
    let observations = 0;
    expect(
      finalizeSharedRealtimeReply(draft, grounding, () => {
        observations += 1;
        throw new Error("PRIVATE_OBSERVER_ERROR_SENTINEL");
      }),
    ).toBe(expected);
    expect(observations).toBe(1);
  });
});

describe("search authority after a conversation topic changes", () => {
  const history = [
    {
      role: "user" as const,
      content: "What is the current bitcoin price? Reply briefly.",
    },
    {
      role: "assistant" as const,
      content: "A public price result.",
      grounding: {
        ...grounding,
        query: "current public bitcoin price",
        observedAt: Date.now(),
      },
    },
  ];

  test("ordinary questions do not search or replace the answer with a source refusal", () => {
    for (const message of [
      "What is 17 plus 26? Reply briefly.",
      "Wait so I just wait that’s it? And you handle the rest? Do you have all data you need from me? And also how does the network and all this and you work I’m curious",
      "Why do you always reply? Should you react with an emoji instead?",
      "Why do you keep trying to web search and when you do it breaks?",
      "How does it work?",
      "Thanks, that helps!",
    ]) {
      expect(hasSharedRealtimeIntent(message, history)).toBe(false);
      expect(resolveSharedRealtimeRequirement(message, history)).toBeUndefined();
      expect(resolveSharedPublicSearchIntent(message, history)).toBeUndefined();
    }
  });

  test("an explicit evidence follow-up and a fresh public question still search", () => {
    for (const message of ["Check that price again", "Is that correct?", "Show me the sources"]) {
      expect(hasSharedRealtimeIntent(message, history)).toBe(true);
      expect(resolveSharedRealtimeRequirement(message, history)?.domain).toBe("markets");
    }
    expect(
      resolveSharedPublicSearchIntent("What is the current bitcoin price?", history)?.kind,
    ).toBe("prefetched");
  });
});
