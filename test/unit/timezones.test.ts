import { describe, expect, it } from "vitest";
import { timezoneAbbreviation, US_CANADA_PAKISTAN_TIMEZONES } from "../../src/ui/campaigns/timezones.js";

function optionFor(value: string) {
  const option = US_CANADA_PAKISTAN_TIMEZONES.find((z) => z.value === value);
  if (!option) throw new Error(`no timezone option for ${value}`);
  return option;
}

describe("timezoneAbbreviation (Campaigns business-hours timezone picker)", () => {
  const midJuly = new Date("2026-07-15T12:00:00Z"); // deep in Northern Hemisphere DST
  const midJanuary = new Date("2026-01-15T12:00:00Z"); // deep in standard time

  it("flips US Eastern between EST and EDT across the DST boundary", () => {
    const eastern = optionFor("America/New_York");
    expect(timezoneAbbreviation(eastern, midJanuary)).toBe("EST");
    expect(timezoneAbbreviation(eastern, midJuly)).toBe("EDT");
  });

  it("flips every other DST-observing US/Canada zone the same way", () => {
    expect(timezoneAbbreviation(optionFor("America/Chicago"), midJanuary)).toBe("CST");
    expect(timezoneAbbreviation(optionFor("America/Chicago"), midJuly)).toBe("CDT");
    expect(timezoneAbbreviation(optionFor("America/Denver"), midJanuary)).toBe("MST");
    expect(timezoneAbbreviation(optionFor("America/Denver"), midJuly)).toBe("MDT");
    expect(timezoneAbbreviation(optionFor("America/Los_Angeles"), midJanuary)).toBe("PST");
    expect(timezoneAbbreviation(optionFor("America/Los_Angeles"), midJuly)).toBe("PDT");
    expect(timezoneAbbreviation(optionFor("America/Anchorage"), midJanuary)).toBe("AKST");
    expect(timezoneAbbreviation(optionFor("America/Anchorage"), midJuly)).toBe("AKDT");
    expect(timezoneAbbreviation(optionFor("America/Halifax"), midJanuary)).toBe("AST");
    expect(timezoneAbbreviation(optionFor("America/Halifax"), midJuly)).toBe("ADT");
    expect(timezoneAbbreviation(optionFor("America/Toronto"), midJanuary)).toBe("EST");
    expect(timezoneAbbreviation(optionFor("America/Toronto"), midJuly)).toBe("EDT");
    expect(timezoneAbbreviation(optionFor("America/Winnipeg"), midJanuary)).toBe("CST");
    expect(timezoneAbbreviation(optionFor("America/Winnipeg"), midJuly)).toBe("CDT");
    expect(timezoneAbbreviation(optionFor("America/Edmonton"), midJanuary)).toBe("MST");
    expect(timezoneAbbreviation(optionFor("America/Edmonton"), midJuly)).toBe("MDT");
    expect(timezoneAbbreviation(optionFor("America/Vancouver"), midJanuary)).toBe("PST");
    expect(timezoneAbbreviation(optionFor("America/Vancouver"), midJuly)).toBe("PDT");
  });

  // Newfoundland's half-hour offset is exactly the case that broke a plain Intl "short" lookup
  // (Node's ICU has no named form for it and falls back to a raw "GMT-2:30"/"GMT-3:30") --
  // covered explicitly since it's the one zone here with a non-integer UTC offset.
  it("still resolves NST/NDT for Newfoundland's half-hour offset zone", () => {
    const newfoundland = optionFor("America/St_Johns");
    expect(timezoneAbbreviation(newfoundland, midJanuary)).toBe("NST");
    expect(timezoneAbbreviation(newfoundland, midJuly)).toBe("NDT");
  });

  it("never flips a no-DST zone regardless of season (Arizona, Hawaii, Saskatchewan, Pakistan)", () => {
    expect(timezoneAbbreviation(optionFor("America/Phoenix"), midJanuary)).toBe("MST");
    expect(timezoneAbbreviation(optionFor("America/Phoenix"), midJuly)).toBe("MST");
    expect(timezoneAbbreviation(optionFor("Pacific/Honolulu"), midJanuary)).toBe("HST");
    expect(timezoneAbbreviation(optionFor("Pacific/Honolulu"), midJuly)).toBe("HST");
    expect(timezoneAbbreviation(optionFor("America/Regina"), midJanuary)).toBe("CST");
    expect(timezoneAbbreviation(optionFor("America/Regina"), midJuly)).toBe("CST");
  });

  // This is the exact case the user asked for by name -- Pakistan Standard Time never observes
  // DST, and (like Newfoundland above) Intl's plain "short" timeZoneName falls back to a raw
  // "GMT+5" for it rather than a named abbreviation, which is why the lookup table exists at all.
  it("always resolves PKT for Pakistan, which Intl's own short-name lookup cannot name", () => {
    const pakistan = optionFor("Asia/Karachi");
    expect(timezoneAbbreviation(pakistan, midJanuary)).toBe("PKT");
    expect(timezoneAbbreviation(pakistan, midJuly)).toBe("PKT");
  });

  it("crosses the actual 2026 US DST boundary correctly on each side of the transition instant", () => {
    const eastern = optionFor("America/New_York");
    // 2026 US DST ends Nov 1 at 2:00 local (06:00 UTC then, since still EDT/-4 up to that instant).
    const justBeforeFallBack = new Date("2026-11-01T05:59:00Z");
    const justAfterFallBack = new Date("2026-11-01T07:01:00Z");
    expect(timezoneAbbreviation(eastern, justBeforeFallBack)).toBe("EDT");
    expect(timezoneAbbreviation(eastern, justAfterFallBack)).toBe("EST");
  });
});
