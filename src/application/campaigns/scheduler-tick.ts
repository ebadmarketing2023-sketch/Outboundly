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
/** Process-lifetime dedupe for the missing-personalization alert below. In-memory on purpose: it
 * only guards alert volume, so losing it on restart costs one extra notification per campaign --
 * and re-raising it after a restart is arguably right, since the problem is still there. */
const reportedMissingPersonalization = new Set<string>();

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
        // every subsequent tick. Recoverable by design -- fix the lead's data or give the token a
        // fallback and it resumes on its own -- but it used to be completely invisible while it
        // waited, which is how a campaign could sit "running" for days having sent nothing at all.
        // A token that no lead has a value for (a signature's {{Account Name}}, a typo, a column
        // that never made it into the CSV) blocks *every* lead, so silence here is the difference
        // between a five-second fix and an unexplained dead campaign.
        //
        // Raised once per campaign+token: one alert naming the token, not one per lead per tick.
        const key = `${enrollment.campaignId}:${outcome.variableName}`;
        if (!reportedMissingPersonalization.has(key)) {
          reportedMissingPersonalization.add(key);
          const explanation =
            `No value for {{${outcome.variableName}}}, so this campaign can't send to the leads missing it. ` +
            `Give the token a fallback -- {{${outcome.variableName}|...}} -- or fill that column in for those leads.`;
          await deps.errorLogRepository?.record({
            occurredAt: now,
            source: "scheduler",
            errorType: "missing_personalization",
            errorMessage: explanation,
            campaignId: enrollment.campaignId
          });
          await deps.notificationRepository?.record({
            notificationType: "send_failure",
            severity: "warning",
            message: explanation,
            relatedCampaignId: enrollment.campaignId,
            createdAt: now
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
