/**
 * Undo through the form evaluator on a real AgentRuntime and PGlite adapter.
 * Undo puts the previous answer back as it was: an answer that failed
 * validation stays invalid and an unconfirmed answer stays uncertain, so the
 * agent asks again or confirms it instead of submitting it. No live model is
 * used; the evaluator processors receive the parsed model output directly.
 */
import assert from "node:assert/strict";
import {
  ChannelType,
  type Memory,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formEvaluator } from "./evaluators/extractor";
import formPlugin from "./index";
import { formContextProvider } from "./providers/context";
import { FormService } from "./service";
import type { ExtractionResult, FormIntent } from "./types";

function requireDefined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Form undo harness requires ${what}`);
  }
  return value;
}

const prepare = requireDefined(formEvaluator.prepare, "the evaluator prepare");
const intentProcessor = requireDefined(
  formEvaluator.processors?.find((p) => p.name === "formIntent"),
  "the formIntent processor",
);
const extractionsProcessor = requireDefined(
  formEvaluator.processors?.find((p) => p.name === "formExtractions"),
  "the formExtractions processor",
);

const state: State = { values: {}, data: {}, text: "" };

describe("form undo through the evaluator", () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;
  let service: FormService;
  let entityId: UUID;

  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "FormUndo",
      plugins: [formPlugin],
    });
    const runtime = harness.runtime;
    await runtime.getServiceLoadPromise(FormService.serviceType);
    const formService = runtime.getService<FormService>(
      FormService.serviceType,
    );
    assert(formService);
    service = formService;
    entityId = runtime.agentId;
    await runtime.createWorld({
      id: runtime.agentId,
      name: "Form undo",
      agentId: runtime.agentId,
    });
    service.registerForm({
      id: "contact",
      name: "Contact",
      controls: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 60_000);

  async function openForm(name: string): Promise<UUID> {
    const roomId = stringToUuid(`form-undo-room-${name}`);
    await harness.runtime.ensureRoomExists({
      id: roomId,
      worldId: harness.runtime.agentId,
      name,
      source: "test",
      type: ChannelType.DM,
    });
    await service.startSession("contact", entityId, roomId);
    return roomId;
  }

  function messageIn(roomId: UUID, text: string): Memory {
    return {
      id: stringToUuid(`${roomId}:${text}`),
      entityId,
      agentId: harness.runtime.agentId,
      roomId,
      content: { text },
    };
  }

  /** One user turn: the evaluator's processors run on the parsed model output. */
  async function turn(
    roomId: UUID,
    text: string,
    formIntent: FormIntent,
    formExtractions: ExtractionResult[] = [],
  ): Promise<void> {
    const context = {
      runtime: harness.runtime,
      message: messageIn(roomId, text),
      state,
      options: {},
    };
    const prepared = await prepare(context);
    const output = { formIntent, formExtractions };
    for (const processor of [intentProcessor, extractionsProcessor]) {
      await processor.process({
        ...context,
        prepared,
        output,
        evaluatorName: formEvaluator.name,
      });
    }
  }

  /** The form_context_json block the provider hands to the model. */
  async function modelContext(roomId: UUID) {
    const provider = await formContextProvider.get(
      harness.runtime,
      messageIn(roomId, "context"),
      state,
    );
    return JSON.parse(String(provider.text).split("form_context_json:\n")[1]);
  }

  it("keeps an invalid previous answer invalid so the agent asks for it again", async () => {
    const roomId = await openForm("invalid");
    await turn(roomId, "Ann, ann@example", "fill_form", [
      { field: "name", value: "Ann", confidence: 0.95 },
      { field: "email", value: "ann@example", confidence: 0.95 },
    ]);
    await turn(roomId, "Sorry, ann@example.com", "fill_form", [
      {
        field: "email",
        value: "ann@example.com",
        confidence: 0.95,
        isCorrection: true,
      },
    ]);
    expect((await service.getActiveSession(entityId, roomId))?.status).toBe(
      "ready",
    );

    await turn(roomId, "Undo that", "undo");

    const session = await service.getActiveSession(entityId, roomId);
    assert(session);
    expect(session.fields.email).toMatchObject({
      status: "invalid",
      value: "ann@example",
      error: "Email must be a valid email address",
    });
    const context = await modelContext(roomId);
    expect(context.required_missing.map((f: { key: string }) => f.key)).toEqual(
      ["email"],
    );
    expect(context.instruction).toMatch(/complete required fields/);
    await expect(turn(roomId, "Submit", "submit")).rejects.toThrow(
      "Not all required fields are filled",
    );
  }, 60_000);

  it("keeps an unconfirmed previous answer uncertain so it is not submitted", async () => {
    const roomId = await openForm("uncertain");
    await turn(roomId, "Bob I think, bob@example.com", "fill_form", [
      { field: "name", value: "Bob", confidence: 0.5 },
      { field: "email", value: "bob@example.com", confidence: 0.95 },
    ]);
    await turn(roomId, "Actually it's Rob", "fill_form", [
      { field: "name", value: "Rob", confidence: 0.95, isCorrection: true },
    ]);

    await turn(roomId, "Undo", "undo");

    const session = await service.getActiveSession(entityId, roomId);
    assert(session);
    expect(session.fields.name).toMatchObject({
      status: "uncertain",
      value: "Bob",
      confidence: 0.5,
    });
    const context = await modelContext(roomId);
    expect(context.instruction).toBe('Ask user to confirm "Name" = "Bob".');
    await expect(turn(roomId, "Submit", "submit")).rejects.toThrow(
      "Not all required fields are filled",
    );
    const submissions = await service.getSubmissions(entityId, "contact");
    expect(submissions.filter((s) => s.sessionId === session.id)).toEqual([]);
  }, 60_000);

  it("restores a valid previous answer as filled and submits it", async () => {
    const roomId = await openForm("valid");
    await turn(roomId, "Ann, ann@example.com", "fill_form", [
      { field: "name", value: "Ann", confidence: 0.95 },
      { field: "email", value: "ann@example.com", confidence: 0.95 },
    ]);
    await turn(roomId, "Make it Anne", "fill_form", [
      { field: "name", value: "Anne", confidence: 0.95, isCorrection: true },
    ]);

    await turn(roomId, "Undo", "undo");

    const session = await service.getActiveSession(entityId, roomId);
    assert(session);
    expect(session.fields.name).toMatchObject({
      status: "filled",
      value: "Ann",
      confidence: 0.95,
    });
    expect(session.status).toBe("ready");
    await turn(roomId, "Submit", "submit");
    const submissions = await service.getSubmissions(entityId, "contact");
    expect(
      submissions
        .filter((s) => s.sessionId === session.id)
        .map((s) => s.values),
    ).toEqual([{ name: "Ann", email: "ann@example.com" }]);
  }, 60_000);
});
