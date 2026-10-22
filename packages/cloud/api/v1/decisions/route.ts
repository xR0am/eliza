/**
 * POST /api/v1/decisions
 *
 * Small typed judgments from Cloudflare's Clef decision model: which page
 * control fits a goal (`choice`), whether an action should ask first (`mode`),
 * and whether a spoken turn is finished (`turn`). The contract and its limits
 * live in `@elizaos/cloud-sdk/clef-decisions`. Clients call Clef only through
 * this route, never with their own Workers AI key.
 *
 * The route is off unless `CLEF_DECISIONS_ENABLED=true` and the `AI` binding is
 * present. Off or failing, it answers 503 `{ status: "unavailable" }` so
 * clients keep their own rule. A `mode` answer is a suggestion; it never lowers
 * a client's safety floor. Request text is not stored or logged.
 */

import {
  type ClefDecisionRequest,
  clefDecisionRequestProblem,
} from "@elizaos/cloud-sdk/clef-decisions";
import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  ClefDecisionError,
  resolveClefModel,
  runClefDecision,
} from "@elizaos/cloud-shared/lib/providers/cloudflare-clef";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    c.header("cache-control", "no-store");
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const request = decoded.value as ClefDecisionRequest;
    const problem =
      typeof request === "object" && request !== null
        ? clefDecisionRequestProblem(request)
        : "kind";
    if (problem) {
      return c.json({ error: "Invalid decision request", field: problem }, 400);
    }
    const binding = c.env.AI;
    if (c.env.CLEF_DECISIONS_ENABLED !== "true" || !binding) {
      return c.json({ status: "unavailable", reason: "disabled" }, 503);
    }
    try {
      return c.json(
        await runClefDecision(
          binding,
          resolveClefModel(c.env.CLEF_DECISION_MODEL),
          request,
        ),
      );
    } catch (error) {
      if (!(error instanceof ClefDecisionError)) throw error;
      // error-policy:J2 the documented unavailable answer; the code is logged, never the request.
      logger.warn("[Decisions] Clef unavailable", { code: error.code });
      return c.json({ status: "unavailable", reason: "provider_error" }, 503);
    }
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
