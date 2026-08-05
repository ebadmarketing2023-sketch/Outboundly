import { describeWindowOpening, isWithinBusinessHours, nextWindowOpening } from "../business-hours-window.js";
import { toLocalTimePoint } from "../local-time.js";
import type { SchedulingCandidate, SchedulingContext, SchedulingPolicy } from "../types.js";

/**
 * Business Hours Policy (Section 15.2): snaps a candidate send time forward to the next allowed
 * window if it currently falls outside one, using the timezone the Timezone Policy resolved
 * (Section 15.3 — Timezone Policy runs immediately before this one so its resolution is ready).
 *
 * The calendar arithmetic itself lives in business-hours-window.ts, shared with the send worker's
 * dispatch-time re-check — see that module for why a queued row has to be asked the same question
 * a second time.
 */
export const businessHoursPolicy: SchedulingPolicy = {
  id: "business-hours",

  apply(candidate: SchedulingCandidate, ctx: SchedulingContext): SchedulingCandidate {
    const timezone = candidate.resolvedTimezone ?? ctx.businessHoursProfile.timezone;

    if (isWithinBusinessHours(candidate.proposedSendAt, ctx.businessHoursProfile, timezone)) {
      const point = toLocalTimePoint(candidate.proposedSendAt, timezone);
      return {
        ...candidate,
        trace: [...candidate.trace, { policyId: "business-hours", decision: `Already within an allowed window on ${point.weekday}` }]
      };
    }

    const snappedUtc = nextWindowOpening(candidate.proposedSendAt, ctx.businessHoursProfile, timezone);
    return {
      ...candidate,
      proposedSendAt: snappedUtc,
      trace: [
        ...candidate.trace,
        {
          policyId: "business-hours",
          decision: `Outside allowed windows — snapped forward to ${describeWindowOpening(snappedUtc, ctx.businessHoursProfile, timezone)}`,
          before: { sendAt: candidate.proposedSendAt.toISOString() },
          after: { sendAt: snappedUtc.toISOString() }
        }
      ]
    };
  }
};
