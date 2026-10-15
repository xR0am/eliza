/**
 * The default rate-limit key must not come from a header the request does not
 * authenticate with. A signed-in request that adds a new random X-API-Key per
 * call used to get a fresh window each time; it is now bucketed on its session.
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

function limitedApp() {
  return new Hono<AppEnv>()
    .use("*", rateLimit({ windowMs: 60_000, maxRequests: 2 }, { bindingName: "TEST_LIMIT" }))
    .post("*", (c) => c.json({ ok: true }));
}

test("a session request that varies X-API-Key stays in one window", async () => {
  const binding = bindingAllowingTwo();
  const app = limitedApp();
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await app.request(
      "/api/signup-code/redeem",
      {
        method: "POST",
        headers: {
          cookie: `${LEGACY_STEWARD_COOKIES.token}=session-token-of-one-user`,
          "X-API-Key": `random-${crypto.randomUUID()}`,
        },
      },
      { TEST_LIMIT: binding, NODE_ENV: "test" },
    );
    statuses.push(response.status);
  }
  expect(statuses).toEqual([200, 200, 429]);
});

test("requests that carry only an API key keep a window per key", async () => {
  const binding = bindingAllowingTwo();
  const app = limitedApp();
  for (const key of ["eliza_key_a", "eliza_key_b"]) {
    const response = await app.request(
      "/api/v1/anything",
      { method: "POST", headers: { "X-API-Key": key } },
      { TEST_LIMIT: binding, NODE_ENV: "test" },
    );
    expect(response.status).toBe(200);
  }
  expect(binding.keys.size).toBe(2);
});
