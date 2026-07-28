import { eq } from "drizzle-orm";
import type { WarmupProfile } from "../../../core/scheduling/types.js";
import { asAccountId, generateId } from "../../../core/shared-kernel/ids.js";
import type { AccountId } from "../../../core/shared-kernel/ids.js";
import type { NewWarmupProfileInput, WarmupProfileRepository } from "../../../ports/warmup-profile-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { warmupProfiles } from "../schema.js";

type WarmupProfileRow = typeof warmupProfiles.$inferSelect;

function toDomain(row: WarmupProfileRow): WarmupProfile {
  return {
    id: row.id,
    accountId: asAccountId(row.accountId),
    startDate: row.startDate,
    rampSchedule: row.rampScheduleJson,
    currentDailyCap: row.currentDailyCap
  };
}

/** SQLite-backed implementation of WarmupProfileRepository (Section 5.7). */
export class SqliteWarmupProfileRepository implements WarmupProfileRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewWarmupProfileInput): Promise<WarmupProfile> {
    const id = generateId();
    this.db
      .insert(warmupProfiles)
      .values({
        id,
        accountId: input.accountId,
        startDate: input.startDate,
        rampScheduleJson: input.rampSchedule,
        currentDailyCap: input.currentDailyCap
      })
      .run();
    const row = this.db.select().from(warmupProfiles).where(eq(warmupProfiles.id, id)).get();
    return toDomain(row!);
  }

  async findByAccountId(accountId: AccountId): Promise<WarmupProfile | undefined> {
    const row = this.db.select().from(warmupProfiles).where(eq(warmupProfiles.accountId, accountId)).get();
    return row ? toDomain(row) : undefined;
  }
}
