/**
 * Covers numeric HTML-entity decoding on Gmail subject/snippet triage reads.
 * Reviewer request on #34464: assert &#x27;/&#8217; in Subject + snippet so a
 * regression is caught in-tree.
 */
import { describe, expect, it } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.ts";
import { GoogleGmailClient } from "./gmail.ts";

function stubFactory(message: Record<string, unknown>): GoogleApiClientFactory {
  return {
    gmail: async () => ({
      users: {
        messages: {
          get: async () => ({ data: message }),
        },
      },
    }),
  } as unknown as GoogleApiClientFactory;
}

describe("Gmail numeric HTML entities", () => {
  it("decodes Subject and snippet numeric references used by triage reads", async () => {
    const client = new GoogleGmailClient(
      stubFactory({
        id: "msg-entities",
        threadId: "thr-entities",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1728450000000",
        snippet: "a&#160;b &#x27;c&#x27; &#8217;",
        payload: {
          headers: [
            {
              name: "Subject",
              value: "It&#x27;s &#8217;snowing&#8217; &#8211; caf&#233;",
            },
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "To", value: "me@example.com" },
          ],
        },
      })
    );

    const summary = await client.getGmailMessage({
      accountId: "acct-test",
      messageId: "msg-entities",
      selfEmail: "me@example.com",
    });

    expect(summary).toMatchObject({
      subject: "It's \u2019snowing\u2019 \u2013 caf\u00e9",
      snippet: "a b 'c' \u2019",
    });
  });

  it("maps C1 numeric references through windows-1252, as HTML requires", async () => {
    const client = new GoogleGmailClient(
      stubFactory({
        id: "msg-c1",
        threadId: "thr-c1",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1728450000000",
        snippet: "price &#128;100 &#150; deal",
        payload: {
          headers: [
            {
              name: "Subject",
              value: "A&#128; B&#150; C&#159; D&#129; E&#0;",
            },
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "To", value: "me@example.com" },
          ],
        },
      })
    );

    const summary = await client.getGmailMessage({
      accountId: "acct-test",
      messageId: "msg-c1",
      selfEmail: "me@example.com",
    });

    // &#128; is the euro sign and &#150; an en dash under the WHATWG
    // windows-1252 table, not the invisible C1 controls U+0080/U+0096.
    // &#129; is an unassigned slot and &#0; is out of range: both stay as written.
    expect(summary).toMatchObject({
      subject: "A\u20ac B\u2013 C\u0178 D&#129; E&#0;",
      snippet: "price \u20ac100 \u2013 deal",
    });
  });
});
