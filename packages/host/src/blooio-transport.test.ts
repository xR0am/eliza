import { afterEach, expect, it, vi } from "vitest";
import { sendBlooioMessage } from "./blooio-transport";

const input = {
  apiKey: "synthetic-key",
  from: "+15555550100",
  to: "+15555550101",
  text: "synthetic-code",
  idempotencyKey: "stable-attempt",
};
afterEach(() => vi.unstubAllGlobals());
it("retains direct and group delivery wire shapes and requires a provider receipt", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ message_id: "provider-id" }, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await sendBlooioMessage(input)).toEqual({
    success: true,
    messageId: "provider-id",
    chatId: input.to,
  });
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.blooio.com/v4/messages");
  const init = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual({
    to: input.to,
    from: input.from,
    text: input.text,
  });
  expect(init.redirect).toBe("manual");
  expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
    input.idempotencyKey,
  );
  await sendBlooioMessage({ ...input, to: "chat_id:group/id" });
  expect(fetch.mock.calls[1]?.[0]).toBe(
    "https://api.blooio.com/v4/chats/group%2Fid/messages",
  );
  expect(
    JSON.parse(
      String((fetch.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ),
  ).toEqual({ text: input.text });
});
it("rejects redirects and transport errors without echoing delivery secrets", async () => {
  const secret = `${input.apiKey} ${input.text} ${input.to}`;
  for (const response of [
    () =>
      new Response(secret, {
        status: 302,
        headers: { location: "https://other.invalid" },
      }),
    () => new Response(secret, { status: 401 }),
    () => {
      throw new Error(secret);
    },
  ]) {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetch);
    const result = await sendBlooioMessage(input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(input.apiKey);
    expect(JSON.stringify(result)).not.toContain(input.text);
    expect(JSON.stringify(result)).not.toContain(input.to);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});
it("refuses malformed, oversized and missing acceptance receipts", async () => {
  for (const body of [
    "not-json",
    "{}",
    JSON.stringify({ id: "" }),
    JSON.stringify({ id: "provider-id", success: false }),
    JSON.stringify({ id: "provider-id", content: "x".repeat(16_384) }),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    expect((await sendBlooioMessage(input)).success).toBe(false);
  }
});
