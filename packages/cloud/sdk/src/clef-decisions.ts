/**
 * Clef decisions: small typed judgments from Cloudflare's Clef decision model
 * through Eliza Cloud, so no client holds a Workers AI key.
 *
 * Clef does not write text. It returns a probability for each answer the
 * caller allows, which makes it fast (tens of milliseconds for clef-flash)
 * and its confidence meaningful:
 *
 * - `choice`: which of a few page controls fits the person's goal, or none.
 * - `mode`: whether an action should stop and ask (`ask`) or be narrated and
 *   done (`tell`). This is a suggestion only. A deterministic safety floor
 *   always wins; use {@link combineActionMode}, which can raise but never
 *   lower the floor.
 * - `turn`: whether a spoken turn is finished, for natural turn-taking.
 *
 * Cloud answers HTTP 503 `{ status: "unavailable" }` when Clef is turned off
 * or failed. Callers must then keep their own rule (the floor, a local
 * heuristic such as {@link turnLooksComplete}) and never treat it as a yes.
 * Request text is not stored or logged by Cloud. Never send secret values
 * (passwords, codes, card or account numbers).
 */

export const CLEF_DECISIONS_PATH = "/api/v1/decisions";

/** Request limits. Larger requests are rejected, never truncated. */
export const CLEF_DECISION_LIMITS = {
  goal: 2_000,
  page: 16_000,
  candidates: 16,
  candidateId: 64,
  candidateLabel: 300,
  action: 1_000,
  context: 4_000,
  transcript: 2_000,
  recentTurns: 6,
} as const;

/** Option id Cloud adds to every choice: no candidate fits the goal. */
export const CLEF_NO_CHOICE = "none";

export type ActionMode = "tell" | "ask";

export interface ClefChoiceCandidate {
  /** Stable id from the caller's snapshot, such as a node id. */
  id: string;
  /** What the person sees: visible text, role and nearby label. */
  label: string;
}

export interface ClefTurn {
  speaker: "person" | "assistant";
  text: string;
}

export type ClefDecisionRequest =
  | {
      kind: "choice";
      /** The person's goal in plain words, for example "pay the electric bill". */
      goal: string;
      /** Visible page text for context. Leave out secret values. */
      page?: string;
      candidates: ClefChoiceCandidate[];
    }
  | {
      kind: "mode";
      /** The planned action in plain words, for example "Click Pay $84.20". */
      action: string;
      context?: string;
    }
  | {
      kind: "turn";
      /** What the person has said so far in this turn. */
      transcript: string;
      /** The last few turns, oldest first. */
      recentTurns?: ClefTurn[];
    };

export type ClefDecisionResult =
  | {
      status: "ok";
      kind: "choice";
      model: string;
      /** The best candidate id, or null when "none fits" is most likely. */
      choice: string | null;
      /** Clef's certainty in its pick, 0 to 1. */
      confidence: number;
      /** Probability per candidate id plus {@link CLEF_NO_CHOICE}; sums to 1. */
      probabilities: Record<string, number>;
    }
  | {
      status: "ok";
      kind: "mode";
      model: string;
      /** A suggestion only: combine it with the floor. */
      suggestedMode: ActionMode;
      askProbability: number;
    }
  | {
      status: "ok";
      kind: "turn";
      model: string;
      complete: boolean;
      completeProbability: number;
    };

export type ClefDecisionResponse =
  | ClefDecisionResult
  | { status: "unavailable"; reason: "disabled" | "provider_error" };

/** `ask` from Clef at this probability or above: a doubtful action asks. */
export const CLEF_ASK_THRESHOLD = 0.3;
/** A turn is complete at this probability or above. */
export const CLEF_TURN_COMPLETE_THRESHOLD = 0.5;

/**
 * The mode to use: the floor's `ask` always stands; a suggestion can only
 * raise `tell` to `ask`. A missing suggestion keeps the floor.
 */
export function combineActionMode(
  floor: ActionMode,
  suggestion: ActionMode | null | undefined,
): ActionMode {
  return floor === "ask" || suggestion === "ask" ? "ask" : "tell";
}

const TRAILING_INCOMPLETE =
  /(?:^|\s)(?:and|or|but|so|um+|uh+|er+|like|because|the|a|an|to|of|my|your|for|with|then|point)$/i;
/** "$", "1,", "84 point": a number the person has not finished saying. */
const UNFINISHED_NUMBER = /(?:\$|\d,)$/;

/**
 * Offline fallback for `turn`: a turn that trails off ("and", "um", "so"),
 * ends on a connecting word or an unfinished number is not complete.
 */
export function turnLooksComplete(transcript: string): boolean {
  const raw = transcript.trim();
  if (!raw || /(?:\.\.\.|…|-|–|—)$/u.test(raw) || UNFINISHED_NUMBER.test(raw))
    return false;
  const text = raw.replace(/[\s,;:.!?]+$/u, "");
  return text.length > 0 && !TRAILING_INCOMPLETE.test(text);
}

/** Request checks shared by Cloud and clients; returns a reason or null. */
export function clefDecisionRequestProblem(
  request: ClefDecisionRequest,
): string | null {
  const limits = CLEF_DECISION_LIMITS;
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= max;
  switch (request.kind) {
    case "choice": {
      if (!text(request.goal, limits.goal)) return "goal";
      if (request.page !== undefined && !text(request.page, limits.page))
        return "page";
      const candidates = request.candidates;
      if (
        !Array.isArray(candidates) ||
        candidates.length < 1 ||
        candidates.length > limits.candidates
      )
        return "candidates";
      const ids = new Set<string>();
      for (const candidate of candidates) {
        if (
          !text(candidate?.id, limits.candidateId) ||
          !/^[A-Za-z0-9_.-]+$/.test(candidate.id) ||
          candidate.id === CLEF_NO_CHOICE ||
          ids.has(candidate.id) ||
          !text(candidate.label, limits.candidateLabel)
        )
          return "candidates";
        ids.add(candidate.id);
      }
      return null;
    }
    case "mode":
      if (!text(request.action, limits.action)) return "action";
      if (
        request.context !== undefined &&
        !text(request.context, limits.context)
      )
        return "context";
      return null;
    case "turn": {
      if (!text(request.transcript, limits.transcript)) return "transcript";
      const turns = request.recentTurns ?? [];
      if (!Array.isArray(turns) || turns.length > limits.recentTurns)
        return "recentTurns";
      for (const turn of turns) {
        if (
          (turn?.speaker !== "person" && turn?.speaker !== "assistant") ||
          !text(turn.text, limits.transcript)
        )
          return "recentTurns";
      }
      return null;
    }
    default:
      return "kind";
  }
}

interface ClefDecisionsClientOptions {
  /** Cloud base URL, for example https://www.elizacloud.ai */
  baseUrl: string;
  /** Adds the caller's own Cloud authorization to each request. */
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

/** Calls the Cloud route. Network and server failures become `unavailable`. */
export function createClefDecisionsClient(options: ClefDecisionsClientOptions) {
  const send = options.fetch ?? fetch;
  return async (
    request: ClefDecisionRequest,
    signal?: AbortSignal,
  ): Promise<ClefDecisionResponse> => {
    const problem = clefDecisionRequestProblem(request);
    if (problem)
      throw new TypeError(`Invalid Clef decision request: ${problem}`);
    let response: Response;
    try {
      response = await send(new URL(CLEF_DECISIONS_PATH, options.baseUrl), {
        method: "POST",
        headers: {
          ...(await options.headers()),
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // error-policy:J2 an unreachable Cloud is the documented unavailable answer.
      return { status: "unavailable", reason: "provider_error" };
    }
    if (response.status === 400 || response.status === 401)
      throw new Error(`Clef decision request was refused (${response.status})`);
    const body = (await response
      .json()
      .catch(() => null)) as ClefDecisionResponse | null;
    if (!response.ok || body?.status !== "ok" || body.kind !== request.kind)
      return {
        status: "unavailable",
        reason: body?.status === "unavailable" ? body.reason : "provider_error",
      };
    return body;
  };
}
