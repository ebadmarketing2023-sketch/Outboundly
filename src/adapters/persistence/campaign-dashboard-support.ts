import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { EnrollmentStatus } from "../../core/campaigns/campaign.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { OutboundlyDb } from "./db.js";
import { events, messages, sendQueue } from "./schema.js";

const TERMINAL_ENROLLMENT_STATUSES: ReadonlySet<EnrollmentStatus> = new Set([
  "completed",
  "stopped_reply",
  "stopped_bounce",
  "stopped_manual",
  "stopped_suppressed"
]);

export interface CampaignDashboardEntry {
  id: string;
  name: string;
  status: string;
  totalLeads: number;
  emailsSent: number;
  /** Currently pending or claimed send_queue rows for this campaign's messages -- concretely
   * "how many emails are still queued to go out," not a step-count projection. */
  emailsRemaining: number;
  replies: number;
  replyRatePercent?: number;
  /** Percentage of this campaign's enrollments that have reached a terminal state (completed or
   * any stopped_* status), independent of the campaign's own running/paused status. */
  completionPercent: number;
  lastActivityAt?: Date;
  createdAt: Date;
}

export interface CampaignDashboardDeps {
  db: OutboundlyDb;
  campaignRepository: CampaignRepository;
  enrollmentRepository: EnrollmentRepository;
}

/**
 * Campaign dashboard list (Critical Improvement #4): one row per campaign with the metrics a real
 * outbound platform's campaign list shows, computed in one pass per campaign rather than requiring
 * a separate getCampaignAnalytics round-trip per row.
 *
 * emailsSent/replies/replyRatePercent are computed live from messages/events here, not from the
 * periodic rollup tables the deeper Analytics screen (getCampaignAnalytics) uses -- this is the
 * screen someone is actively watching right after sending or receiving a reply, and the rollup
 * worker only recomputes every few minutes (and, before a fix, only after a full hour on a fresh
 * app start). A dashboard that shows 0 replies for minutes after a real reply arrived reads as
 * broken, so this one avoids that lag entirely; the trade-off (a few more small live queries per
 * row) is fine at the scale a single-user desktop app's campaign list runs at.
 */
export async function getCampaignDashboard(deps: CampaignDashboardDeps): Promise<CampaignDashboardEntry[]> {
  const campaigns = await deps.campaignRepository.list();

  const entries: CampaignDashboardEntry[] = [];
  for (const campaign of campaigns) {
    const enrollments = await deps.enrollmentRepository.listByCampaign(campaign.id);
    const enrollmentIds = enrollments.map((e) => e.id);

    const outstandingQueuedRows =
      enrollmentIds.length === 0
        ? []
        : deps.db
            .select({ enrollmentId: messages.campaignEnrollmentId })
            .from(sendQueue)
            .innerJoin(messages, eq(sendQueue.messageId, messages.id))
            .where(and(inArray(messages.campaignEnrollmentId, enrollmentIds), inArray(sendQueue.status, ["pending", "claimed"])))
            .all();
    const emailsRemaining = outstandingQueuedRows.length;
    // An enrollment's own status can already read "completed" the instant its last email is
    // enqueued (Section 14.3: queuing, not delivery, advances the state machine) -- well before
    // the Send worker actually dispatches it, especially now that a configured send delay can hold
    // it in the queue for a while. Counting that enrollment as "done" here would show 100%
    // completion with zero emails actually sent, which is exactly backwards.
    const outstandingEnrollmentIds = new Set(outstandingQueuedRows.map((r) => r.enrollmentId));

    const sentMessages =
      enrollmentIds.length === 0
        ? []
        : deps.db
            .select()
            .from(messages)
            .where(and(inArray(messages.campaignEnrollmentId, enrollmentIds), eq(messages.direction, "outbound"), isNotNull(messages.sentAt)))
            .all();
    const lastActivityAt = sentMessages.reduce<Date | undefined>(
      (latest, m) => (m.sentAt && (!latest || m.sentAt > latest) ? m.sentAt : latest),
      undefined
    );
    const emailsSent = sentMessages.length;

    const repliesCount = deps.db
      .select()
      .from(events)
      .where(and(eq(events.campaignId, campaign.id), eq(events.eventType, "replied"), isNotNull(events.occurredAt)))
      .all().length;

    const terminalCount = enrollments.filter(
      (e) => TERMINAL_ENROLLMENT_STATUSES.has(e.status) && !outstandingEnrollmentIds.has(e.id)
    ).length;
    const completionPercent = enrollments.length === 0 ? 0 : Math.round((terminalCount / enrollments.length) * 100);

    entries.push({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      totalLeads: enrollments.length,
      emailsSent,
      emailsRemaining,
      replies: repliesCount,
      replyRatePercent: emailsSent === 0 ? undefined : Math.round((repliesCount / emailsSent) * 100),
      completionPercent,
      lastActivityAt,
      createdAt: campaign.createdAt
    });
  }

  return entries;
}
