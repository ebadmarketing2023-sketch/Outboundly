/**
 * Real, DST-correct IANA timezone conversion via Node's built-in Intl — verified against actual
 * timezone/weekday output (Asia/Tokyo, America/New_York) rather than a hand-rolled UTC-offset
 * table, which would be wrong across DST transitions.
 */

const WEEKDAY_ORDER = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface LocalTimePoint {
  /** Lowercase full weekday name ("monday".."sunday"). */
  weekday: string;
  /** Minutes since local midnight (0-1439). */
  minutesSinceMidnight: number;
}

export function toLocalTimePoint(date: Date, timeZone: string): LocalTimePoint {
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    timeZone
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === "weekday")!.value.toLowerCase();
  // Intl can render midnight as "24" in hour12:false mode for some locales/timezones — normalize.
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")!.value);

  return { weekday, minutesSinceMidnight: hour * 60 + minute };
}

export function parseHhMm(value: string): number {
  const [hourStr, minuteStr] = value.split(":");
  return Number(hourStr) * 60 + Number(minuteStr ?? "0");
}

export function nextWeekday(weekday: string): string {
  const index = WEEKDAY_ORDER.indexOf(weekday);
  return WEEKDAY_ORDER[(index + 1) % WEEKDAY_ORDER.length]!;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function dateParts(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute)
  };
}

/**
 * Converts a desired local wall-clock date/time in an IANA timezone back to the UTC instant that
 * produces it — the inverse of toLocalTimePoint. Node has no built-in API for this (Temporal
 * isn't shipped yet), so this uses the standard iterative-correction technique: guess a UTC
 * instant, check what local time it actually renders as, and adjust by the difference. Verified
 * for real against DST transitions (America/New_York winter/summer) and fractional-offset
 * timezones (Asia/Kolkata, UTC+5:30) — converges within 2 iterations for any real timezone, since
 * offsets never change faster than that.
 */
export function localWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let i = 0; i < 3; i++) {
    const local = dateParts(guess, timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    const diff = desiredAsUtc - localAsUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}
