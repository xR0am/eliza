/**
 * An inbox reply leaves from the connector account the room belongs to. The
 * real POST /api/inbox/messages handler runs against a recorded send target;
 * room "work" has two connected Telegram accounts, "personal" is the default.
 */
import { expect, it } from "vitest";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

const room = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "telegram",
  channelId: "777000",
  metadata: { accountId: "work" },
};
const accounts = [
  {
    id: "personal",
    provider: "telegram",
    status: "connected",
    accessGate: "open",
    purpose: ["messaging"],
    role: "AGENT",
    metadata: { isDefault: true },
  },
  {
    id: "work",
    provider: "telegram",
    status: "connected",
    accessGate: "open",
    purpose: ["messaging"],
    role: "AGENT",
    metadata: {},
  },
];

async function reply(accountId?: string) {
  const sends: Array<{ target: { accountId?: string } }> = [];
  const manager = {
    registerProvider() {},
    evaluatePolicy: async () => ({ allowed: true }),
    getAccount: async (_provider: string, id: string) =>
      accounts.find((account) => account.id === id) ?? null,
    listAccounts: async () => accounts,
  };
  const runtime = {
    agentId: "agent",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getService: (type: string) => (type ? manager : null),
    getRoom: async () => room,
    sendHandlers: new Map([
      ["telegram\u0000personal", () => {}],
      ["telegram\u0000work", () => {}],
    ]),
    sendMessageToTarget: async (target: { accountId?: string }) => {
      sends.push({ target });
      return { delivery: "delivered", receipts: [{ providerMessageId: "1" }] };
    },
    getMemories: async () => [],
    getRoomsByIds: async () => [room],
  };
  let status = 200;
  let body: unknown;
  await handleInboxRoute(
    {} as never,
    {} as never,
    "/api/inbox/messages",
    "POST",
    {
      runtime: runtime as never,
      callerAuthorization: { ok: true, role: "OWNER" },
    } as never,
    {
      readJsonBody: async () => ({
        ...(accountId ? { accountId } : {}),
        roomId: room.id,
        source: "telegram",
        text: "reply to the work chat",
      }),
      json: (_res: unknown, payload: unknown, code = 200) => {
        body = payload;
        status = code;
      },
      error: (_res: unknown, message: string, code = 500) => {
        body = { error: message };
        status = code;
      },
    } as never,
  );
  return { status, body, sends };
}

it("replies from the room's account when no account is selected", async () => {
  const { status, sends } = await reply();
  expect(status).toBe(200);
  expect(sends.map((send) => send.target.accountId)).toEqual(["work"]);
});

it("replies from the room's account when it is selected", async () => {
  const { status, sends } = await reply("work");
  expect(status).toBe(200);
  expect(sends.map((send) => send.target.accountId)).toEqual(["work"]);
});

it("refuses to reply from a different account than the room's", async () => {
  const { status, body, sends } = await reply("personal");
  expect(status).toBe(409);
  expect(body).toMatchObject({
    code: "INBOX_CONNECTOR_ACCOUNT_ROOM_MISMATCH",
    context: { accountId: "personal", roomAccountId: "work" },
  });
  expect(sends).toEqual([]);
});
