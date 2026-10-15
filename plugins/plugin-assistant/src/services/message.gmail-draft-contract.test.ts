import { actionToJsonSchema, promoteSubactionsToActions } from "@elizaos/core";
import { expect, it } from "vitest";
import { messageAction } from "../features/advanced-capabilities/actions/message.ts";

it("the promoted draft tool requires the source, recipients, and body its handler needs", () => {
  const actions = promoteSubactionsToActions(messageAction);
  const draft = actions.find(
    (action) => action.name === "MESSAGE_DRAFT_FOLLOWUP",
  );
  expect(draft).toBeDefined();
  expect(actionToJsonSchema(draft!).required).toEqual(
    expect.arrayContaining(["source", "to", "body"]),
  );
  // An existing-draft send may omit those fields and use its recorded draftId.
  const send = actions.find((action) => action.name === "MESSAGE_SEND_DRAFT");
  expect(send).toBeDefined();
  expect(actionToJsonSchema(send!).required).not.toEqual(
    expect.arrayContaining(["source", "to", "body"]),
  );
});
