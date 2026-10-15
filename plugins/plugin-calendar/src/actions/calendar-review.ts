/** Exact owner choice; never plans a new event or accepts an unbound approval. */
import { type Action, OWNER_EXCLUSIVE_DISCLOSURE_GATE } from "@elizaos/core";
import { resolveCalendarApproval } from "../mutations/resolve.js";
export const calendarReviewAction: Action = {
  name: "CALENDAR_REVIEW",
  description:
    "Approve or reject an existing Calendar change using its exact requestId. Never creates a new proposal. Requires the owner and the current persisted review message.",
  similes: ["APPROVE_CALENDAR_CHANGE", "REJECT_CALENDAR_CHANGE"],
  tags: [
    "domain:calendar",
    "capability:execute",
    "surface:internal",
    "risk:irreversible",
  ],
  roleGate: { minRole: "OWNER" },
  disclosureGate: OWNER_EXCLUSIVE_DISCLOSURE_GATE,
  parameters: [
    {
      name: "requestId",
      description: "Exact Calendar approval request id shown in the review",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "decision",
      description: "approve or reject",
      required: true,
      schema: { type: "string", enum: ["approve", "reject"] },
    },
  ],
  validate: async () => true,
  handler: async (runtime, message, _state, options, callback) => {
    const raw = options?.parameters;
    const input =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    if (
      typeof input.requestId !== "string" ||
      !input.requestId.trim() ||
      !["approve", "reject"].includes(String(input.decision))
    )
      return {
        success: false,
        text: "Use the exact Calendar review and choose Approve or Deny.",
      };
    const result = await resolveCalendarApproval(runtime, message, {
      requestId: input.requestId,
      decision: input.decision as "approve" | "reject",
    });
    const text =
      result.kind === "succeeded"
        ? "Calendar change completed."
        : result.kind === "rejected"
          ? "Calendar change declined. Nothing was changed."
          : "Calendar change is not confirmed. Review its saved status before trying again.";
    await callback?.({ text });
    return {
      success: result.kind === "succeeded" || result.kind === "rejected",
      text,
      data: {
        kind: result.kind,
        requestId: input.requestId,
        ...(result.kind === "succeeded"
          ? {
              receipt: result.receipt,
              attemptId: result.attempt.id,
              duplicateSuppressed: result.duplicateSuppressed,
            }
          : {}),
      },
    };
  },
};
