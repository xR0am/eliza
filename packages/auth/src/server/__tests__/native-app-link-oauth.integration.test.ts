/**
 * Native in-app sign-in through a verified https App Link (Alpha Phone).
 *
 * Drives the real identity router and PGlite store end to end: a native caller
 * with no browser Origin starts Google authorization against the App Link
 * redirect, the (synthetic) provider round trip lands on Steward's callback,
 * Steward hands a one-time code back to the App Link, and the device redeems
 * it with its PKCE verifier. Provider HTTP calls are answered in-process by a
 * synthetic Google/Discord; no real account or credential is used.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/pglite";

const TENANT_ID = "elizacloud";
const APP_LINK = "https://eliza.app/alphaphone/auth/callback";
// Public base the Cloud API proxies to Steward; the router itself is unprefixed.
const STEWARD_ORIGIN = "https://api.eliza.app/steward";
const ROUTER_ORIGIN = "https://login.internal";

type Identity = Record<string, unknown>;
const identities = new Map<string, Identity>();
const realFetch = globalThis.fetch;
const PROVIDER_TOKEN_URLS = new Set([
  "https://oauth2.googleapis.com/token",
  "https://discord.com/api/oauth2/token",
]);
const PROVIDER_USERINFO_URLS = new Set([
  "https://www.googleapis.com/oauth2/v3/userinfo",
  "https://discord.com/api/users/@me",
]);
let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
const previous = new Map<string, string | undefined>();

const base64url = (bytes: Buffer) => bytes.toString("base64url");
const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

beforeAll(async () => {
  // Synthetic provider: the token endpoint hands out an access token naming
  // the identity queued under the authorization code; userinfo returns it.
  // Only the provider endpoints are intercepted.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (PROVIDER_TOKEN_URLS.has(request.url)) {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") ?? "";
      if (!identities.has(code))
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: `at-${code}`,
        token_type: "Bearer",
      });
    }
    if (PROVIDER_USERINFO_URLS.has(request.url)) {
      const token = (request.headers.get("authorization") ?? "").replace(
        /^Bearer at-/,
        "",
      );
      const identity = identities.get(token);
      return identity
        ? Response.json(identity)
        : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const environment: Record<string, string> = {
    NODE_ENV: "test",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    APP_URL: STEWARD_ORIGIN,
    GOOGLE_CLIENT_ID: "synthetic-google-web-client",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
    DISCORD_CLIENT_ID: "synthetic-discord-client",
    DISCORD_CLIENT_SECRET: "synthetic-discord-secret",
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  for (const key of [
    "GOOGLE_AUTHORIZATION_URL",
    "GOOGLE_TOKEN_URL",
    "GOOGLE_USERINFO_URL",
    "DISCORD_AUTHORIZATION_URL",
    "DISCORD_TOKEN_URL",
    "DISCORD_USERINFO_URL",
    "STEWARD_OAUTH_ALLOWED_REDIRECTS",
    "STEWARD_OAUTH_REDIRECT_ALLOWLIST",
  ]) {
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
    allowedRedirectUrls: [APP_LINK],
    // Eliza Cloud accepts new members on first sign-in.
    joinMode: "open",
  });
  const { createLoginApp } = await import("../app");
  app = createLoginApp();
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (database) await database.client.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A native request: no Origin, no Referer, no cookies. */
function nativeGet(path: string) {
  return app.request(`${ROUTER_ORIGIN}${path}`, { method: "GET" });
}
function nativePost(path: string, body: object) {
  return app.request(`${ROUTER_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authorizeQuery(overrides: Record<string, string | null> = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    tenant_id: TENANT_ID,
    redirect_uri: APP_LINK,
    code_challenge: s256(base64url(randomBytes(48))),
    code_challenge_method: "S256",
    state: base64url(randomBytes(32)),
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return params;
}

/** Runs authorize → provider → Steward callback and returns the App Link hand-off. */
async function completeProviderRoundTrip(
  provider: "google" | "discord",
  identity: Identity,
  options: { prompt?: string } = {},
) {
  const verifier = base64url(randomBytes(48));
  const appState = base64url(randomBytes(32));
  const query = authorizeQuery({
    code_challenge: s256(verifier),
    state: appState,
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
  const authorize = await nativeGet(
    `/auth/oauth/${provider}/authorize?${query}`,
  );
  expect(authorize.status).toBe(302);
  const providerUrl = new URL(authorize.headers.get("location") ?? "");
  const providerCode = base64url(randomBytes(16));
  identities.set(providerCode, identity);
  const callback = await nativeGet(
    `/auth/oauth/${provider}/callback?code=${providerCode}&state=${providerUrl.searchParams.get("state")}`,
  );
  expect(callback.status).toBe(302);
  const handOff = new URL(callback.headers.get("location") ?? "");
  return { providerUrl, handOff, verifier, appState };
}

function readHandOff(handOff: URL) {
  const fragment = new URLSearchParams(handOff.hash.slice(1));
  return { code: fragment.get("code") ?? "", state: fragment.get("state") };
}

describe("native App Link OAuth (Alpha Phone)", () => {
  test("authorize forwards prompt=select_account to Google and accepts no Origin", async () => {
    const appState = base64url(randomBytes(32));
    const response = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({ state: appState, prompt: "select_account" })}`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("prompt")).toBe("select_account");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${STEWARD_ORIGIN}/auth/oauth/google/callback`,
    );
    // Steward's own CSRF state goes to Google; the app's state never does.
    expect(location.searchParams.get("state")).not.toBe(appState);
    expect(location.toString()).not.toContain("synthetic-google-secret");
  });

  test("authorize rejects unsupported prompts, custom schemes and unlisted redirects", async () => {
    const cases: Array<[string, Record<string, string | null>]> = [
      ["google", { prompt: "none" }],
      ["google", { prompt: "login" }],
      ["discord", { prompt: "select_account" }],
      ["google", { redirect_uri: "alphaphone://auth/callback" }],
      ["google", { redirect_uri: "https://eliza.app/alphaphone/auth/other" }],
      [
        "google",
        { redirect_uri: "https://evil.example/alphaphone/auth/callback" },
      ],
      ["google", { redirect_uri: `${APP_LINK}?extra=1` }],
      ["google", { code_challenge: null }],
      ["google", { code_challenge_method: "plain" }],
    ];
    for (const [provider, overrides] of cases) {
      const response = await nativeGet(
        `/auth/oauth/${provider}/authorize?${authorizeQuery(overrides)}`,
      );
      expect({ overrides, status: response.status }).toEqual({
        overrides,
        status: 400,
      });
    }
  });

  test("Google round trip returns code+state to the App Link and redeems once with the verifier", async () => {
    const identity = {
      sub: "google-sub-owner",
      email: "owner@example.test",
      email_verified: true,
      name: "Synthetic Owner",
    };
    const { handOff, verifier, appState } = await completeProviderRoundTrip(
      "google",
      identity,
      { prompt: "select_account" },
    );
    expect(`${handOff.origin}${handOff.pathname}`).toBe(APP_LINK);
    expect(handOff.search).toBe("");
    const { code, state } = readHandOff(handOff);
    expect(state).toBe(appState);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Wrong verifier, redirect or tenant cannot redeem the code...
    for (const body of [
      {
        code,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: base64url(randomBytes(48)),
      },
      {
        code,
        redirectUri: "https://eliza.app/auth/callback",
        tenantId: TENANT_ID,
        codeVerifier: verifier,
      },
      {
        code,
        redirectUri: APP_LINK,
        tenantId: "other-tenant",
        codeVerifier: verifier,
      },
      { code, redirectUri: APP_LINK, tenantId: TENANT_ID },
    ]) {
      const rejected = await nativePost("/auth/oauth/exchange", body);
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(rejected.status).toBeLessThan(500);
    }

    const exchange = await nativePost("/auth/oauth/exchange", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
    });
    const payload = await exchange.json();
    expect(exchange.status).toBe(200);
    expect(typeof payload.token).toBe("string");
    const { verifyToken } = await import("../auth/jwt");
    const claims = await verifyToken(payload.token);
    expect(claims.tenantId).toBe(TENANT_ID);
    expect(claims.email).toBe("owner@example.test");

    // ...and the legitimate redemption is single-use.
    const replay = await nativePost("/auth/oauth/exchange", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
    });
    expect(replay.status).toBe(401);
  }, 30_000);

  test("a provider callback cannot be replayed into a second hand-off", async () => {
    const appState = base64url(randomBytes(32));
    const authorize = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({ state: appState })}`,
    );
    const stewardState = new URL(
      authorize.headers.get("location") ?? "",
    ).searchParams.get("state");
    const providerCode = base64url(randomBytes(16));
    identities.set(providerCode, {
      sub: "google-sub-replay",
      email: "replay@example.test",
      email_verified: true,
    });
    const first = await nativeGet(
      `/auth/oauth/google/callback?code=${providerCode}&state=${stewardState}`,
    );
    expect(first.status).toBe(302);
    const second = await nativeGet(
      `/auth/oauth/google/callback?code=${providerCode}&state=${stewardState}`,
    );
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.headers.get("location")).toBeNull();
  }, 30_000);

  test("an unverified Google email is refused before any code reaches the app", async () => {
    const authorize = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery()}`,
    );
    const stewardState = new URL(
      authorize.headers.get("location") ?? "",
    ).searchParams.get("state");
    const providerCode = base64url(randomBytes(16));
    identities.set(providerCode, {
      sub: "google-sub-unverified",
      email: "unverified@example.test",
      email_verified: false,
    });
    const callback = await nativeGet(
      `/auth/oauth/google/callback?code=${providerCode}&state=${stewardState}`,
    );
    expect(callback.status).toBe(403);
    expect(callback.headers.get("location")).toBeNull();
    const rows = await database.client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = $1",
      ["unverified@example.test"],
    );
    expect(rows.rows).toHaveLength(0);
  }, 30_000);

  test("a second provider with the same verified email links to the existing user", async () => {
    const email = "linked@example.test";
    const google = await completeProviderRoundTrip("google", {
      sub: "google-sub-linked",
      email,
      email_verified: true,
    });
    const googleCode = readHandOff(google.handOff).code;
    const googleSession = await (
      await nativePost("/auth/oauth/exchange", {
        code: googleCode,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: google.verifier,
      })
    ).json();

    const discord = await completeProviderRoundTrip("discord", {
      id: "discord-id-linked",
      email,
      verified: true,
      username: "linked",
    });
    const discordCode = readHandOff(discord.handOff).code;
    const discordSession = await (
      await nativePost("/auth/oauth/exchange", {
        code: discordCode,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: discord.verifier,
      })
    ).json();

    expect(googleSession.user?.id).toBeTruthy();
    expect(discordSession.user?.id).toBe(googleSession.user?.id);
    const users = await database.client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = $1",
      [email],
    );
    expect(users.rows).toEqual([{ id: googleSession.user.id }]);
  }, 30_000);

  test("a hand-off code expires and cannot be redeemed late", async () => {
    const { handOff, verifier } = await completeProviderRoundTrip("google", {
      sub: "google-sub-expired",
      email: "expired@example.test",
      email_verified: true,
    });
    const { code } = readHandOff(handOff);
    setSystemTime(new Date(Date.now() + 10 * 60_000));
    try {
      const late = await nativePost("/auth/oauth/exchange", {
        code,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: verifier,
      });
      expect(late.status).toBe(401);
    } finally {
      setSystemTime();
    }
  }, 30_000);

  test("authorize is rate limited per client address", async () => {
    const priorProxyHops = process.env.STEWARD_TRUSTED_PROXY_HOPS;
    process.env.STEWARD_TRUSTED_PROXY_HOPS = "1";
    // The production limiter, persisted in this test's database.
    const { setDatabaseAuthRateLimiter } = await import(
      "../api/services/auth-rate-limit"
    );
    const { checkDatabaseAuthRateLimit } = await import(
      "../auth/database-rate-limit"
    );
    setDatabaseAuthRateLimiter(checkDatabaseAuthRateLimit);
    try {
      const fromAddress = (address: string) =>
        app.request(
          `${ROUTER_ORIGIN}/auth/oauth/google/authorize?${authorizeQuery()}`,
          { method: "GET", headers: { "x-forwarded-for": address } },
        );
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 31; attempt += 1) {
        statuses.push((await fromAddress("203.0.113.7")).status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 302)).toBe(
        true,
      );
      expect(statuses[30]).toBe(429);
      // Another device keeps its own budget.
      expect((await fromAddress("198.51.100.9")).status).toBe(302);
    } finally {
      setDatabaseAuthRateLimiter(undefined);
      if (priorProxyHops === undefined)
        delete process.env.STEWARD_TRUSTED_PROXY_HOPS;
      else process.env.STEWARD_TRUSTED_PROXY_HOPS = priorProxyHops;
    }
  }, 30_000);
});
