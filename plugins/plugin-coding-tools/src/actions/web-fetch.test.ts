/**
 * Regression tests for htmlToReadableText numeric character references.
 * HTML maps &#128;-&#159; through windows-1252 (WHATWG numeric character
 * reference table); the entities decoder applies that table, and the five
 * unassigned C1 slots stay as written.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebHttpTestOverrides,
  __setWebHttpFetchImplForTests,
  __setWebHttpLookupFnForTests,
  __setWebHttpPinnedFetchImplForTests,
} from "../lib/web-http.js";
import { htmlToReadableText, webFetchAction } from "./web-fetch.ts";

afterEach(() => __resetWebHttpTestOverrides());
async function runFetch(parameters: Record<string, string>) {
  if (!webFetchAction.handler)
    throw new Error("Missing canonical fetch handler");
  return webFetchAction.handler({} as never, {} as never, undefined, {
    parameters,
  } as never);
}

describe("htmlToReadableText numeric entities", () => {
  it("decodes C1 numeric references through windows-1252", () => {
    expect(htmlToReadableText("<p>&#128; &#150; &#153; &#x99;</p>")).toBe(
      "€ – ™ ™",
    );
  });

  it("leaves the unassigned C1 slots and &#0; as written", () => {
    expect(
      htmlToReadableText("<p>&#129; &#141; &#143; &#144; &#157; &#0;</p>"),
    ).toBe("&#129; &#141; &#143; &#144; &#157; &#0;");
  });

  it("decodes hex references with an uppercase X marker", () => {
    expect(htmlToReadableText("<p>&#X27; &#X2019; &#X1F600; &#X80;</p>")).toBe(
      "' ’ 😀 €",
    );
  });

  it("keeps astral, surrogate, and ordinary references unchanged in behavior", () => {
    expect(htmlToReadableText("<p>&#128512; &#55296; &#8217; &amp;</p>")).toBe(
      "😀 &#55296; ’ &",
    );
  });
});

it("Node rejects ambiguous Wttr JSON names before HTTP", async () => {
  const fetch = vi.fn();
  __setWebHttpFetchImplForTests(fetch);
  for (const location of ["Tokyo", "91,139", "35,-181"]) {
    const result = await runFetch({
      url: `https://wttr.in/${location}?format=j1`,
    });
    expect(result?.success).toBe(false);
    expect(result?.text).toContain("coordinates");
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("Node extracts explicitly requested text/plain JSON and preserves actual MIME", async () => {
  __setWebHttpLookupFnForTests(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  __setWebHttpPinnedFetchImplForTests(
    async () =>
      new Response(
        '{"current_condition":[{"temp_C":"22"}],"nearest_area":[{"name":"Tokyo"}]}',
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      ),
  );
  const result = await runFetch({
    url: "https://wttr.in/35.6895,139.6917?format=j1",
    extract: "current_condition",
  });
  expect(result?.success).toBe(true);
  expect(result?.text).toBe('[{"temp_C":"22"}]');
  expect(result?.data).toMatchObject({
    kind: "json",
    content_type: "text/plain; charset=utf-8",
  });
});
