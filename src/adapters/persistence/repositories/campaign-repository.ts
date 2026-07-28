import { eq } from "drizzle-orm";
import type { Campaign, CampaignStatus, NewCampaignInput } from "../../../core/campaigns/campaign.js";
import { asAccountId, asCampaignId, asSequenceId, generateId, type CampaignId } from "../../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../../ports/campaign-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { campaigns as campaignsTable } from "../schema.js";

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
}
