/** Verifies a real login persistence and cookie-sync sequence publishes one authority epoch. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  replaceStoredStewardTokenIfCurrent,
  STEWARD_SESSION_CHANGE_EVENT,
  type StewardSessionChangeDetail,
  writeStoredStewardToken,
} from "@elizaos/plugin-elizacloud/steward-session-client";
import { afterEach, expect, it, vi } from "vitest";
import { ElizaClient } from "../../../api/client";
import { savePersistedActiveServer } from "../../../state/persistence";
import {
  consumeStewardServerCookieSynced,
  invalidateStewardServerCookieSyncMarker,
} from "../../lib/steward-session-cookie-sync-marker";
import { syncStewardSessionCookie } from "./steward-session";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invalidateStewardServerCookieSyncMarker();
});

it("publishes exactly one present transition across login persistence and cookie sync", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const transitions: StewardSessionChangeDetail[] = [];
  const listener = (event: Event) => {
    transitions.push((event as CustomEvent<StewardSessionChangeDetail>).detail);
  };
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

  try {
    await writeStoredStewardToken("login-token");
    await syncStewardSessionCookie("login-token");
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  }

  expect(transitions.map(({ state }) => state)).toEqual(["present"]);
});

it.each(["cancel", "newer-session"])(
  "real session sync refuses local publication after %s during its POST",
  async (mode) => {
    await writeStoredStewardToken("initial-token");
    const controller = new AbortController();
    let finishFetch!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
    );
    const observedTokens: Array<string | null> = [];
    const changed = () => observedTokens.push(readStoredStewardToken());
    const legacy = vi.fn();
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, changed);
    window.addEventListener("steward-token-sync", legacy);
    try {
      const pending = syncStewardSessionCookie("phone-token", null, {
        verifiedPhone: "+14155552671",
        expectedToken: "initial-token",
        signal: controller.signal,
      });
      const refused = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
      if (mode === "cancel") controller.abort();
      else await writeStoredStewardToken("newer-token");
      finishFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await refused;
      expect(readStoredStewardToken()).toBe(
        mode === "cancel" ? "initial-token" : "newer-token",
      );
      expect(observedTokens).toEqual(mode === "cancel" ? [] : ["newer-token"]);
      expect(legacy).not.toHaveBeenCalled();
      expect(
        consumeStewardServerCookieSynced(
          "phone-token",
          "/api/auth/steward-session",
        ),
      ).toBe(false);
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, changed);
      window.removeEventListener("steward-token-sync", legacy);
    }
  },
);

it("makes the owned cookie-sync marker visible during canonical publication", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const proofs: boolean[] = [];
  const listener = () => {
    proofs.push(
      consumeStewardServerCookieSynced(
        "owned-phone-token",
        "/api/auth/steward-session",
      ),
    );
  };
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  try {
    await syncStewardSessionCookie("owned-phone-token", null, {
      expectedToken: null,
      signal: new AbortController().signal,
    });
    expect(proofs).toEqual([true]);
    expect(readStoredStewardToken()).toBe("owned-phone-token");
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  }
});

it("refuses an already superseded owned sync before posting", async () => {
  await writeStoredStewardToken("newer-token");
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await expect(
    syncStewardSessionCookie("old-phone-token", null, {
      expectedToken: "initial-token",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(readStoredStewardToken()).toBe("newer-token");
});

it("treats abort from a publication listener as committed authority", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}", { status: 200 }),
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, abort);
  try {
    await expect(
      syncStewardSessionCookie("committed-token", null, {
        expectedToken: null,
        signal: controller.signal,
      }),
    ).resolves.toBeUndefined();
    expect(readStoredStewardToken()).toBe("committed-token");
    expect(
      consumeStewardServerCookieSynced(
        "committed-token",
        "/api/auth/steward-session",
      ),
    ).toBe(true);
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, abort);
  }
});

it("uses the current account session on an already selected web Shared runtime", async () => {
  const base =
    "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111";
  await writeStoredStewardToken("old-session");
  const client = new ElizaClient(base, "old-session");
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ ui: {} }), { status: 200 }),
    );

  expect(
    await replaceStoredStewardTokenIfCurrent("old-session", "fresh-session"),
  ).toBe(true);
  await client.getConfig();
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(String(url)).toBe(`${base}/api/config`);
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer fresh-session",
  );
  expect(client.getBaseUrl()).toBe(base);

  await clearStoredStewardToken();
  await client.getConfig();
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(
    new Headers(fetchSpy.mock.calls[1][1]?.headers).get("authorization"),
  ).toBeNull();
  expect(client.getRestAuthToken()).toBeNull();
});

it.each([
  "http://127.0.0.1:43123",
  "https://agent.example.test",
  "https://agent.example.test/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://agent-a.cloud.eliza.app",
  "http://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://api-staging.eliza.app:8443/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://user:pass@api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
  "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111?mode=other",
  "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111#other",
])(
  "preserves independent runtime authority on %s during account rotation and logout",
  async (base) => {
    await writeStoredStewardToken("old-account");
    const client = new ElizaClient(base, "agent-credential");
    expect(
      await replaceStoredStewardTokenIfCurrent("old-account", "new-account"),
    ).toBe(true);
    expect(client.getRestAuthToken()).toBe("agent-credential");
    await clearStoredStewardToken();
    expect(client.getRestAuthToken()).toBe("agent-credential");
    expect(client.getBaseUrl()).toBe(base);
  },
);

it.each(["native", "electrobun"])(
  "preserves the installed managed runtime credential on %s",
  async (platform) => {
    const windowId = Object.getOwnPropertyDescriptor(
      window,
      "__electrobunWindowId",
    );
    if (platform === "native")
      vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    else
      Object.defineProperty(window, "__electrobunWindowId", {
        configurable: true,
        value: 1,
      });
    try {
      await writeStoredStewardToken("old-account");
      const client = new ElizaClient(
        "https://api-staging.eliza.app/api/v1/eliza/agents/personal%3A00000001-1111-5111-8111-111111111111",
        "eliza_owner-key",
      );
      expect(
        await replaceStoredStewardTokenIfCurrent("old-account", "new-account"),
      ).toBe(true);
      expect(client.getRestAuthToken()).toBe("eliza_owner-key");
      await clearStoredStewardToken();
      expect(client.getRestAuthToken()).toBe("eliza_owner-key");
    } finally {
      if (platform === "electrobun") {
        if (windowId)
          Object.defineProperty(window, "__electrobunWindowId", windowId);
        else Reflect.deleteProperty(window, "__electrobunWindowId");
      }
    }
  },
);

it("keeps a build-pinned remote credential outside account session ownership", async () => {
  const base = "https://paired.example.test";
  vi.stubGlobal("__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__", base);
  savePersistedActiveServer({
    id: "remote:paired",
    kind: "remote",
    label: "Paired",
    apiBase: base,
    accessToken: "paired-credential",
  });
  await writeStoredStewardToken("old-account");
  const client = new ElizaClient(base, "installed-credential");
  await replaceStoredStewardTokenIfCurrent("old-account", "new-account");
  expect(client.getRestAuthToken()).toBe("paired-credential");
  await clearStoredStewardToken();
  expect(client.getRestAuthToken()).toBe("paired-credential");
  expect(client.getBaseUrl()).toBe(base);
});
