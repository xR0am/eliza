/**
 * Drives the managed Gmail search through its authenticated fetch boundary.
 * Each page carries the mailbox historyId that Gmail reported before the page
 * was listed, so a client can see that the mailbox changed between pages.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fetchManagedGoogleGmailSearch } from "./gmail";
import { managedGoogleConnectorDeps } from "./shared";

const savedFetch = globalThis.fetch;
const savedDeps = { ...managedGoogleConnectorDeps };
const savedEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
};

const SEARCH = {
  organizationId: "org-1",
  userId: "user-1",
  side: "owner" as const,
  grantId: "conn-1",
  query: "in:inbox",
  maxResults: 2,
};

let mailboxHistoryId: unknown;
let requests: string[];

function installGmail(pages: Record<string, { ids: string[]; next?: string }>) {
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: mailboxHistoryId });
    if (url.pathname.endsWith("/messages")) {
      const page = pages[url.searchParams.get("pageToken") ?? ""];
      return Response.json({
        messages: page.ids.map((id) => ({ id, threadId: `thread-${id}` })),
        ...(page.next ? { nextPageToken: page.next } : {}),
      });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    return Response.json({
      id,
      threadId: `thread-${id}`,
      labelIds: ["INBOX"],
      internalDate: "1767225600000",
      payload: { headers: [{ name: "Subject", value: `Subject ${id}` }] },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests = [];
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  managedGoogleConnectorDeps.oauthService = {
    ...savedDeps.oauthService,
    listConnections: async () => [
      {
        id: "conn-1",
        status: "active",
        platformUserId: "google-user",
        email: "owner@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        linkedAt: new Date(0),
      },
    ],
    getValidToken: async () => ({ accessToken: "test-token" }),
  } as unknown as typeof savedDeps.oauthService;
  managedGoogleConnectorDeps.dbRead = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as typeof savedDeps.dbRead;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  Object.assign(managedGoogleConnectorDeps, savedDeps);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.restore();
});

describe("fetchManagedGoogleGmailSearch mailbox revision", () => {
  test("each page reports the mailbox historyId read before it was listed", async () => {
    installGmail({ "": { ids: ["m1", "m2"], next: "page-2" }, "page-2": { ids: ["m4"] } });
    mailboxHistoryId = "1000";
    const first = await fetchManagedGoogleGmailSearch(SEARCH);
    expect(first.mailboxHistoryId).toBe("1000");
    expect(first.nextPageToken).toBe("page-2");
    expect(requests.indexOf("/gmail/v1/users/me/profile")).toBeLessThan(
      requests.indexOf("/gmail/v1/users/me/messages"),
    );

    // m3 was removed after page 1, so Gmail's page 2 skips past it.
    mailboxHistoryId = "1001";
    const second = await fetchManagedGoogleGmailSearch({ ...SEARCH, pageToken: "page-2" });
    expect(second.messages.map((message) => message.externalId)).toEqual(["m4"]);
    expect(second.mailboxHistoryId).toBe("1001");
    expect(second.mailboxHistoryId).not.toBe(first.mailboxHistoryId);
  });
});
