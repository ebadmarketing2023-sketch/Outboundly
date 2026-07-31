/**
 * The business-hours-profile timezone picker (Campaigns screen) used to be free text ("IANA
 * timezone, e.g. America/New_York") -- easy to mistype into something the scheduler would later
 * choke on. This is the fixed set of US/Canada/Pakistan zones it now offers instead, each labeled
 * by region rather than by city, plus a live, DST-aware abbreviation.
 *
 * The abbreviation pairs below are hardcoded rather than read from Intl's own "short" timeZoneName
 * (verified for real: Node's ICU data has no named short form for Asia/Karachi or
 * America/St_Johns and silently falls back to a raw "GMT+5"/"GMT-2:30" offset for those two,
 * which would print the exact opposite of what was asked for -- "pkt" must actually show "PKT").
 * What *is* still resolved live via Intl is which side of a DST transition `at` falls on -- that
 * part is never hardcoded, so EST vs EDT (etc.) always matches the real date given.
 */
export interface TimezoneOption {
  /** The real IANA zone id this resolves to -- what's actually stored/scheduled against. */
  value: string;
  /** Region name, deliberately not the IANA id's city (e.g. "Eastern", not "New York"). */
  regionLabel: string;
  country: "United States" | "Canada" | "Pakistan";
  /** [standardAbbreviation, daylightAbbreviation] -- a one-element tuple for a zone with no DST. */
  abbreviations: [string] | [string, string];
}

export const US_CANADA_PAKISTAN_TIMEZONES: TimezoneOption[] = [
  { value: "America/New_York", regionLabel: "Eastern", country: "United States", abbreviations: ["EST", "EDT"] },
  { value: "America/Chicago", regionLabel: "Central", country: "United States", abbreviations: ["CST", "CDT"] },
  { value: "America/Denver", regionLabel: "Mountain", country: "United States", abbreviations: ["MST", "MDT"] },
  { value: "America/Phoenix", regionLabel: "Arizona", country: "United States", abbreviations: ["MST"] },
  { value: "America/Los_Angeles", regionLabel: "Pacific", country: "United States", abbreviations: ["PST", "PDT"] },
  { value: "America/Anchorage", regionLabel: "Alaska", country: "United States", abbreviations: ["AKST", "AKDT"] },
  { value: "Pacific/Honolulu", regionLabel: "Hawaii", country: "United States", abbreviations: ["HST"] },
  { value: "America/St_Johns", regionLabel: "Newfoundland", country: "Canada", abbreviations: ["NST", "NDT"] },
  { value: "America/Halifax", regionLabel: "Atlantic", country: "Canada", abbreviations: ["AST", "ADT"] },
  { value: "America/Toronto", regionLabel: "Eastern", country: "Canada", abbreviations: ["EST", "EDT"] },
  { value: "America/Winnipeg", regionLabel: "Central", country: "Canada", abbreviations: ["CST", "CDT"] },
  { value: "America/Regina", regionLabel: "Saskatchewan", country: "Canada", abbreviations: ["CST"] },
  { value: "America/Edmonton", regionLabel: "Mountain", country: "Canada", abbreviations: ["MST", "MDT"] },
  { value: "America/Vancouver", regionLabel: "Pacific", country: "Canada", abbreviations: ["PST", "PDT"] },
  { value: "Asia/Karachi", regionLabel: "Pakistan", country: "Pakistan", abbreviations: ["PKT"] }
];

/** The zone's real UTC offset in minutes at `at`, read live via Intl (never a hand-rolled table). */
function offsetMinutesAt(tz: string, at: Date): number {
  const raw = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const match = raw?.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 0;
  const sign = match[1]!.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(match[1])) * 60 + Number(match[2] ?? 0));
}

/**
 * Whether `tz` is observing DST at `at`, detected by comparing its offset against January 1 of
 * the same year -- reliably standard time in every zone this list uses, including the Southern
 * Hemisphere-inverted... except none of these are Southern Hemisphere, so this holds for all 15.
 * Comparing against a live-computed reference (not a fixed "DST runs March-November" rule) is
 * what keeps this correct as real DST start/end dates shift in future years.
 */
function isObservingDst(tz: string, at: Date): boolean {
  const referenceJan1 = new Date(Date.UTC(at.getUTCFullYear(), 0, 1));
  return offsetMinutesAt(tz, at) !== offsetMinutesAt(tz, referenceJan1);
}

/** The zone's current short code (EST/EDT, PKT, ...) as of `at` (defaults to now). */
export function timezoneAbbreviation(option: TimezoneOption, at: Date = new Date()): string {
  if (option.abbreviations.length === 1) return option.abbreviations[0];
  return isObservingDst(option.value, at) ? option.abbreviations[1] : option.abbreviations[0];
}

export function defaultTimezone(): string {
  const osZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return US_CANADA_PAKISTAN_TIMEZONES.some((z) => z.value === osZone) ? osZone : "America/New_York";
}
