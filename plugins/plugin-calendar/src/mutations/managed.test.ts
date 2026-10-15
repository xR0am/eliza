import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../service/managed-calendar-read.js", () => ({
  createManagedCalendarRead: () => ({ mutation: state.call }),
}));
vi.mock("./ledger.js", () => ({
  calendarMutationApprovalSha256: () => "hash",
  calendarMutationOperationKey: () => "stable-key",
}));
vi.mock("@elizaos/core", () => ({ ElizaError: class extends Error {} }));

import { createManagedCalendarMutationPort } from "./managed.js";

const source = `alpha-google:${"a".repeat(64)}`;
const caps = {
  grantId: source,
  calendarId: "calendar",
  accountId: "account",
  read: true,
  write: true,
  idempotentCreate: true,
  conditionalWrites: true,
  providerExactlyOnce: false,
};
const approval = {
  payload: {
    action: "schedule_event",
    side: "owner",
    grantId: source,
    calendarId: "calendar",
  },
} as never;
const make = () => {
  const port = createManagedCalendarMutationPort({}, fetch, "agent");
  if (!port) throw Error("Missing test transport");
  return port;
};
beforeEach(() => state.call.mockReset());
it("binds the verified account and stable create key before dispatch", async () => {
  state.call.mockResolvedValue(caps);
  const preflight = await make().port.preflight(approval);
  expect(preflight.managedAccountId).toBe("account");
  expect(preflight.idempotencyKey).toBe("stable-key");
  expect(state.call).toHaveBeenCalledTimes(1);
});
it("refuses a different source without host calls", async () => {
  await expect(
    make().port.preflight({
      payload: { action: "schedule_event", side: "agent", grantId: source },
    } as never),
  ).rejects.toThrow("exact owner");
  expect(state.call).not.toHaveBeenCalled();
});
it("requires all write capability flags", async () => {
  state.call.mockResolvedValue({ ...caps, conditionalWrites: false });
  await expect(make().port.preflight(approval)).rejects.toThrow("access");
});
it("does not execute if the account changed since preflight", async () => {
  state.call.mockResolvedValue(caps);
  await expect(
    make().port.execute(approval, {
      sourceId: source,
      calendarId: "calendar",
      managedAccountId: "old",
    } as never),
  ).rejects.toThrow("account changed");
  expect(
    state.call.mock.calls.every(
      ([input]) => input.operation !== "write-execute",
    ),
  ).toBe(true);
});
it("refuses a mismatched returned receipt without repeating execution", async () => {
  state.call
    .mockResolvedValueOnce(caps)
    .mockResolvedValueOnce({ event: { grantId: "other" } });
  await expect(
    make().port.execute(approval, {
      sourceId: source,
      calendarId: "calendar",
      managedAccountId: "account",
    } as never),
  ).rejects.toThrow("mismatched");
  expect(state.call).toHaveBeenCalledTimes(2);
});
it("accepts an external event id only under its exact owner source", async () => {
  state.call.mockResolvedValue({
    event: {
      id: `${source}:event-1`,
      externalId: "event-1",
      grantId: source,
      calendarId: "calendar",
      side: "owner",
      provider: "google",
      startAt: "2026-10-14T18:00:00Z",
      endAt: "2026-10-14T18:02:00Z",
      attendees: [],
      metadata: { etag: '"new"' },
    },
  });
  const event = await make().target(source, "calendar", "event-1");
  expect(event.externalId).toBe("event-1");
  expect(event.agentId).toBe("agent");
});
it("changed provider revision stops preflight before dispatch", async () => {
  state.call.mockResolvedValueOnce(caps).mockResolvedValueOnce({
    event: {
      id: `${source}:event-1`,
      externalId: "event-1",
      grantId: source,
      calendarId: "calendar",
      side: "owner",
      provider: "google",
      startAt: "2026-10-14T18:00:00Z",
      endAt: "2026-10-14T18:02:00Z",
      attendees: [],
      metadata: { etag: '"new"' },
    },
  });
  await expect(
    make().port.preflight({
      payload: {
        action: "modify_event",
        side: "owner",
        grantId: source,
        calendarId: "calendar",
        eventId: "event-1",
        expectedProviderVersion: '"old"',
        patch: { title: "Changed" },
      },
    } as never),
  ).rejects.toThrow("changed after review");
  expect(
    state.call.mock.calls.every(
      ([input]) => input.operation !== "write-execute",
    ),
  ).toBe(true);
});
it("unsupported notification options fail before a provider call", async () => {
  await expect(
    make().port.preflight({
      payload: {
        action: "schedule_event",
        side: "owner",
        grantId: source,
        calendarId: "calendar",
        notifyAttendees: true,
      },
    } as never),
  ).rejects.toThrow("editor");
  expect(state.call).not.toHaveBeenCalled();
});
