import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewsAction } from "../src/actions/views.ts";
import { closeViewInteractionHost } from "../src/api/view-interaction-host.ts";
import {
  closeRuntimeViewRegistry,
  getView,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "../src/api/views-registry.ts";
import {
  getCurrentViewState,
  handleViewsRoutes,
} from "../src/api/views-routes.ts";
import { runWithViewClient } from "../src/runtime/view-client-context.ts";
import {
  viewNavigationField,
  viewNavigationEvaluator,
} from "../src/runtime/view-navigation.ts";
const owner = "11111111-1111-4111-8111-111111111111" as UUID;
const principal = "55555555-5555-4555-8555-555555555555" as UUID;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
});
function clientMessage(): Memory {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    entityId: owner,
    roomId: "22222222-2222-4222-8222-222222222222",
    content: { source: "client_chat", channelType: "DM", text: "Go back" },
  } as Memory;
}
async function fixture() {
  const runtime = {
    agentId: "44444444-4444-4444-8444-444444444444",
    actions: [viewsAction],
    getRoom: async () => ({ worldId: "world" }),
    getWorld: async () => ({
      id: "world",
      metadata: {
        roles: { [owner]: "OWNER" },
        ownership: { ownerId: owner },
      },
    }),
    getSetting: () => undefined,
    getEntityById: async () => null,
    emitEvent: async () => undefined,
    reportError: vi.fn(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as IAgentRuntime;
  registerBuiltinViews(runtime);
  const installation = await registerPluginViews(
    runtime,
    {
      name: "test-nav-views",
      description: "Fixture view owner",
      views: [
        { id: "notes", label: "Notes", path: "/notes", bundleUrl: "/notes.js" },
        {
          id: "calendar",
          label: "Calendar",
          path: "/calendar",
          bundleUrl: "/calendar.js",
        },
      ],
    },
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  const hostKey = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== "Bearer local-navigation-test") {
      res.writeHead(401).end();
      return;
    }
    void handleViewsRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      hostKey,
      runtime,
      callerAuthorization: { ok: true, role: "OWNER", identityId: principal },
      json: (response, body) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      },
      error: (response, message, code = 500) => {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: message }));
      },
      broadcastWsToClientId: () => 1,
      broadcastWs: () => {
        throw Error("Global navigation is forbidden");
      },
    }).catch((error) => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    closeViewInteractionHost(hostKey);
    closeRuntimeViewRegistry(runtime);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    runtime,
    installation,
    hostKey,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
describe("confirmed previous navigation", () => {
  it("retains only acknowledged same-client history and invalidates it on manual state", async () => {
    const f = await fixture();
    const scope = { hostKey: f.hostKey, clientId: "origin-client" };
    const events = vi.spyOn(f.runtime, "emitEvent");
    const post = (path: string, body: unknown) =>
      fetch(f.url + path, {
        method: "POST",
        headers: {
          authorization: "Bearer local-navigation-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let sequence = 0;
    const prepare = async (viewId: string) => {
      const response = await post(`/api/views/${viewId}/navigate`, {
        clientId: scope.clientId,
        delivery: "completed-action",
        prepareOnly: true,
        viewType: "gui",
        completedActionHandoffId: `confirmed-${++sequence}`,
      });
      expect(response.status).toBe(200);
      const { navigationBinding } = await response.json();
      const claim = await post("/api/views/interact-claim", navigationBinding);
      expect(claim.status).toBe(200);
      return {
        ...navigationBinding,
        claimId: (await claim.json()).claimId,
        success: true,
        result: { switched: true },
      };
    };
    const acknowledge = async (binding: Record<string, unknown>) => {
      expect(
        await (await post("/api/views/interact-result", binding)).json(),
      ).toMatchObject({ accepted: true });
    };
    const context = async (
      viewId: string,
      clientId = scope.clientId,
      callerPrincipal = principal,
      hostKey = f.hostKey,
      overrides: Record<string, unknown> = {},
      withoutRequest = false,
    ) =>
      runWithViewClient({ hostKey, clientId, ...(!withoutRequest ? { request: {
        runtime: f.runtime,
        authorization: { ok: true, role: "OWNER", identityId: callerPrincipal },
        signal: new AbortController().signal,
        ...overrides,
      } } : {}) }, () =>
        viewNavigationField.getContext!({
          runtime: f.runtime,
          message: {
            ...clientMessage(),
            entityId: owner,
            content: {
              source: "client_chat",
              channelType: "DM",
              text: "Go back",
              metadata: {
                viewClientId: clientId,
                viewDelivery: "completed-action",
                uiView: viewId,
              },
            },
          },
          senderRole: "OWNER",
          turnSignal: new AbortController().signal,
        } as never),
      );
    const failed = await prepare("notes");
    await acknowledge({
      ...failed,
      success: false,
      result: { switched: false },
    });
    expect(getCurrentViewState(f.runtime, scope)).toBeNull();
    const first = await prepare("notes");
    expect(getCurrentViewState(f.runtime, scope)).toBeNull();
    await acknowledge(first);
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("notes"),
    );
    expect(await context("notes")).toContain(
      "no confirmed previous destination",
    );
    const second = await prepare("chat");
    expect(
      getCurrentViewState(f.runtime, scope)?.navigationConfirmation
        ?.previousView,
    ).toBeUndefined();
    await acknowledge(second);
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("chat"),
    );
    const confirmed = getCurrentViewState(
      f.runtime,
      scope,
    )?.navigationConfirmation;
    expect(confirmed?.previousView).toEqual({
      viewId: "notes",
      installationId: getView(f.runtime, "notes")?.installationId,
    });
    expect(await context("chat")).toContain(
      "Last confirmed previous destination",
    );
    expect(await context("chat")).toContain('"id":"notes"');
    expect(confirmed?.ownerId).toBe(principal);
    expect(principal).not.toBe(owner);
    expect(await context("chat")).not.toContain(principal);
    expect(await context("chat", scope.clientId, principal, f.hostKey, {}, true))
      .toContain("no confirmed previous destination");
    const cancelled = new AbortController();
    cancelled.abort();
    for (const overrides of [
      { runtime: null },
      { signal: cancelled.signal },
      { authorization: undefined },
      { authorization: { ok: false, role: "OWNER", identityId: principal } },
      { authorization: { ok: true, role: "USER", identityId: principal } },
      { authorization: { ok: true, role: "OWNER", identityId: "foreign-owner", principal } },
    ]) {
      expect(await context("chat", scope.clientId, principal, f.hostKey, overrides))
        .toContain("no confirmed previous destination");
    }

    for (const args of [
      ["notes", scope.clientId, principal, f.hostKey],
      ["chat", "foreign-client", principal, f.hostKey],
      ["chat", scope.clientId, "foreign-owner", f.hostKey],
      ["chat", scope.clientId, principal, {}],
    ] as const)
      expect(
        await context(args[0], args[1], args[2] as UUID, args[3]),
      ).toContain("no confirmed previous destination");
    await acknowledge(await prepare("chat"));
    await vi.waitFor(() =>
      expect(
        getCurrentViewState(f.runtime, scope)?.navigationConfirmation
          ?.handoffId,
      ).toBe("confirmed-4"),
    );
    expect(
      getCurrentViewState(f.runtime, scope)?.navigationConfirmation
        ?.previousView,
    ).toEqual(confirmed?.previousView);
    const stale = await prepare("notes");
    expect(
      (
        await post("/api/views/calendar/navigate", {
          clientId: scope.clientId,
          source: "user",
        })
      ).status,
    ).toBe(200);
    await acknowledge(stale);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("calendar");
    expect(
      getCurrentViewState(f.runtime, scope)?.navigationConfirmation,
    ).toBeUndefined();
    expect(await context("calendar")).toContain(
      "no confirmed previous destination",
    );
    // Only the explicit manual route may announce a switch; native acks never do.
    expect(events).toHaveBeenCalledTimes(1);
    // Re-established confirmed history cannot outlive its registered installation.
    await acknowledge(await prepare("notes"));
    await acknowledge(await prepare("chat"));
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("chat"),
    );
    expect(await context("chat")).toContain(
      "Last confirmed previous destination",
    );
    unregisterPluginViews(f.runtime, f.installation);
    expect(await context("chat")).toContain(
      "no confirmed previous destination",
    );
    expect(await context("notes")).toBe("");
    const message = {
      ...clientMessage(),
      agentId: f.runtime.agentId,
      content: {
        source: "client_chat",
        channelType: "DM",
        text: "Go back",
        metadata: {
          viewClientId: scope.clientId,
          viewDelivery: "completed-action",
          uiView: "chat",
        },
      },
    };
    const value = {
      disposition: "unresolved",
      viewId: "",
      reason: "No confirmed previous destination",
    };
    viewNavigationField.handle!({
      runtime: f.runtime,
      message,
      senderRole: "OWNER",
      value,
      turnSignal: new AbortController().signal,
    } as never);
    const messageHandler = {
      processMessage: "RESPOND",
      plan: {
        contexts: ["general"],
        intents: [],
        candidateActions: [],
        parentActionHints: [],
        requiresTool: false,
        reply: "Which screen would you like to open?",
        replyEffectStatus: "non_applied",
      },
    };
    const selected = await viewNavigationEvaluator.evaluate({
      runtime: f.runtime,
      message,
      state: { data: { providers: {} } },
      userRoles: ["OWNER"],
      messageHandler,
    } as never);
    expect(selected).toBeUndefined();
    expect(messageHandler.plan.requiresTool).toBe(false);
    expect(messageHandler.plan.intents).toEqual([]);
  });
});
