/**
 * The default rate-limit key must not come from a credential nobody has
 * checked. A caller that sends a new random X-API-Key or Bearer token per
 * request used to get a fresh window each time; an unvalidated credential now
 * falls back to the caller's IP, and only a validated key keeps its own window.
 */
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../../types/cloud-worker-env";
import { LEGACY_STEWARD_COOKIES } from "../auth/steward-cookies";
import { rateLimit } from "./rate-limit-hono-cloudflare";

/** A Cloudflare rate-limit binding that allows two requests per key. */
function bindingAllowingTwo() {
  const counts = new Map<string, number>();
  return {
    keys: counts,
    limit: async ({ key }: { key: string }) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: (counts.get(key) ?? 0) <= 2 };
    },
  };
}

function limitedApp(validatedKeyId?: string) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      // Stands for the auth middleware having validated the API key.
      if (validatedKeyId) c.set("apiKeyId", validatedKeyId);
      await next();
    })
    .use("*", rateLimit({ windowMs: 60_000, maxRequests: 2 }, { bindingName: "TEST_LIMIT" }))
    .post("*", (c) => c.json({ ok: true }));
}

async function statusesFor(headers: () => Record<string, string>): Promise<number[]> {
  const binding = bindingAllowingTwo();
  const app = limitedApp();
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await app.request(
      "/api/signup-code/redeem",
      { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7", ...headers() } },
      { TEST_LIMIT: binding, NODE_ENV: "test" },
    );
    statuses.push(response.status);
  }
  return statuses;
}

test("a session request that varies X-API-Key stays in one window", async () => {
  expect(
    await statusesFor(() => ({
      cookie: `${LEGACY_STEWARD_COOKIES.token}=session-token-of-one-user`,
      "X-API-Key": `random-${crypto.randomUUID()}`,
    })),
  ).toEqual([200, 200, 429]);
});

test("a caller that varies an unchecked Bearer token stays in one window", async () => {
  expect(
    await statusesFor(() => ({ authorization: `Bearer random-${crypto.randomUUID()}` })),
  ).toEqual([200, 200, 429]);
  expect(
    await statusesFor(() => ({ authorization: `Bearer eliza_random_${crypto.randomUUID()}` })),
  ).toEqual([200, 200, 429]);
});

test("validated API keys keep a window per key", async () => {
  const binding = bindingAllowingTwo();
  for (const key of ["eliza_key_a", "eliza_key_b"]) {
    const response = await limitedApp(`id-${key}`).request(
      "/api/v1/anything",
      { method: "POST", headers: { "X-API-Key": key, "cf-connecting-ip": "203.0.113.7" } },
      { TEST_LIMIT: binding, NODE_ENV: "test" },
    );
    expect(response.status).toBe(200);
  }
  expect(binding.keys.size).toBe(2);
});
