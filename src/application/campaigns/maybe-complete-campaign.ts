import { and, eq, inArray } from "drizzle-orm";
import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import { messages, sendQueue } from "../../adapters/persistence/schema.js";
import type { CampaignId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";

export interface MaybeCompleteCampaignDeps {
  db: OutboundlyDb;
  campaignRepository: CampaignRepository;
  enrollmentRepository: EnrollmentRepository;
}

/**
 * A campaign automatically becomes 'completed' once every one of its enrollments has reached a
 * terminal state (completed, or any stopped_* status) -- Section 14.1's campaign status enum
 * lists 'completed', but until now nothing ever set it. Requires at least one enrollment to exist
 * (a freshly started campaign nobody has enrolled anyone into yet must stay 'running', not flip to
 * 'completed' the instant it's started), and only ever transitions a campaign that is currently
 * 'running' -- a 'paused' campaign is left alone here on purpose, since resuming it should still
 * see its own enrollments through rather than having already been silently marked done while
 * paused.
 *
 * Also requires no outstanding pending/claimed send_queue row for any of this campaign's
 * enrollments. An enrollment's own status can already read "completed" the instant its last step
 * is enqueued (Section 14.3: queuing, not delivery, advances that state machine) -- well before
 * the Send worker actually dispatches it, especially with a configured send-pacing delay holding
 * it in the queue. Without this check, a real campaign could flip straight from 'running' to
 * 'completed' within moments of being started, before a single email had actually gone out --
 * which both misreports 100% completion with nothing sent, and (since Pause/Resume only render
 * for 'running'/'paused') makes a still-in-flight campaign look like it has no controls left.
 *
 * Called from the two places an enrollment actually reaches a terminal state:
 * fireEnrollmentStep (its last step completing) and stopEnrollmentsForContact (a
 * reply/bounce/suppression/manual stop) -- there's no need for a separate periodic sweep for this.
 */
export async function maybeCompleteCampaign(deps: MaybeCompleteCampaignDeps, campaignId: CampaignId): Promise<boolean> {
  const campaign = await deps.campaignRepository.findById(campaignId);
  if (!campaign || campaign.status !== "running") return false;

  const enrollments = await deps.enrollmentRepository.listByCampaign(campaignId);
  if (enrollments.length === 0) return false;
  if (enrollments.some((e) => e.status === "active")) return false;

  const enrollmentIds = enrollments.map((e) => e.id);
  const outstandingQueuedCount = deps.db
    .select()
    .from(sendQueue)
    .innerJoin(messages, eq(sendQueue.messageId, messages.id))
    .where(and(inArray(messages.campaignEnrollmentId, enrollmentIds), inArray(sendQueue.status, ["pending", "claimed"])))
    .all().length;
  if (outstandingQueuedCount > 0) return false;

  await deps.campaignRepository.setStatus(campaignId, "completed");
  return true;
}
