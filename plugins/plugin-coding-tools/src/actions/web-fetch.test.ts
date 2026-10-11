/**
 * Regression tests for htmlToReadableText numeric character references.
 * HTML maps &#128;-&#159; through windows-1252 (WHATWG numeric character
 * reference table); the entities decoder applies that table, and the five
 * unassigned C1 slots stay as written.
 */
import { describe, expect, it } from "vitest";
import { htmlToReadableText } from "./web-fetch.ts";

describe("htmlToReadableText numeric entities", () => {
  it("decodes C1 numeric references through windows-1252", () => {
    expect(htmlToReadableText("<p>&#128; &#150; &#153; &#x99;</p>")).toBe(
      "€ – ™ ™",
    );
  });

  it("leaves the unassigned C1 slots and &#0; as written", () => {
    expect(htmlToReadableText("<p>&#129; &#141; &#143; &#144; &#157; &#0;</p>")).toBe(
      "&#129; &#141; &#143; &#144; &#157; &#0;",
    );
  });

  it("keeps astral, surrogate, and ordinary references unchanged in behavior", () => {
    expect(htmlToReadableText("<p>&#128512; &#55296; &#8217; &amp;</p>")).toBe(
      "😀 &#55296; ’ &",
    );
  });
});
