import type { SchedulingCandidate, SchedulingContext, SchedulingPolicy } from "../types.js";

/**
 * Delay Policy (Section 15.2): adds randomized jitter between sends so outbound traffic doesn't
 * look bot-scheduled. Runs last in the pipeline (Section 15.3) specifically so its jitter isn't
 * clipped back by the Business Hours snap that runs before it — a jittered send that lands a few
 * minutes into a window is fine, but re-snapping after jitter would defeat the point of the jitter.
 * No delayPolicy configured means no jitter is applied, not a zero-length one.
 */
export const delayPolicy: SchedulingPolicy = {
  id: "delay",

  apply(candidate: SchedulingCandidate, ctx: SchedulingContext): SchedulingCandidate {
    if (!ctx.delayPolicy) {
      return {
        ...candidate,
        trace: [...candidate.trace, { policyId: "delay", decision: "No delay policy configured — no jitter applied" }]
      };
    }

    const { minDelaySeconds, maxDelaySeconds } = ctx.delayPolicy;
    const spanSeconds = Math.max(0, maxDelaySeconds - minDelaySeconds);
    const jitterSeconds = minDelaySeconds + Math.random() * spanSeconds;
    const jitteredSendAt = new Date(candidate.proposedSendAt.getTime() + jitterSeconds * 1000);

    return {
      ...candidate,
      proposedSendAt: jitteredSendAt,
      trace: [
        ...candidate.trace,
        {
          policyId: "delay",
          decision: `Applied ${jitterSeconds.toFixed(1)}s uniform jitter (range ${minDelaySeconds}-${maxDelaySeconds}s)`,
          before: { sendAt: candidate.proposedSendAt.toISOString() },
          after: { sendAt: jitteredSendAt.toISOString() }
        }
      ]
    };
  }
};
