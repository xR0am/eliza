import { describe, expect, it } from "vitest";
import {
  endAtFromIcsDuration,
  parseIcsCalendar,
  startAtBeforeIcsDurationEnd,
} from "./parser.js";

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

describe("startAtBeforeIcsDurationEnd", () => {
  it("steps back across a DST gap so overlapping starts stay in range", () => {
    // 02:30 EDT on 2026-03-09; one nominal day earlier is 02:30 on 03-08,
    // inside the New York spring-forward gap.
    const boundary = startAtBeforeIcsDurationEnd({
      endAt: "2026-03-09T06:30:00.000Z",
      timezone: "America/New_York",
      isAllDay: false,
      duration: "P1D",
    });
    const overlappingStart = "2026-03-08T07:00:00.000Z";
    expect(Date.parse(boundary)).toBeLessThan(Date.parse(overlappingStart));
    expect(
      Date.parse(
        endAtFromIcsDuration({
          startAt: overlappingStart,
          timezone: "America/New_York",
          isAllDay: false,
          duration: "P1D",
        }),
      ),
    ).toBeGreaterThan(Date.parse("2026-03-09T06:30:00.000Z"));
    expect(boundary).toBe("2026-03-08T06:30:00.000Z");
  });

  it("returns the exact nominal inverse outside a gap", () => {
    expect(
      startAtBeforeIcsDurationEnd({
        endAt: "2026-03-10T14:00:00.000Z",
        timezone: "America/New_York",
        isAllDay: false,
        duration: "P1D",
      }),
    ).toBe("2026-03-09T14:00:00.000Z");
  });
});
