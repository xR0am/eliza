/** Stateless owner Calendar sync: stable creates, conditional writes, bounded provider I/O. */
import { z } from "zod";
import { boundedProviderFetch } from "../../utils/bounded-provider-fetch";
import type {
  LinkedCalendarProviderSnapshot,
  LinkedCalendarSemanticEvent,
} from "@elizaos/contracts/calendar-linked-sync";

export interface CalendarSyncOwner {
  organizationId: string;
  userId: string;
  grantId: string;
  signal?: AbortSignal;
}
export interface CalendarSyncGrant {
  connectionId: string;
  token: string;
  capabilities: readonly string[];
}
export interface CalendarSyncDependencies {
  grant(owner: CalendarSyncOwner): Promise<CalendarSyncGrant>;
  request?: typeof fetch;
}
export type CalendarSyncEvent = LinkedCalendarSemanticEvent;
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const atom = (value: unknown, max = 2048): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
const endpoint = "https://www.googleapis.com/calendar/v3";
const eventSchema = z
  .object({
    title: z.string().trim().min(1).max(4000),
    description: z.string().max(64000),
    location: z.string().max(4096),
    startAt: z.string().max(64),
    endAt: z.string().max(64),
    timeZone: z.string().max(128).nullable(),
    isAllDay: z.boolean(),
    attendees: z
      .array(
        z.object({ email: z.string().email().max(320), optional: z.boolean().optional() }).strict(),
      )
      .max(100),
    deleted: z.literal(false).optional(),
    recurrence: z.array(z.string().min(1).max(2048)).max(100).optional(),
  })
  .strict();
export class CalendarSyncError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 412 | 413 | 429 | 502 | 503,
    readonly code: string,
    readonly outcome: "not_accepted" | "precondition_failed" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "CalendarSyncError";
  }
}
const reject = (message: string) =>
  new CalendarSyncError(400, "CALENDAR_SYNC_INVALID", "not_accepted", message);
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function eventInput(value: unknown): CalendarSyncEvent {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) throw reject("Review the complete Calendar event before syncing.");
  const event = parsed.data;
  if (event.isAllDay) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(event.startAt) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.endAt) ||
      event.timeZone !== null
    )
      throw reject("All-day events need whole dates.");
  } else {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.startAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(event.endAt)
    )
      throw reject("Timed events need absolute RFC3339 instants.");
    if (!event.timeZone) throw reject("Timed events need a timezone.");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: event.timeZone }).format();
    } catch {
      throw reject("Review the event timezone.");
    }
  }
  const start = Date.parse(event.startAt),
    end = Date.parse(event.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw reject("Review the event dates.");
  if (
    event.isAllDay &&
    (new Date(start).toISOString().slice(0, 10) !== event.startAt ||
      new Date(end).toISOString().slice(0, 10) !== event.endAt)
  )
    throw reject("Review valid all-day dates.");
  return {
    ...event,
    ...(!event.isAllDay
      ? { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() }
      : {}),
    attendees: event.attendees
      .map((a) => ({ email: a.email.toLowerCase(), optional: a.optional === true }))
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)),
  };
}
function googleBody(event: CalendarSyncEvent) {
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
    start: event.isAllDay
      ? { date: event.startAt }
      : { dateTime: event.startAt, timeZone: event.timeZone },
    end: event.isAllDay
      ? { date: event.endAt }
      : { dateTime: event.endAt, timeZone: event.timeZone },
    attendees: event.attendees,
    recurrence: event.recurrence ? [...event.recurrence] : [],
  };
}
function snapshot(raw: Json): LinkedCalendarProviderSnapshot & { event: CalendarSyncEvent } {
  if (!atom(raw.id) || !atom(raw.etag) || !record(raw.start) || !record(raw.end))
    throw new CalendarSyncError(
      502,
      "CALENDAR_SYNC_BAD_EVENT",
      "unknown",
      "Google returned an incomplete Calendar event.",
    );
  const allDay = typeof raw.start.date === "string",
    attendees = raw.attendees ?? [];
  if (!Array.isArray(attendees) || attendees.some((a) => !record(a) || typeof a.email !== "string"))
    throw new CalendarSyncError(
      502,
      "CALENDAR_SYNC_BAD_EVENT",
      "unknown",
      "Google returned invalid attendees.",
    );
  let event: CalendarSyncEvent;
  try {
    event = eventInput({
      title: typeof raw.summary === "string" ? raw.summary : "",
      description: typeof raw.description === "string" ? raw.description : "",
      location: typeof raw.location === "string" ? raw.location : "",
      startAt: allDay ? raw.start.date : raw.start.dateTime,
      endAt: allDay ? raw.end.date : raw.end.dateTime,
      timeZone: allDay ? null : (raw.start.timeZone ?? raw.end.timeZone ?? null),
      isAllDay: allDay,
      attendees: attendees.map((a) => ({
        email: (a as Json).email,
        optional: (a as Json).optional === true,
      })),
      ...(Array.isArray(raw.recurrence) && raw.recurrence.length
        ? { recurrence: raw.recurrence }
        : {}),
    });
  } catch (error) {
    if (error instanceof CalendarSyncError && error.code === "CALENDAR_SYNC_INVALID")
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_BAD_EVENT",
        "unknown",
        "Google returned an event that cannot be represented by this sync contract.",
      );
    throw error;
  }
  return { eventId: raw.id, etag: raw.etag, event };
}
function etag(value: string) {
  if (!atom(value, 1024) || value === "*")
    throw reject("An exact Google event revision is required.");
  return value;
}
function providerFailure(status: number) {
  return new CalendarSyncError(
    status === 412 ? 412 : status === 429 ? 429 : status < 500 ? 409 : 502,
    status === 412 ? "CALENDAR_SYNC_PRECONDITION" : "CALENDAR_SYNC_PROVIDER_REJECTED",
    status === 412
      ? "precondition_failed"
      : [400, 401, 403, 404, 409, 410, 422, 429].includes(status)
        ? "not_accepted"
        : "unknown",
    "Google did not confirm this Calendar change. Refresh its exact event and receipt before retrying.",
  );
}

export class ManagedCalendarSyncProvider {
  constructor(private readonly dependencies: CalendarSyncDependencies) {}
  private async grant(owner: CalendarSyncOwner, write: boolean) {
    const grant = await this.dependencies.grant(owner);
    if (
      grant.connectionId !== owner.grantId ||
      !grant.token ||
      !grant.capabilities.includes("google.calendar.read") ||
      (write && !grant.capabilities.includes("google.calendar.write"))
    )
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "The selected Calendar permission is unavailable.",
      );
    return grant;
  }
  private calendar(id: string) {
    if (!atom(id, 1024)) throw reject("Select an exact Calendar.");
    return `${endpoint}/calendars/${encodeURIComponent(id)}/events`;
  }
  private async call(
    owner: CalendarSyncOwner,
    url: string,
    method = "GET",
    body?: object,
    expectedEtag?: string,
  ): Promise<{ status: number; data: Json | null }> {
    owner.signal?.throwIfAborted();
    const write = method !== "GET",
      before = await this.grant(owner, write),
      identity = JSON.stringify([before.connectionId, [...before.capabilities].sort()]);
    owner.signal?.throwIfAborted();
    let status: number,
      data: Json | null = null;
    try {
      const response = await boundedProviderFetch(
        url,
        {
          method,
          redirect: "error",
          signal: owner.signal,
          headers: {
            Authorization: `Bearer ${before.token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(expectedEtag ? { "If-Match": etag(expectedEtag) } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        {
          provider: "google-calendar-sync",
          timeoutMs: 30000,
          maxResponseBytes: 256 * 1024,
          fetchImpl: this.dependencies.request,
        },
      );
      status = response.status;
      if (response.ok && status !== 204) {
        const parsed: unknown = await response.json();
        if (!record(parsed)) throw Error("Invalid provider response");
        data = parsed;
      } else await response.body?.cancel();
    } catch {
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_OUTCOME_UNKNOWN",
        "unknown",
        "The Calendar request outcome could not be confirmed. Do not repeat a write until its event is checked.",
      );
    }
    try {
      const after = await this.grant(owner, write);
      if (JSON.stringify([after.connectionId, [...after.capabilities].sort()]) !== identity)
        throw Error("Changed grant");
    } catch {
      throw new CalendarSyncError(
        409,
        "CALENDAR_SYNC_GRANT_CHANGED",
        "unknown",
        "The Calendar connection changed while the request was running. Check its event before retrying.",
      );
    }
    return { status, data };
  }
  private async access(owner: CalendarSyncOwner, calendarId: string, write = false) {
    this.calendar(calendarId);
    const result = await this.call(
      owner,
      `${endpoint}/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    );
    if (
      result.status !== 200 ||
      !result.data ||
      (result.data.id !== calendarId &&
        !(calendarId === "primary" && result.data.primary === true)) ||
      !["reader", "writer", "owner"].includes(String(result.data.accessRole)) ||
      (write && !["writer", "owner"].includes(String(result.data.accessRole)))
    )
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_CALENDAR_UNAVAILABLE",
        "not_accepted",
        "The selected Calendar is unavailable or its permissions changed.",
      );
    return result.data;
  }
  async capabilities(owner: CalendarSyncOwner, calendarId: string) {
    const grant = await this.grant(owner, false),
      calendar = await this.access(owner, calendarId);
    return {
      version: 1,
      calendarId,
      read: true,
      write:
        grant.capabilities.includes("google.calendar.write") &&
        ["writer", "owner"].includes(String(calendar.accessRole)),
      idempotentCreate: true,
      conditionalWrites: true,
      providerExactlyOnce: false,
    };
  }
  private async identity(key: string) {
    if (!atom(key, 2048)) throw reject("A stable Calendar operation key is required.");
    const hash = await digest(key);
    return { hash, id: "e1" + hash };
  }
  private async raw(
    owner: CalendarSyncOwner,
    calendarId: string,
    id: string,
  ): Promise<Json | null> {
    if (!atom(id, 1024)) throw reject("Select an exact event.");
    const result = await this.call(owner, `${this.calendar(calendarId)}/${encodeURIComponent(id)}`);
    if (result.status === 404 || result.status === 410) {
      await this.access(owner, calendarId);
      return null;
    }
    if (result.status !== 200 || !result.data) throw providerFailure(result.status);
    if (result.data.id !== id)
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_IDENTITY",
        "unknown",
        "Google answered for a different event.",
      );
    if (result.data.status === "cancelled") return null;
    return result.data;
  }
  async get(
    owner: CalendarSyncOwner,
    calendarId: string,
    reference: { eventId?: string; idempotencyKey?: string },
  ) {
    if (!!reference.eventId === !!reference.idempotencyKey)
      throw reject("Select one exact event or operation key.");
    const key = reference.idempotencyKey ? await this.identity(reference.idempotencyKey) : null,
      raw = await this.raw(owner, calendarId, key?.id ?? reference.eventId!);
    if (!raw) return null;
    if (
      key &&
      (!record(raw.extendedProperties) ||
        !record(raw.extendedProperties.private) ||
        raw.extendedProperties.private.alphaSyncKey !== key.hash)
    )
      throw new CalendarSyncError(
        409,
        "CALENDAR_SYNC_KEY_MISMATCH",
        "not_accepted",
        "The event is not bound to this Calendar operation.",
      );
    return snapshot(raw);
  }
  async create(
    owner: CalendarSyncOwner,
    calendarId: string,
    idempotencyKey: string,
    value: unknown,
  ) {
    const event = eventInput(value),
      key = await this.identity(idempotencyKey),
      body = googleBody(event),
      fingerprint = await digest(JSON.stringify(body));
    await this.grant(owner, true);
    const verify = async (raw: Json) => {
      const properties =
        record(raw.extendedProperties) && record(raw.extendedProperties.private)
          ? raw.extendedProperties.private
          : null;
      if (
        raw.id !== key.id ||
        properties?.alphaSyncKey !== key.hash ||
        properties.alphaSyncContent !== fingerprint
      )
        throw new CalendarSyncError(
          409,
          "CALENDAR_SYNC_CREATE_CHANGED",
          "precondition_failed",
          "This operation key is already bound to different event content.",
        );
      const saved = snapshot(raw);
      if ((await digest(JSON.stringify(googleBody(saved.event)))) !== fingerprint)
        throw new CalendarSyncError(
          409,
          "CALENDAR_SYNC_CREATE_CHANGED",
          "precondition_failed",
          "The existing event changed after its original create. Review both versions.",
        );
      return saved;
    };
    const prior = await this.raw(owner, calendarId, key.id);
    if (prior) return verify(prior);
    const result = await this.call(owner, this.calendar(calendarId) + "?sendUpdates=none", "POST", {
      id: key.id,
      ...body,
      visibility: "private",
      reminders: { useDefault: false },
      extendedProperties: { private: { alphaSyncKey: key.hash, alphaSyncContent: fingerprint } },
    });
    if (result.status === 409) {
      const existing = await this.raw(owner, calendarId, key.id);
      if (existing) return verify(existing);
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_OUTCOME_UNKNOWN",
        "unknown",
        "Google reported an existing create but its event could not be verified.",
      );
    }
    if (![200, 201].includes(result.status) || !result.data) throw providerFailure(result.status);
    return verify(result.data);
  }
  async update(
    owner: CalendarSyncOwner,
    calendarId: string,
    eventId: string,
    expectedEtag: string,
    value: unknown,
  ) {
    const event = eventInput(value);
    etag(expectedEtag);
    if (!atom(eventId, 1024)) throw reject("Select an exact event.");
    const result = await this.call(
      owner,
      `${this.calendar(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`,
      "PATCH",
      googleBody(event),
      expectedEtag,
    );
    if (result.status !== 200 || !result.data) throw providerFailure(result.status);
    const saved = snapshot(result.data);
    if (saved.eventId !== eventId)
      throw new CalendarSyncError(
        502,
        "CALENDAR_SYNC_IDENTITY",
        "unknown",
        "Google answered for a different event.",
      );
    return saved;
  }
  async delete(
    owner: CalendarSyncOwner,
    calendarId: string,
    eventId: string,
    expectedEtag: string,
  ) {
    etag(expectedEtag);
    if (!atom(eventId, 1024)) throw reject("Select an exact event.");
    const result = await this.call(
      owner,
      `${this.calendar(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`,
      "DELETE",
      undefined,
      expectedEtag,
    );
    if ([404, 410].includes(result.status)) {
      await this.access(owner, calendarId, true);
      return { deleted: true as const };
    }
    if (result.status !== 204) throw providerFailure(result.status);
    return { deleted: true as const };
  }
}
