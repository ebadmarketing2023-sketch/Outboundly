import { describe, expect, it } from "vitest";
import {
  NoBusinessHoursWindowsError,
  isWithinBusinessHours,
  nextWindowOpening
} from "../../src/core/scheduling/business-hours-window.js";
import type { BusinessHoursProfile } from "../../src/core/scheduling/types.js";

const weekday = [{ start: "09:00", end: "17:00" }];

function profile(overrides: Partial<BusinessHoursProfile> = {}): BusinessHoursProfile {
  return {
    id: "bh-1",
    name: "Weekdays 9-5",
    timezone: "America/New_York",
    windows: { monday: weekday, tuesday: weekday, wednesday: weekday, thursday: weekday, friday: weekday },
    ...overrides
  };
}

describe("isWithinBusinessHours", () => {
  it("accepts a time inside the window and rejects one outside it", () => {
    const p = profile();
    // 2026-03-02 is a Monday. 14:00 UTC = 09:00 EST, the very start of the window.
    expect(isWithinBusinessHours(new Date("2026-03-02T14:00:00Z"), p)).toBe(true);
    expect(isWithinBusinessHours(new Date("2026-03-02T21:59:00Z"), p)).toBe(true); // 16:59 EST
    expect(isWithinBusinessHours(new Date("2026-03-02T22:00:00Z"), p)).toBe(false); // 17:00 EST, end is exclusive
    expect(isWithinBusinessHours(new Date("2026-03-02T13:59:00Z"), p)).toBe(false); // 08:59 EST
  });

  it("rejects a weekday with no windows configured at all", () => {
    // 2026-03-07 is a Saturday, absent from the profile.
    expect(isWithinBusinessHours(new Date("2026-03-07T15:00:00Z"), profile())).toBe(false);
  });

  it("judges by the recipient's timezone when one is supplied, not the profile's", () => {
    const p = profile();
    const at = new Date("2026-03-02T21:00:00Z"); // 16:00 New York, but 22:00 in Berlin
    expect(isWithinBusinessHours(at, p)).toBe(true);
    expect(isWithinBusinessHours(at, p, "Europe/Berlin")).toBe(false);
  });
});

describe("nextWindowOpening", () => {
  it("returns this morning's opening when the time is before it", () => {
    // Monday 06:00 EST -> Monday 09:00 EST.
    expect(nextWindowOpening(new Date("2026-03-02T11:00:00Z"), profile())).toEqual(new Date("2026-03-02T14:00:00Z"));
  });

  it("rolls to the next day when the window has already closed", () => {
    // Monday 17:55 EST (the exact retry-past-the-cutoff case) -> Tuesday 09:00 EST.
    expect(nextWindowOpening(new Date("2026-03-02T22:55:00Z"), profile())).toEqual(new Date("2026-03-03T14:00:00Z"));
  });

  it("skips days with no windows, so a Friday-evening retry lands on Monday", () => {
    // Friday 2026-03-06 20:00 EST -> Monday 2026-03-09 09:00 EST, not Saturday.
    expect(nextWindowOpening(new Date("2026-03-07T01:00:00Z"), profile())).toEqual(new Date("2026-03-09T13:00:00Z"));
  });

  it("keeps the wall-clock opening time across a DST transition", () => {
    // US DST starts Sunday 2026-03-08. Friday 2026-03-06 evening is EST (UTC-5); the Monday it
    // lands on is EDT (UTC-4), so 09:00 local is 13:00Z, not 14:00Z -- adding "72 hours" instead of
    // scanning calendar days would put it at 10:00 local.
    const opening = nextWindowOpening(new Date("2026-03-07T01:00:00Z"), profile());
    expect(opening).toEqual(new Date("2026-03-09T13:00:00Z"));
    expect(isWithinBusinessHours(opening, profile())).toBe(true);
  });

  it("picks the earliest window still ahead when a day has two", () => {
    const split = profile({
      windows: { monday: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "17:00" }] }
    });
    // Monday 12:30 EST falls in the lunch gap -> 14:00 EST, not tomorrow.
    expect(nextWindowOpening(new Date("2026-03-02T17:30:00Z"), split)).toEqual(new Date("2026-03-02T19:00:00Z"));
  });

  it("always returns a time that is itself inside a window", () => {
    const p = profile();
    for (const at of ["2026-03-02T03:00:00Z", "2026-03-04T23:30:00Z", "2026-03-07T12:00:00Z", "2026-03-08T18:00:00Z"]) {
      const opening = nextWindowOpening(new Date(at), p);
      expect(isWithinBusinessHours(opening, p)).toBe(true);
      expect(opening.getTime()).toBeGreaterThan(new Date(at).getTime());
    }
  });

  it("throws rather than looping forever when no day has any window", () => {
    expect(() => nextWindowOpening(new Date("2026-03-02T14:00:00Z"), profile({ windows: {} }))).toThrow(NoBusinessHoursWindowsError);
  });
});
