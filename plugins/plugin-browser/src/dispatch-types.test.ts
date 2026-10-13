import { describe, expect, it } from "vitest";
import { isIdempotentBrowserSubaction } from "./dispatch-types.js";

describe("isIdempotentBrowserSubaction", () => {
  it("does not classify script-capable wait as read-only", () => {
    expect(isIdempotentBrowserSubaction("wait")).toBe(false);
  });

  it("keeps the read-only browser subactions classified as idempotent", () => {
    for (const subaction of ["list", "state", "get", "snapshot", "inspect"] as const) {
      expect(isIdempotentBrowserSubaction(subaction)).toBe(true);
    }
  });
});
