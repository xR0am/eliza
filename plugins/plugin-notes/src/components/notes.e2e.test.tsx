/**
 * Drives planner-visible Notes capabilities into the real read-only React
 * surface through one filesystem-backed service, including remount cycles.
 *
 * @vitest-environment jsdom
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportFetch = vi.hoisted(() => vi.fn());

vi.mock("../../../../packages/ui/src/api/csrf-client", () => ({
  fetchWithCsrf: transportFetch,
}));

vi.mock("@elizaos/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/ui")>()),
  ...(await (async (importOriginal) => ({
    ...(await importOriginal<typeof import("@elizaos/ui")>()),
    client: {
      fetch: (url: string, init?: RequestInit) =>
        transportFetch(url, init).then((response: Response) => response.json()),
      onWsEvent: vi.fn(() => () => undefined),
    },
    isApiError: () => false,
  }))(importOriginal)),
  useViewEvent: vi.fn(),
  useAgentElement: (definition: { id: string; label: string }) => ({
    ref: { current: null },
    agentProps: {
      "aria-label": definition.label,
      "data-agent-id": definition.id,
    },
  }),
}));

vi.mock(
  "../../../../packages/ui/src/components/shared/ViewHeader",
  () => import("../../../../packages/ui/src/components/shared/ViewHeader"),
);

import { createNotesClient } from "../client/notes-api.js";
import { NotesController } from "../client/notes-controller.js";
import { NotesEditor } from "../client/notes-editor.js";
import { interact as interactWithService } from "../interact.js";
import { NotesService } from "../service.js";
import { NotesView } from "./NotesView.js";

let service: NotesService | null = null;
let stateDirectory = "";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function activeService(): NotesService {
  if (!service) throw new Error("Notes E2E service is unavailable.");
  return service;
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "notes-ui-e2e-"));
  let id = 0;
  let timestamp = Date.parse("2026-07-22T12:00:00.000Z");
  service = new NotesService(undefined, {
    stateDir: stateDirectory,
    createId: () => `note-e2e-${++id}`,
    now: () => new Date(timestamp++),
  });
  await service.initialize();

  transportFetch.mockReset();
  transportFetch.mockImplementation(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const currentService = activeService();
      if (url === "/api/notes/state") {
        return jsonResponse({ success: true, data: currentService.snapshot() });
      }
      if (url.startsWith("/api/views/") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          capability: string;
          params?: Record<string, unknown>;
        };
        const result = await interactWithService(
          body.capability,
          body.params,
          currentService,
        );
        return jsonResponse({
          requestId: `notes-e2e-${body.capability}`,
          success: result.success,
          result,
        });
      }
      return jsonResponse({ error: `Unexpected E2E URL: ${url}` }, 404);
    },
  );
});

afterEach(async () => {
  cleanup();
  await service?.stop();
  service = null;
  await fs.rm(stateDirectory, { recursive: true, force: true });
});

describe("Notes capability-to-UI journey", () => {
  function editorSession() {
    let current = true;
    let reviews = 0;
    const notes = createNotesClient({
      fetch: async <T,>(url: string, init?: RequestInit) =>
        (await transportFetch(url, init)).json() as Promise<T>,
    });
    const controller = new NotesController(notes, () => current, {
      snapshot: () => editor?.reconcile(),
      phase: () => {},
    });
    const editor = new NotesEditor(controller, {
      changed: () => {},
      committed: () => {},
      review: () => {
        reviews++;
      },
    });
    return {
      controller,
      editor,
      retire: () => {
        current = false;
        controller.retire();
      },
      reviews: () => reviews,
    };
  }

  it("shares canonical editor writes, conflicts and Trash with the real Notes service", async () => {
    const session = editorSession();
    try {
      await session.controller.refresh();
      session.editor.begin("list");
      session.editor.edit({
        title: "Exact title",
        body: "\nExact body",
        format: {
          kind: "list",
          data: {
            items: [{ id: "one", text: "Keep rich fields", done: false }],
            pinned: true,
          },
        },
      });
      expect(await session.editor.save()).toBe(true);
      const id = session.editor.draft?.id;
      expect(id).toBeTruthy();
      if (!id) throw Error("Expected canonical note identity");
      expect(activeService().snapshot().notes[0]).toMatchObject({
        title: "Exact title",
        body: "\n\nExact body",
        format: {
          kind: "list",
          data: {
            items: [{ id: "one", text: "Keep rich fields", done: false }],
            pinned: true,
          },
        },
      });
      session.editor.edit({ body: "Unsaved owner text" });
      await interactWithService(
        "update-note",
        {
          id,
          expectedRevision: activeService().snapshot().revision,
          content: "Agent edit\nKeep this",
        },
        activeService(),
      );
      await session.controller.refresh();
      expect(await session.editor.save()).toBe(false);
      expect(session.reviews()).toBeGreaterThan(0);
      expect(session.editor.draft?.body).toBe("Unsaved owner text");
      expect(activeService().snapshot().notes[0].title).toBe("Agent edit");
      session.editor.close();
      session.editor.open(id);
      expect(await session.editor.remove(id)).toBe(true);
      expect(activeService().snapshot().notes).toHaveLength(0);
      expect(await session.editor.restore(id)).toBe(true);
      expect(activeService().snapshot().notes[0].id).toBe(id);
    } finally {
      session.retire();
    }
  });

  it("retires a pending canonical read before it can publish into another owner", async () => {
    await interactWithService(
      "create-note",
      { content: "Owner's private note" },
      activeService(),
    );
    const original = transportFetch.getMockImplementation();
    if (!original) throw Error("Expected Notes service transport");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    transportFetch.mockImplementationOnce(
      async (url: string, init?: RequestInit) => {
        const response = await original(url, init);
        await waiting;
        return response;
      },
    );
    const session = editorSession();
    const read = session.controller.refresh();
    session.retire();
    release();
    await expect(read).rejects.toBeTruthy();
    expect(session.controller.snapshot).toBeNull();
    expect(session.editor.draft).toBeNull();
  });

  it("projects note mutations across read-only view remounts", async () => {
    const notes = render(<NotesView />);
    expect(
      await screen.findByRole("main", {
        name: "Notes. 0 notes.",
      }),
    ).toBeTruthy();
    expect(
      notes.container.querySelector(
        '[data-testid="simple-notes-scroll-region"] button, input, textarea, form',
      ),
    ).toBeNull();
    notes.unmount();

    await interactWithService(
      "create-note",
      {
        content: "Demo briefing\nKeep the note wall durable",
        color: "green",
      },
      activeService(),
    );
    const originalSnapshot = activeService().snapshot();
    await interactWithService(
      "update-note",
      {
        expectedRevision: originalSnapshot.revision,
        query: "Demo briefing",
        content: "Demo briefing ready\nKeep the note wall durable",
      },
      activeService(),
    );

    const populatedNotes = render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();
    expect(screen.getByText("Keep the note wall durable")).toBeTruthy();
    expect(
      screen
        .getByLabelText("Note Demo briefing ready")
        .getAttribute("data-agent-id"),
    ).toBe("note-e2e-1");
    expect(
      populatedNotes.container.querySelector(
        '[data-testid="simple-notes-scroll-region"] button, input, textarea, form',
      ),
    ).toBeNull();
    populatedNotes.unmount();
    render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();
    expect(screen.getByText("Keep the note wall durable")).toBeTruthy();

    await waitFor(() => {
      expect(activeService().snapshot()).toMatchObject({
        revision: 2,
        notes: [{ title: "Demo briefing ready", color: "green" }],
      });
    });
  });
});
