import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { replyRate, sumMetricCounts } from "../../core/analytics/rollup.js";
import type { EnrollmentStatus } from "../../core/campaigns/campaign.js";
import type { CampaignMetricsRollupRepository } from "../../ports/campaign-metrics-rollup.port.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { OutboundlyDb } from "./db.js";
import { messages, sendQueue } from "./schema.js";

// Same lookback window as getCampaignAnalytics (Section 20.5) -- wide enough to cover essentially
// all of a campaign's real history without querying the events log directly.
const ANALYTICS_LOOKBACK_DAYS = 365;

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
  campaignMetricsRollupRepository: CampaignMetricsRollupRepository;
}

/**
 * Campaign dashboard list (Critical Improvement #4): one row per campaign with the metrics a real
 * outbound platform's campaign list shows, computed in one pass per campaign rather than requiring
 * a separate getCampaignAnalytics round-trip per row.
 */
export async function getCampaignDashboard(deps: CampaignDashboardDeps, now: Date): Promise<CampaignDashboardEntry[]> {
  const campaigns = await deps.campaignRepository.list();
  const since = new Date(now.getTime() - ANALYTICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const entries: CampaignDashboardEntry[] = [];
  for (const campaign of campaigns) {
    const enrollments = await deps.enrollmentRepository.listByCampaign(campaign.id);
    const enrollmentIds = enrollments.map((e) => e.id);

    const buckets = await deps.campaignMetricsRollupRepository.findInWindow(campaign.id, since, now);
    const totals = sumMetricCounts(buckets);

    const emailsRemaining =
      enrollmentIds.length === 0
        ? 0
        : deps.db
            .select()
            .from(sendQueue)
            .innerJoin(messages, eq(sendQueue.messageId, messages.id))
            .where(and(inArray(messages.campaignEnrollmentId, enrollmentIds), inArray(sendQueue.status, ["pending", "claimed"])))
            .all().length;

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

    const terminalCount = enrollments.filter((e) => TERMINAL_ENROLLMENT_STATUSES.has(e.status)).length;
    const completionPercent = enrollments.length === 0 ? 0 : Math.round((terminalCount / enrollments.length) * 100);
    const rate = replyRate(totals);

    entries.push({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      totalLeads: enrollments.length,
      emailsSent: totals.sentCount,
      emailsRemaining,
      replies: totals.repliedCount,
      replyRatePercent: rate !== undefined ? Math.round(rate * 100) : undefined,
      completionPercent,
      lastActivityAt,
      createdAt: campaign.createdAt
    });
  }

  return entries;
}
