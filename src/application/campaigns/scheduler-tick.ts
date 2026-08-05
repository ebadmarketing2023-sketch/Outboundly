import type { EnrollmentId } from "../../core/shared-kernel/ids.js";
import { fireEnrollmentStep, type FireEnrollmentStepDeps } from "./fire-enrollment-step.js";

export interface SchedulerTickResult {
  processed: number;
  enqueued: number;
  completed: number;
  blocked: number;
  noEligibleAccount: number;
  suppressed: number;
  missingPersonalization: number;
  /** A follow-up step became due before the Send worker actually dispatched the message it's
   * replying onto -- deferred rather than fired with a stale Message-ID; retried automatically on
   * the next tick once that prior send completes. */
  waitingOnPriorSend: number;
  /** One enrollment's data/config problem (Section 21.3 failure isolation) -- never lets a single
   * bad enrollment stall the rest of the tick or crash the worker. */
  failures: { enrollmentId: EnrollmentId; error: string }[];
}

/**
 * Scheduler tick worker (Section 21.1): on a fixed interval, runs every due campaign_enrollments
 * row (status=active, next_send_at<=now) through fireEnrollmentStep. Purely the "what's due right
 * now" query plus per-item failure isolation -- fireEnrollmentStep owns all the actual logic.
 */
/** Process-lifetime dedupe for the missing-personalization log below. In-memory on purpose: it only
 * guards log volume, so losing it on restart costs one extra row per affected enrollment. */
const loggedMissingPersonalization = new Set<string>();

export async function runSchedulerTick(deps: FireEnrollmentStepDeps, now: Date): Promise<SchedulerTickResult> {
  const due = await deps.enrollmentRepository.findDueForScheduling(now);
  const result: SchedulerTickResult = {
    processed: 0,
    enqueued: 0,
    completed: 0,
    blocked: 0,
    noEligibleAccount: 0,
    suppressed: 0,
    missingPersonalization: 0,
    waitingOnPriorSend: 0,
    failures: []
  };

  for (const enrollment of due) {
    result.processed++;
    try {
      const outcome = await fireEnrollmentStep(deps, enrollment, now);
      if (outcome.outcome === "enqueued") {
        result.enqueued++;
        if (outcome.enrollmentStatus === "completed") result.completed++;
      } else if (outcome.outcome === "blocked") {
        result.blocked++;
      } else if (outcome.outcome === "no_eligible_account") {
        result.noEligibleAccount++;
      } else if (outcome.outcome === "suppressed") {
        result.suppressed++;
      } else if (outcome.outcome === "missing_personalization") {
        result.missingPersonalization++;
        // This outcome leaves next_send_at alone, so the enrollment stays due and is retried on
        // every subsequent tick -- correct (the user can fix the lead's data or add a fallback and
        // it recovers by itself) but completely invisible: nothing sends and nothing is reported.
        // Logged once per enrollment+token so the error log names the lead's problem instead of
        // filling up with one row per tick, forever.
        const key = `${enrollment.id}:${outcome.variableName}`;
        if (!loggedMissingPersonalization.has(key)) {
          loggedMissingPersonalization.add(key);
          await deps.errorLogRepository?.record({
            occurredAt: now,
            source: "scheduler",
            errorType: "missing_personalization",
            errorMessage: `Lead has no value for {{${outcome.variableName}}}, so this step cannot be sent. Fix that lead's data, or give the token a fallback ({{${outcome.variableName}|...}}).`,
            campaignId: enrollment.campaignId
          });
        }
      } else if (outcome.outcome === "waiting_on_prior_send") {
        result.waitingOnPriorSend++;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.failures.push({ enrollmentId: enrollment.id, error: errorMessage });
      await deps.errorLogRepository?.record({
        occurredAt: now,
        source: "scheduler",
        errorType: "enrollment_step_failed",
        errorMessage,
        campaignId: enrollment.campaignId
      });
    }
  }

  return result;
}
