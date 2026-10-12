/**
 * Tests that ENTITY structured-name resolution (`resolveRelationshipIdByName`
 * through the real `entityAction.handler`) never picks a list-order winner
 * for a durable interaction write: a tie inside any tier is ambiguous input
 * and must fail closed, while a unique match still resolves.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lifeops/access.js", () => ({
  hasLifeOpsAccess: async () => true,
}));

import { LifeOpsService } from "../lifeops/service.js";
import { entityAction } from "./entity.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000003" as UUID;

function relationship(
  id: string,
  name: string,
  handle: string,
  email: string | null = null,
) {
  return {
    id,
    agentId: AGENT_ID,
    name,
    primaryChannel: "imessage",
    primaryHandle: handle,
    email,
    phone: null,
    notes: "",
    tags: [],
    relationshipType: "friend",
    lastContactedAt: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
  } as Memory;
}

async function logNamedInteraction(
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
): Promise<{
  success: boolean;
  error: string | undefined;
  interactionRelationshipId: string | null;
}> {
  const result = (await entityAction.handler(
    runtime,
    makeMessage("please log this"),
    undefined,
    { parameters: { action: "log_interaction", ...params } },
  )) as {
    success: boolean;
    data?: { error?: string; interaction?: { relationshipId: string } };
  };
  return {
    success: result.success,
    error: result.data?.error,
    interactionRelationshipId: result.data?.interaction?.relationshipId ?? null,
  };
}

describe("ENTITY structured-name resolution fails closed on ambiguity", () => {
  let loggedRelationshipIds: string[];
  let directory: Array<ReturnType<typeof relationship>>;

  beforeEach(() => {
    loggedRelationshipIds = [];
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockImplementation(
      async () => directory as never,
    );
    vi.spyOn(LifeOpsService.prototype, "getRelationship").mockImplementation(
      async (id: string) =>
        (directory.find((entry) => entry.id === id) ?? null) as never,
    );
    vi.spyOn(LifeOpsService.prototype, "logInteraction").mockImplementation(
      async (input) => {
        const record = input as { relationshipId: string };
        loggedRelationshipIds.push(record.relationshipId);
        return {
          id: "int-1",
          agentId: AGENT_ID,
          createdAt: "2026-10-12T00:00:00.000Z",
          ...record,
        } as never;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a name fragment that two contacts share instead of logging the first", async () => {
    directory = [
      relationship("rel-ann-smith", "Ann Smith", "ann.smith@example.test"),
      relationship("rel-ann-jones", "Ann Jones", "ann.jones@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("rejects two contacts that share the exact same name", async () => {
    directory = [
      relationship("rel-dup-1", "Ann Smith", "ann@work.example.test"),
      relationship("rel-dup-2", "Ann Smith", "ann@home.example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), {
      name: "ann smith",
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("rejects a name fragment that matches two contacts through handle or email", async () => {
    directory = [
      relationship("rel-zed", "Zed Zeta", "anna@example.test"),
      relationship(
        "rel-yan",
        "Yan York",
        "yan@example.test",
        "anna@example.test",
      ),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "anna" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });

  it("still logs to the one contact a unique fragment identifies", async () => {
    directory = [
      relationship("rel-ann-smith", "Ann Smith", "ann.smith@example.test"),
      relationship("rel-bob", "Bob Jones", "bob@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "ann" });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-ann-smith");
    expect(loggedRelationshipIds).toEqual(["rel-ann-smith"]);
  });

  it("still prefers the unique exact name over an address-tier match", async () => {
    directory = [
      relationship("rel-bob", "Bob", "ann.smith@example.test"),
      relationship("rel-ann-smith", "Ann Smith", "ann@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), {
      name: "ann smith",
    });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-ann-smith");
    expect(loggedRelationshipIds).toEqual(["rel-ann-smith"]);
  });

  it("still resolves a name that only matches one contact's address through the token stage", async () => {
    directory = [
      relationship(
        "rel-rebecca",
        "Rebecca Stone",
        "rebecca@example.test",
        "sarah@example.test",
      ),
      relationship("rel-marc", "Marc Polo", "marc@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), { name: "sarah" });
    expect(outcome.success).toBe(true);
    expect(outcome.interactionRelationshipId).toBe("rel-rebecca");
    expect(loggedRelationshipIds).toEqual(["rel-rebecca"]);
  });

  it("rejects a non-id relationshipId value that two contacts ambiguously share", async () => {
    directory = [
      relationship("rel-ann-smith", "Ann Smith", "ann.smith@example.test"),
      relationship("rel-ann-jones", "Ann Jones", "ann.jones@example.test"),
    ];
    const outcome = await logNamedInteraction(makeRuntime(), {
      relationshipId: "ann",
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("MISSING_EDGE_ID");
    expect(loggedRelationshipIds).toEqual([]);
  });
});
