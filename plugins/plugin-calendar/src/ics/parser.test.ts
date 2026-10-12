import { describe, expect, it } from "vitest";
import { parseIcsCalendar } from "./parser.js";

function feedWithSummary(summary: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//t//t//EN",
    "BEGIN:VEVENT",
    "UID:esc1",
    "DTSTAMP:20260101T000000Z",
    "DTSTART:20260102T100000Z",
    "DTEND:20260102T110000Z",
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("decodeIcsText unknown escapes", () => {
  it("keeps the backslash of undefined escapes", () => {
    const raw = String.raw`keep \q and 100\% done`;
    const cal = parseIcsCalendar(feedWithSummary(raw));
    expect(cal.events[0]?.title).toBe(raw);
  });
  it("still decodes the defined escapes", () => {
    // ICS value: a\,b\;c\\d\ne  ->  a,b;c\<newline>e
    const raw = "a\\,b\\;c\\\\d\\ne";
    const cal = parseIcsCalendar(feedWithSummary(raw));
    expect(cal.events[0]?.title).toBe("a,b;c\\d\ne");
  });
});
