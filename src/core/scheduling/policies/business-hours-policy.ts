import { localWallClockToUtc, nextWeekday, parseHhMm, toLocalTimePoint, type LocalTimePoint } from "../local-time.js";
import type { BusinessHoursWindow, SchedulingCandidate, SchedulingContext, SchedulingPolicy } from "../types.js";

const MAX_DAYS_TO_SCAN = 8; // a full week plus one, so "no windows configured anywhere" terminates

function isWithinWindow(point: LocalTimePoint, windows: BusinessHoursWindow[] | undefined): boolean {
  if (!windows || windows.length === 0) return false;
  return windows.some(
    (w) => point.minutesSinceMidnight >= parseHhMm(w.start) && point.minutesSinceMidnight < parseHhMm(w.end)
  );
}

function calendarPartsOf(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function addCalendarDays(parts: { year: number; month: number; day: number }, days: number) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * Business Hours Policy (Section 15.2): snaps a candidate send time forward to the next allowed
 * window if it currently falls outside one, using the timezone the Timezone Policy resolved
 * (Section 15.3 — Timezone Policy runs immediately before this one so its resolution is ready).
 */
export const businessHoursPolicy: SchedulingPolicy = {
  id: "business-hours",

  apply(candidate: SchedulingCandidate, ctx: SchedulingContext): SchedulingCandidate {
    const timezone = candidate.resolvedTimezone ?? ctx.businessHoursProfile.timezone;
    const point = toLocalTimePoint(candidate.proposedSendAt, timezone);

    if (isWithinWindow(point, ctx.businessHoursProfile.windows[point.weekday])) {
      return {
        ...candidate,
        trace: [
          ...candidate.trace,
          { policyId: "business-hours", decision: `Already within an allowed window on ${point.weekday}` }
        ]
      };
    }

    const todayCalendar = calendarPartsOf(candidate.proposedSendAt, timezone);
    let weekday = point.weekday;

    for (let dayOffset = 0; dayOffset < MAX_DAYS_TO_SCAN; dayOffset++) {
      const windows = ctx.businessHoursProfile.windows[weekday] ?? [];
      const sortedStarts = [...windows].map((w) => parseHhMm(w.start)).sort((a, b) => a - b);

      for (const windowStartMinutes of sortedStarts) {
        if (dayOffset === 0 && windowStartMinutes <= point.minutesSinceMidnight) continue;

        const targetCalendar = addCalendarDays(todayCalendar, dayOffset);
        const snappedUtc = localWallClockToUtc(
          targetCalendar.year,
          targetCalendar.month,
          targetCalendar.day,
          Math.floor(windowStartMinutes / 60),
          windowStartMinutes % 60,
          timezone
        );
        return {
          ...candidate,
          proposedSendAt: snappedUtc,
          trace: [
            ...candidate.trace,
            {
              policyId: "business-hours",
              decision: `Outside allowed windows — snapped forward to ${weekday} ${String(Math.floor(windowStartMinutes / 60)).padStart(2, "0")}:${String(windowStartMinutes % 60).padStart(2, "0")} (${timezone})`,
              before: { sendAt: candidate.proposedSendAt.toISOString() },
              after: { sendAt: snappedUtc.toISOString() }
            }
          ]
        };
      }

      weekday = nextWeekday(weekday);
    }

    throw new Error(
      `Business hours profile "${ctx.businessHoursProfile.name}" has no allowed windows configured on any weekday`
    );
  }
};
