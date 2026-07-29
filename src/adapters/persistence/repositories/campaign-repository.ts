import { and, eq, inArray } from "drizzle-orm";
import type { Campaign, CampaignStatus, NewCampaignInput } from "../../../core/campaigns/campaign.js";
import { asAccountId, asCampaignId, asSequenceId, generateId, type CampaignId } from "../../../core/shared-kernel/ids.js";
import type { CampaignRepository, UpdateCampaignInput } from "../../../ports/campaign-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import {
  campaigns as campaignsTable,
  campaignEnrollments,
  campaignMetricsRollup,
  delayPolicyConfigs,
  errorLogs,
  events,
  messages,
  notifications,
  sendQueue
} from "../schema.js";

type CampaignRow = typeof campaignsTable.$inferSelect;

function toDomain(row: CampaignRow): Campaign {
  return {
    id: asCampaignId(row.id),
    name: row.name,
    sequenceId: asSequenceId(row.sequenceId),
    sendingAccountIds: row.sendingAccountIds.map(asAccountId),
    businessHoursProfileId: row.businessHoursProfileId,
    warmupProfileId: row.warmupProfileId ?? undefined,
    delayPolicyId: row.delayPolicyId ?? undefined,
    status: row.status as CampaignStatus,
    dailyLimitOverride: row.dailyLimitOverride ?? undefined,
    createdAt: row.createdAt
  };
}

/** SQLite-backed implementation of CampaignRepository (Section 5.6, Section 14.1). */
export class SqliteCampaignRepository implements CampaignRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewCampaignInput): Promise<Campaign> {
    const id = generateId();
    this.db
      .insert(campaignsTable)
      .values({
        id,
        name: input.name,
        sequenceId: input.sequenceId,
        sendingAccountIds: input.sendingAccountIds,
        businessHoursProfileId: input.businessHoursProfileId,
        warmupProfileId: input.warmupProfileId,
        delayPolicyId: input.delayPolicyId,
        status: "draft",
        dailyLimitOverride: input.dailyLimitOverride,
        createdAt: new Date()
      })
      .run();
    const row = this.db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).get();
    return toDomain(row!);
  }

  async findById(id: CampaignId): Promise<Campaign | undefined> {
    const row = this.db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  async list(): Promise<Campaign[]> {
    return this.db.select().from(campaignsTable).all().map(toDomain);
  }

  async setStatus(id: CampaignId, status: CampaignStatus): Promise<void> {
    this.db.update(campaignsTable).set({ status }).where(eq(campaignsTable.id, id)).run();
  }

  async update(id: CampaignId, patch: UpdateCampaignInput): Promise<Campaign> {
    this.db
      .update(campaignsTable)
      .set({ name: patch.name, businessHoursProfileId: patch.businessHoursProfileId })
      .where(eq(campaignsTable.id, id))
      .run();
    const row = this.db.select().from(campaignsTable).where(eq(campaignsTable.id, id)).get();
    if (!row) throw new Error(`Campaign ${id} not found`);
    return toDomain(row);
  }

  /** Deleting a campaign that already has enrollments used to be refused outright (Section 5.6's
   * FK on campaign_enrollments.campaign_id would otherwise reject the raw delete) -- but a user
   * needs to be able to remove a campaign they're done with regardless of how many leads it ever
   * had. This cancels any outstanding pending/claimed send_queue rows for the campaign's
   * enrollments (so the Send worker never tries to dispatch a message for a campaign that no
   * longer exists), then removes the enrollment rows, then the campaign itself -- all in one real
   * transaction (Database Integrity, Critical Improvement #13) so a crash partway through can't
   * leave the campaign gone but its enrollments/queued sends still dangling, or vice versa. Sent
   * messages and analytics history are untouched: messages.campaignEnrollmentId has no real FK
   * (Section 5.3) specifically so historical message rows can safely outlive the enrollment (and
   * now the campaign) that produced them.
   *
   * A real reported bug: this used to stop there, but any campaign that had actually run for a
   * while has also accumulated campaign_metrics_rollup rows (Section 20's periodic rollup worker)
   * and events rows (Section 20.1's event log) with a *real, enforced* FK on campaigns.id (unlike
   * messages.campaignEnrollmentId above) -- `foreign_keys = ON` (db.ts), so deleting the campaign
   * row while those children still reference it threw "FOREIGN KEY constraint failed" and the
   * delete silently never happened. A brand-new "Q2 Draft Outreach"-style campaign with no
   * events/rollups yet deleted fine, which is exactly why this only ever showed up on "old"
   * campaigns that had actually sent mail. campaign_metrics_rollup rows are deleted outright (Section
   * 20's own docblock: always safely regenerable from the event log, and meaningless once the
   * campaign is gone); events/notifications/error_log rows are kept but detached (campaignId set to
   * null) since those are real historical/audit records that outlive the campaign that produced
   * them, same reasoning as the message rows above -- and every one of those columns is nullable. */
  async delete(id: CampaignId): Promise<void> {
    this.db.transaction((tx) => {
      const enrollmentRows = tx.select({ id: campaignEnrollments.id }).from(campaignEnrollments).where(eq(campaignEnrollments.campaignId, id)).all();
      const enrollmentIds = enrollmentRows.map((r) => r.id);

      if (enrollmentIds.length > 0) {
        const outstandingQueueRows = tx
          .select({ id: sendQueue.id })
          .from(sendQueue)
          .innerJoin(messages, eq(sendQueue.messageId, messages.id))
          .where(and(inArray(messages.campaignEnrollmentId, enrollmentIds), inArray(sendQueue.status, ["pending", "claimed"])))
          .all();
        const outstandingQueueIds = outstandingQueueRows.map((r) => r.id);
        if (outstandingQueueIds.length > 0) {
          tx.update(sendQueue).set({ status: "cancelled" }).where(inArray(sendQueue.id, outstandingQueueIds)).run();
        }
        tx.delete(campaignEnrollments).where(eq(campaignEnrollments.campaignId, id)).run();
      }

      tx.delete(campaignMetricsRollup).where(eq(campaignMetricsRollup.campaignId, id)).run();
      tx.update(events).set({ campaignId: null }).where(eq(events.campaignId, id)).run();
      tx.update(notifications).set({ relatedCampaignId: null }).where(eq(notifications.relatedCampaignId, id)).run();
      tx.update(errorLogs).set({ campaignId: null }).where(eq(errorLogs.campaignId, id)).run();
      tx.delete(delayPolicyConfigs).where(eq(delayPolicyConfigs.campaignId, id)).run();

      tx.delete(campaignsTable).where(eq(campaignsTable.id, id)).run();
    });
  }
}
