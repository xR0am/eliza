/**
 * `POST /api/conversations/:id/messages/:messageId/heard` keeps only the part
 * of an assistant reply that the user heard before they interrupted playback.
 * Real PGlite runtime: the stored memory, the history page and the model's
 * recent-message context must all carry the heard text afterwards.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  DatabaseMigrationService,
  type DrizzleDatabase,
  PGliteClientManager,
  PgliteDatabaseAdapter,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { expect, it } from "vitest";
import { recentMessagesProvider } from "../../../plugins/plugin-assistant/src/features/basic-capabilities/providers/recentMessages.ts";
import type { ConversationRouteState } from "../src/api/conversation-routes.ts";
import { handleConversationRoutes } from "../src/api/conversation-routes.ts";

async function call(
  state: ConversationRouteState,
  method: string,
  url: string,
  body: Record<string, unknown> | null = null,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const server = http.createServer((req, res) => {
    const json = (
      response: http.ServerResponse,
      value: unknown,
      status = 200,
    ) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    void handleConversationRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: new URL(req.url ?? "/", "http://localhost").pathname,
      state,
      readJsonBody: async (request) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        return chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : null;
      },
      json,
      error: (response, message, status = 500) =>
        json(response, { error: message }, status),
    })
      .then((handled) => {
        if (!handled) json(res, { error: "Not found" }, 404);
      })
      .catch((error: unknown) => {
        json(res, { error: String(error) }, 500);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP address");
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      method,
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    return {
      status: response.status,
      payload: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function createFixture() {
  const agentId = "00000000-0000-0000-0000-0000000a0e42" as UUID;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heard-"));
  const cm = new PGliteClientManager({ dataDir });
  await cm.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, cm);
  await adapter.init();
  const character = createCharacter({ name: "Heard Agent", bio: [] });
  const runtime = new AgentRuntime({
    character: { ...character, id: undefined },
    agentId,
    plugins: [sqlPlugin],
  });
  runtime.registerDatabaseAdapter(adapter);
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(
    adapter.getDatabase() as DrizzleDatabase,
  );
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  await adapter.createAgent({
    ...character,
    id: agentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const adminId = stringToUuid("heard-admin");
  await runtime.createEntity({
    id: agentId,
    agentId,
    names: ["Agent"],
  } as never);
  await runtime.createEntity({
    id: adminId,
    agentId,
    names: ["User"],
  } as never);
  const state = {
    runtime,
    config: { user: { name: "User" } },
    agentName: "Heard Agent",
    adminEntityId: adminId,
    chatUserId: adminId,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
    tradePermissionMode: "connectors-only",
  } as unknown as ConversationRouteState;
  return { agentId, adapter, adminId, dataDir, runtime, state };
}

const FULL_REPLY =
  "Your flight leaves at nine. The gate is B12, and boarding closes twenty minutes before departure.";

it("keeps only the heard part of an interrupted assistant reply", async () => {
  const { agentId, adapter, adminId, dataDir, runtime, state } =
    await createFixture();
  try {
    const created = await call(state, "POST", "/api/conversations", {
      title: "voice chat",
    });
    const conversation = (
      created.payload as { conversation: { id: string; roomId: UUID } }
    ).conversation;
    const userId = await runtime.createMemory(
      {
        entityId: adminId,
        agentId,
        roomId: conversation.roomId,
        content: { text: "When does my flight leave?" },
        createdAt: Date.now() - 2_000,
      } as Memory,
      "messages",
    );
    const assistantId = await runtime.createMemory(
      {
        entityId: agentId,
        agentId,
        roomId: conversation.roomId,
        content: { text: FULL_REPLY, inReplyTo: userId },
        createdAt: Date.now() - 1_000,
      } as Memory,
      "messages",
    );
    const heardUrl = `/api/conversations/${conversation.id}/messages/${assistantId}/heard`;

    // Text the user did not hear is refused; the stored reply is unchanged.
    const extended = await call(state, "POST", heardUrl, {
      heardText: `${FULL_REPLY} And one more thing.`,
    });
    expect(extended.status).toBe(409);
    const notPrefix = await call(state, "POST", heardUrl, {
      heardText: "Your train leaves",
    });
    expect(notPrefix.status).toBe(409);
    expect((await call(state, "POST", heardUrl, { text: "x" })).status).toBe(
      400,
    );
    expect(
      (
        await call(
          state,
          "POST",
          `/api/conversations/${conversation.id}/messages/${userId}/heard`,
          { heardText: "When" },
        )
      ).status,
    ).toBe(400);

    // Speech output collapses whitespace; the prefix check does the same.
    const heard = "Your flight leaves at nine.  The gate is";
    const first = await call(state, "POST", heardUrl, { heardText: heard });
    expect(first.status).toBe(200);
    expect(first.payload).toEqual({
      ok: true,
      messageId: assistantId,
      text: heard,
      truncated: true,
      changed: true,
    });

    // Idempotent: the same request does not write again.
    const repeat = await call(state, "POST", heardUrl, { heardText: heard });
    expect(repeat.payload).toEqual({
      ok: true,
      messageId: assistantId,
      text: heard,
      truncated: true,
      changed: false,
    });
    // The trimmed reply cannot grow back to the original.
    expect(
      (await call(state, "POST", heardUrl, { heardText: FULL_REPLY })).status,
    ).toBe(409);

    const [stored] = await runtime.getMemoriesByIds([assistantId], "messages");
    expect(stored?.content).toMatchObject({
      text: heard,
      interrupted: true,
      heardTruncated: true,
      inReplyTo: userId,
    });

    const history = await call(
      state,
      "GET",
      `/api/conversations/${conversation.id}/messages`,
    );
    const messages = history.payload.messages as Array<{
      id: string;
      text: string;
      interrupted?: boolean;
    }>;
    expect(messages.find((m) => m.id === assistantId)).toMatchObject({
      text: heard,
      interrupted: true,
    });

    const [userMemory] = await runtime.getMemoriesByIds([userId], "messages");
    const context = await recentMessagesProvider.get(
      runtime,
      userMemory as Memory,
      { values: {}, data: {}, text: "" },
    );
    expect(context.text).toContain("The gate is");
    expect(context.text).not.toContain("boarding closes");
  } finally {
    await adapter.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 120_000);

it("hides messages of another conversation", async () => {
  const { agentId, adapter, dataDir, runtime, state } = await createFixture();
  try {
    const a = (await call(state, "POST", "/api/conversations", { title: "a" }))
      .payload as { conversation: { id: string; roomId: UUID } };
    const b = (await call(state, "POST", "/api/conversations", { title: "b" }))
      .payload as { conversation: { id: string; roomId: UUID } };
    const assistantId = await runtime.createMemory(
      {
        entityId: agentId,
        agentId,
        roomId: a.conversation.roomId,
        content: { text: FULL_REPLY },
      } as Memory,
      "messages",
    );
    const crossRoom = await call(
      state,
      "POST",
      `/api/conversations/${b.conversation.id}/messages/${assistantId}/heard`,
      { heardText: "Your flight" },
    );
    expect(crossRoom.status).toBe(404);
    const [stored] = await runtime.getMemoriesByIds([assistantId], "messages");
    expect(stored?.content.text).toBe(FULL_REPLY);
  } finally {
    await adapter.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 120_000);
