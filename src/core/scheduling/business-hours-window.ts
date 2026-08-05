import { localWallClockToUtc, nextWeekday, parseHhMm, toLocalTimePoint, type LocalTimePoint } from "./local-time.js";
import type { BusinessHoursProfile, BusinessHoursWindow } from "./types.js";

/**
 * "Is this instant inside the campaign's allowed sending windows, and if not, when does the next
 * one open?" — the pure calendar arithmetic behind the Business Hours Policy (Section 15.2), split
 * out so it can also be asked at *dispatch* time.
 *
 * That second caller is the point. The Scheduler snaps a send into an allowed window when it
 * enqueues, but every path that later moves a queued row does plain clock arithmetic on top of
 * that: the transient-failure backoff (1 min doubling to a 24h ceiling), the Rate Limiter's
 * retryAfter, the paused-campaign hold, and unclean-shutdown recovery. A message that fails at
 * 16:55 with a one-hour backoff comes back at 17:55 — past the 17:00 window — and goes out anyway;
 * a longer backoff can land it at 3am or on a Saturday, which is exactly the pattern that gets cold
 * outreach filed as spam. Sharing this module means the answer cannot drift between the two.
 */

const MAX_DAYS_TO_SCAN = 8; // a full week plus one, so "no windows configured anywhere" terminates

export function isWithinWindows(point: LocalTimePoint, windows: BusinessHoursWindow[] | undefined): boolean {
  if (!windows || windows.length === 0) return false;
  return windows.some((w) => point.minutesSinceMidnight >= parseHhMm(w.start) && point.minutesSinceMidnight < parseHhMm(w.end));
}

export function isWithinBusinessHours(at: Date, profile: BusinessHoursProfile, timezone?: string): boolean {
  const zone = timezone ?? profile.timezone;
  const point = toLocalTimePoint(at, zone);
  return isWithinWindows(point, profile.windows[point.weekday]);
}

function calendarPartsOf(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function addCalendarDays(parts: { year: number; month: number; day: number }, days: number) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export class NoBusinessHoursWindowsError extends Error {
  constructor(profileName: string) {
    super(`Business hours profile "${profileName}" has no allowed windows configured on any weekday`);
    this.name = "NoBusinessHoursWindowsError";
  }
}

/**
 * The start of the first allowed window strictly after `at`. Scans calendar day by calendar day
 * (rather than adding 24h at a time) so a DST transition in between can't shift the wall-clock
 * opening time.
 */
export function nextWindowOpening(at: Date, profile: BusinessHoursProfile, timezone?: string): Date {
  const zone = timezone ?? profile.timezone;
  const point = toLocalTimePoint(at, zone);
  const todayCalendar = calendarPartsOf(at, zone);
  let weekday = point.weekday;

  for (let dayOffset = 0; dayOffset < MAX_DAYS_TO_SCAN; dayOffset++) {
    const windows = profile.windows[weekday] ?? [];
    const sortedStarts = [...windows].map((w) => parseHhMm(w.start)).sort((a, b) => a - b);

    for (const windowStartMinutes of sortedStarts) {
      if (dayOffset === 0 && windowStartMinutes <= point.minutesSinceMidnight) continue;
      const target = addCalendarDays(todayCalendar, dayOffset);
      return localWallClockToUtc(
        target.year,
        target.month,
        target.day,
        Math.floor(windowStartMinutes / 60),
        windowStartMinutes % 60,
        zone
      );
    }

    weekday = nextWeekday(weekday);
  }

  throw new NoBusinessHoursWindowsError(profile.name);
}

/** Formats a window start the way the policy's trace entry describes it. */
export function describeWindowOpening(opening: Date, profile: BusinessHoursProfile, timezone?: string): string {
  const zone = timezone ?? profile.timezone;
  const point = toLocalTimePoint(opening, zone);
  const hh = String(Math.floor(point.minutesSinceMidnight / 60)).padStart(2, "0");
  const mm = String(point.minutesSinceMidnight % 60).padStart(2, "0");
  return `${point.weekday} ${hh}:${mm} (${zone})`;
}
