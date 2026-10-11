import { describe, expect, it } from "vitest";
import { resolveImplicitReferent } from "./index.js";

const NOW = "2026-10-11T00:00:00.000Z";

describe("resolveImplicitReferent non-Latin lexical matching", () => {
  it("matches a Korean ask against a Korean candidate like the English control", () => {
    const result = resolveImplicitReferent({
      ask: "회의실 예약 일정 확인해줘",
      nowIso: NOW,
      candidates: [
        {
          id: "ko-trip",
          source: "recent_thread",
          label: "회의실 예약 일정",
          summary: "회의실 예약 일정 확인 건",
          confirmation: "the meeting-room booking schedule",
        },
        {
          id: "en-other",
          source: "recent_thread",
          label: "Quarterly budget review",
          summary: "Quarterly budget review thread",
          confirmation: "the quarterly budget review",
        },
      ],
    });
    const trip = result.ranked.find((r) => r.candidate.id === "ko-trip");
    expect(trip).toBeDefined();
    expect(trip?.score).toBeGreaterThan(0);
    expect(trip?.evidence.some((e) => e.startsWith("matched"))).toBe(true);
    expect(result.ranked[0]?.candidate.id).toBe("ko-trip");
  });

  it("keeps English matching and cross-language isolation unchanged", () => {
    const result = resolveImplicitReferent({
      ask: "what happened with the seoul trip hotel booking",
      nowIso: NOW,
      candidates: [
        {
          id: "en-trip",
          source: "recent_thread",
          label: "Seoul trip hotel booking",
          summary: "Seoul trip hotel booking status",
          confirmation: "the Seoul trip hotel booking",
        },
        {
          id: "ko-other",
          source: "recent_thread",
          label: "회의실 예약 일정",
          summary: "회의실 예약 일정 확인 건",
          confirmation: "the meeting-room booking schedule",
        },
      ],
    });
    const trip = result.ranked.find((r) => r.candidate.id === "en-trip");
    const other = result.ranked.find((r) => r.candidate.id === "ko-other");
    expect(trip?.evidence.filter((e) => e.startsWith("matched"))).toHaveLength(
      4,
    );
    expect(other?.score).toBe(0);
  });
});
