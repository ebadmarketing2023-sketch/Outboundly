import { eq } from "drizzle-orm";
import type { DelayPolicyConfig } from "../../../core/scheduling/types.js";
import { asCampaignId, generateId } from "../../../core/shared-kernel/ids.js";
import type { CampaignId } from "../../../core/shared-kernel/ids.js";
import type {
  DelayPolicyConfigRepository,
  NewDelayPolicyConfigInput
} from "../../../ports/delay-policy-config-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { delayPolicyConfigs } from "../schema.js";

type DelayPolicyConfigRow = typeof delayPolicyConfigs.$inferSelect;

function toDomain(row: DelayPolicyConfigRow): DelayPolicyConfig {
  return {
    id: row.id,
    campaignId: row.campaignId ? asCampaignId(row.campaignId) : undefined,
    minDelaySeconds: row.minDelaySeconds,
    maxDelaySeconds: row.maxDelaySeconds,
    jitterStrategy: row.jitterStrategy as "uniform"
  };
}

/** SQLite-backed implementation of DelayPolicyConfigRepository (Section 5.7). */
export class SqliteDelayPolicyConfigRepository implements DelayPolicyConfigRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewDelayPolicyConfigInput): Promise<DelayPolicyConfig> {
    const id = generateId();
    this.db
      .insert(delayPolicyConfigs)
      .values({
        id,
        campaignId: input.campaignId,
        minDelaySeconds: input.minDelaySeconds,
        maxDelaySeconds: input.maxDelaySeconds,
        jitterStrategy: input.jitterStrategy
      })
      .run();
    const row = this.db.select().from(delayPolicyConfigs).where(eq(delayPolicyConfigs.id, id)).get();
    return toDomain(row!);
  }

  async findByCampaignId(campaignId: CampaignId): Promise<DelayPolicyConfig | undefined> {
    const row = this.db.select().from(delayPolicyConfigs).where(eq(delayPolicyConfigs.campaignId, campaignId)).get();
    return row ? toDomain(row) : undefined;
  }
}
