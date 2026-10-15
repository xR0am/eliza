import { describe, expect, it } from "vitest";
import { parseTweetV2ToV1 } from "./client/tweets";

describe("parseTweetV2ToV1 media linkage", () => {
  const includes = {
    media: [
      {
        media_key: "m1",
        type: "photo" as const,
        url: "https://example.com/m1.jpg",
      },
      {
        media_key: "m2",
        type: "photo" as const,
        url: "https://example.com/m2.jpg",
      },
    ],
  };

  it("attaches only the media referenced by the tweet's media_keys", () => {
    const tweet = {
      id: "t1",
      text: "with one photo",
      attachments: { media_keys: ["m1"] },
    };
    const parsed = parseTweetV2ToV1(tweet as any, includes as any);
    expect(parsed.photos).toHaveLength(1);
    expect(parsed.photos[0].id).toBe("m1");
  });

  it("attaches no media when the tweet has no media_keys", () => {
    const tweet = { id: "t2", text: "no media" };
    const parsed = parseTweetV2ToV1(tweet as any, includes as any);
    expect(parsed.photos).toHaveLength(0);
    expect(parsed.videos).toHaveLength(0);
  });

  it("attaches no media when media_keys is empty", () => {
    const tweet = {
      id: "t3",
      text: "empty keys",
      attachments: { media_keys: [] },
    };
    const parsed = parseTweetV2ToV1(tweet as any, includes as any);
    expect(parsed.photos).toHaveLength(0);
  });
});
