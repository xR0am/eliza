/**
 * Native in-app email sign-in (Alpha Phone): `delivery: "code"`.
 *
 * Drives the real identity router and PGlite store with the in-memory mock
 * email provider. A native caller asks for a code-only email, which must carry
 * no link at all (a link would sign in a browser and consume the challenge),
 * and redeems the code through /auth/email/code/verify. No real mailbox or
 * account is used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { MockEmailInbox as MockEmailInboxType } from "../auth/email-provider";
import type { createPGLiteDb } from "../db/pglite";

const TENANT_ID = "elizacloud";
const STEWARD_ORIGIN = "https://api.eliza.app/steward";
const ROUTER_ORIGIN = "https://login.internal";

let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
let inbox: typeof MockEmailInboxType;
const previous = new Map<string, string | undefined>();

beforeAll(async () => {
  const environment: Record<string, string> = {
    NODE_ENV: "test",
    EMAIL_PROVIDER: "mock",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    APP_URL: STEWARD_ORIGIN,
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  for (const key of ["RESEND_API_KEY", "EMAIL_MAGIC_LINK_BASE_URL"]) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { tenants, tenantConfigs } = await import("../db/schema");
  await database.db.insert(tenants).values({
    id: TENANT_ID,
    name: "Synthetic Eliza Cloud",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db.insert(tenantConfigs).values({
    tenantId: TENANT_ID,
    joinMode: "open",
  });
  ({ MockEmailInbox: inbox } = await import("../auth/email-provider"));
  const { createLoginApp } = await import("../app");
  app = createLoginApp();
}, 60_000);

afterAll(async () => {
  if (database) await database.client.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A native request: no Origin, no Referer, no cookies. Distinct client IPs
 * keep the per-IP limiter out of the way between tests. */
function nativePost(path: string, body: object, ip: string) {
  return app.request(`${ROUTER_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify(body),
  });
}

function sixDigitCode(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) throw new Error("no six-digit code in the email");
  return match[1];
}

describe("native email code sign-in (Alpha Phone)", () => {
  test('delivery "code" sends a code-only email that contains no link and signs in through code verify', async () => {
    const email = "native-code@example.test";
    const sent = await nativePost(
      "/auth/email/send",
      { email, tenantId: TENANT_ID, delivery: "code" },
      "198.51.100.10",
    );
    expect(sent.status).toBe(200);
    const message = inbox.last(email);
    expect(message).toBeDefined();
    if (!message) return;
    for (const body of [message.text, message.html ?? ""]) {
      expect(body).not.toMatch(/https?:\/\//i);
      expect(body).not.toContain("/callback/email");
      expect(body).not.toMatch(/<a\s/i);
    }
    expect(message.magicLink).toBeUndefined();
    expect(message.token).toBeUndefined();

    const verify = await nativePost(
      "/auth/email/code/verify",
      { email, code: sixDigitCode(message.text), tenantId: TENANT_ID },
      "198.51.100.10",
    );
    expect(verify.status).toBe(200);
    const payload = (await verify.json()) as Record<string, unknown>;
    expect(payload.ok).not.toBe(false);
    expect(typeof payload.token).toBe("string");
  });

  test("the default delivery still sends a magic link with the code", async () => {
    const email = "browser-link@example.test";
    const sent = await nativePost(
      "/auth/email/send",
      { email, tenantId: TENANT_ID },
      "198.51.100.11",
    );
    expect(sent.status).toBe(200);
    const message = inbox.last(email);
    expect(message?.magicLink).toContain("/callback/email");
    expect(message?.text).toMatch(/\b\d{6}\b/);
  });

  test("an unknown delivery value is refused before any email is sent", async () => {
    const email = "bad-delivery@example.test";
    for (const delivery of ["link", "sms", 1, null]) {
      const response = await nativePost(
        "/auth/email/send",
        { email, tenantId: TENANT_ID, delivery },
        "198.51.100.12",
      );
      expect({ delivery, status: response.status }).toEqual({
        delivery,
        status: 400,
      });
    }
    expect(inbox.last(email)).toBeUndefined();
  });
});
