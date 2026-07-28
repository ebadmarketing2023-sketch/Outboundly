import type { SchedulingCandidate, SchedulingContext, SchedulingPolicy } from "../types.js";

/**
 * Timezone Policy (Section 15.2): resolves which IANA timezone the Business Hours Policy (which
 * runs immediately after this one, Section 15.3) should snap against — the recipient's own
 * timezone if known, otherwise the business-hours profile's own timezone. Doesn't move
 * proposedSendAt itself; that's Business Hours' job.
 */
export const timezonePolicy: SchedulingPolicy = {
  id: "timezone",

  apply(candidate: SchedulingCandidate, ctx: SchedulingContext): SchedulingCandidate {
    const timezone = ctx.recipientTimezone ?? ctx.businessHoursProfile.timezone;
    const source = ctx.recipientTimezone ? "recipient's known timezone" : "business-hours profile's timezone";
    return {
      ...candidate,
      resolvedTimezone: timezone,
      trace: [...candidate.trace, { policyId: "timezone", decision: `Resolved to ${timezone} (${source})` }]
    };
  }
};
