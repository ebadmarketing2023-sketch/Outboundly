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
  /** One enrollment's data/config problem (Section 21.3 failure isolation) -- never lets a single
   * bad enrollment stall the rest of the tick or crash the worker. */
  failures: { enrollmentId: EnrollmentId; error: string }[];
}

/**
 * Scheduler tick worker (Section 21.1): on a fixed interval, runs every due campaign_enrollments
 * row (status=active, next_send_at<=now) through fireEnrollmentStep. Purely the "what's due right
 * now" query plus per-item failure isolation -- fireEnrollmentStep owns all the actual logic.
 */
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
