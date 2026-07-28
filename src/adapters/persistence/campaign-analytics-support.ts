import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { bounceRate, deliveryRate, positiveReplyRate, replyRate, sumMetricCounts } from "../../core/analytics/rollup.js";
import type { CampaignId } from "../../core/shared-kernel/ids.js";
import type { CampaignMetricsRollupRepository } from "../../ports/campaign-metrics-rollup.port.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";
import type { OutboundlyDb } from "./db.js";
import { messages } from "./schema.js";

// Wide enough to cover essentially all of a campaign's real history for the "minimal" campaign
// dashboard (Section 20.5) without querying the events log directly, matching Section 20.1's rule
// that dashboards read only the materialized rollup tables.
const ANALYTICS_LOOKBACK_DAYS = 365;

export interface StepFunnelEntry {
  stepOrder: number;
  templateId: string;
  sentCount: number;
}

export interface StopReasonBreakdown {
  active: number;
  completed: number;
  stopped_reply: number;
  stopped_bounce: number;
  stopped_manual: number;
  stopped_suppressed: number;
}

export interface CampaignAnalyticsSummary {
  sentCount: number;
  bouncedCount: number;
  repliedCount: number;
  positiveReplyCount: number;
  unsubscribedCount: number;
  conversionCount: number;
  replyRate?: number;
  positiveReplyRate?: number;
  bounceRate?: number;
  deliveryRate?: number;
  stepFunnel: StepFunnelEntry[];
  stopReasonBreakdown: StopReasonBreakdown;
}

export interface CampaignAnalyticsDeps {
  db: OutboundlyDb;
  campaignRepository: CampaignRepository;
  sequenceRepository: SequenceRepository;
  enrollmentRepository: EnrollmentRepository;
  campaignMetricsRollupRepository: CampaignMetricsRollupRepository;
}

/**
 * Campaign dashboard read model (Section 20.5): primary metrics (Section 20.2) from the
 * already-materialized rollup table, plus a per-step funnel and stop-reason breakdown computed
 * directly from messages/enrollments -- those two aren't rollup concerns (they're not daily
 * time-series metrics), so they don't belong in the rollup tables themselves.
 *
 * The step funnel attributes each snapshotted messages.templateId (Section 5.9) back to the
 * sequence step that uses that template. This is exact when a sequence doesn't reuse the same
 * template across multiple steps -- the common case -- and is a documented limitation, not a
 * silent inaccuracy, when it does.
 */
export async function getCampaignAnalytics(deps: CampaignAnalyticsDeps, campaignId: CampaignId, now: Date): Promise<CampaignAnalyticsSummary> {
  const campaign = await deps.campaignRepository.findById(campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);

  const since = new Date(now.getTime() - ANALYTICS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const buckets = await deps.campaignMetricsRollupRepository.findInWindow(campaignId, since, now);
  const totals = sumMetricCounts(buckets);

  const enrollments = await deps.enrollmentRepository.listByCampaign(campaignId);
  const stopReasonBreakdown: StopReasonBreakdown = {
    active: 0,
    completed: 0,
    stopped_reply: 0,
    stopped_bounce: 0,
    stopped_manual: 0,
    stopped_suppressed: 0
  };
  for (const enrollment of enrollments) {
    stopReasonBreakdown[enrollment.status]++;
  }

  const sequence = await deps.sequenceRepository.findById(campaign.sequenceId);
  const steps = sequence?.steps ?? [];
  const enrollmentIds = enrollments.map((e) => e.id);
  const sentMessages =
    enrollmentIds.length === 0
      ? []
      : deps.db
          .select()
          .from(messages)
          .where(and(inArray(messages.campaignEnrollmentId, enrollmentIds), eq(messages.direction, "outbound"), isNotNull(messages.templateId)))
          .all();

  const sentCountByTemplateId = new Map<string, number>();
  for (const message of sentMessages) {
    if (!message.templateId) continue;
    sentCountByTemplateId.set(message.templateId, (sentCountByTemplateId.get(message.templateId) ?? 0) + 1);
  }
  const stepFunnel: StepFunnelEntry[] = [...steps]
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((step) => ({ stepOrder: step.stepOrder, templateId: step.templateId, sentCount: sentCountByTemplateId.get(step.templateId) ?? 0 }));

  return {
    sentCount: totals.sentCount,
    bouncedCount: totals.bouncedCount,
    repliedCount: totals.repliedCount,
    positiveReplyCount: totals.positiveReplyCount,
    unsubscribedCount: totals.unsubscribedCount,
    conversionCount: totals.conversionCount,
    replyRate: replyRate(totals),
    positiveReplyRate: positiveReplyRate(totals),
    bounceRate: bounceRate(totals),
    deliveryRate: deliveryRate(totals),
    stepFunnel,
    stopReasonBreakdown
  };
}
