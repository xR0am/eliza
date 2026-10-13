import { expect, test, vi } from "vitest";
import { createWebFetchAction } from "./actions/web-fetch-core";
import { createWebFetchEdgeAction } from "./edge";

const call = (
  action: ReturnType<typeof createWebFetchEdgeAction>,
  options: unknown,
) => {
  if (!action.handler) throw new Error("Canonical WEB_FETCH handler missing");
  return action.handler({} as never, {} as never, undefined, options as never);
};
const url = "https://api.example.com/value?ids=bitcoin&vs_currencies=usd";
const envelope = (source = url) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          extract_id: "e",
          results: [
            {
              url: source,
              title: "API",
              excerpts: ['{"bitcoin":{"usd":82299}}'],
              full_content: null,
            },
          ],
          errors: [],
        }),
      },
    ],
  },
});
test("canonical factory retains Node direct JSON extraction and original metadata", async () => {
  const action = createWebFetchAction(async () => ({
    ok: true,
    status: 200,
    url,
    contentType: "application/json",
    text: '{"bitcoin":{"usd":82299}}',
    truncated: false,
  }));
  const r = await call(action, { url, extract: "bitcoin.usd" });
  expect(r?.success).toBe(true);
  expect(r?.text).toBe("82299");
  expect(r?.data).toMatchObject({
    status: 200,
    content_type: "application/json",
    kind: "json",
  });
  expect(action.roleGate).toEqual({ minRole: "ADMIN" });
  expect(r?.data?.retrieved_at_basis).toBe(
    "HTTP retrieval completed; not the source publication or market update time",
  );
  const unavailable = createWebFetchAction(async () => ({
    ok: false,
    status: 503,
    url,
    contentType: "text/plain",
    text: "",
    truncated: false,
  }));
  expect((await call(unavailable, { url }))?.text).toContain(
    "failed upstream; try another endpoint or WEB_SEARCH",
  );
});
test("edge canonical action rejects private credentialed and sensitive URLs before dispatch", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    for (const url of [
      "https://127.0.0.1/a",
      "https://localhost/a",
      "https://user:pass@example.com/a",
      "https://example.com/a?token=secret",
    ]) {
      const result = await call(createWebFetchEdgeAction(), { url });
      expect(result?.success).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
test("edge returns exact single-URL provider evidence without origin status or fake JSON extraction", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(input).toBe("https://search.parallel.ai/mcp");
      const req = JSON.parse(String(init?.body));
      expect(req.params.name).toBe("web_fetch");
      expect(req.params.arguments.urls).toEqual([url]);
      expect(req.params.arguments.full_content).toBe(true);
      return Response.json(envelope());
    });
  try {
    const action = createWebFetchEdgeAction();
    const result = await call(action, { url, extract: "bitcoin.usd" });
    expect(action.roleGate).toEqual({ minRole: "GUEST" });
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      provider: "parallel",
      read_method: "provider_extract",
      kind: "provider-extract",
      extract_applied: false,
    });
    expect(result?.data?.status).toBeUndefined();
    expect(result?.data?.content_type).toBeUndefined();
    expect(JSON.parse(result?.text ?? "{}").url).toBe(url);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});
test("provider URL mismatch and empty or partial responses never become successful reads", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const mismatched = envelope("https://other.example.com/a");
    const empty = envelope();
    empty.result.content[0].text = JSON.stringify({
      results: [{ url, title: "API", excerpts: [" "], full_content: null }],
      errors: [],
    });
    const partial = envelope();
    partial.result.content[0].text = JSON.stringify({
      results: [{ url, title: "API", excerpts: ["real partial"] }],
      errors: [{ url }],
    });
    for (const response of [mismatched, empty, partial]) {
      fetch.mockResolvedValueOnce(Response.json(response));
      expect((await call(createWebFetchEdgeAction(), { url }))?.success).toBe(
        false,
      );
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    fetch.mockRestore();
  }
});
test("caller cancellation is preserved and does not dispatch", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await expect(
      call(createWebFetchEdgeAction(), { url, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
