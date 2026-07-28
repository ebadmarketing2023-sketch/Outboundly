import type { WarmupProfile } from "../core/scheduling/types.js";
import type { AccountId } from "../core/shared-kernel/ids.js";

export interface NewWarmupProfileInput {
  accountId: AccountId;
  startDate: Date;
  rampSchedule: Record<string, number>;
  currentDailyCap: number;
}

/** Warm-up Profile persistence (Section 5.7) — configuration the Scheduling Policy Engine's
 * Warm-up Policy reads from (the policy derives the live cap from rampSchedule itself, Section
 * 15.2; currentDailyCap is stored for display purposes only). */
export interface WarmupProfileRepository {
  create(input: NewWarmupProfileInput): Promise<WarmupProfile>;
  findByAccountId(accountId: AccountId): Promise<WarmupProfile | undefined>;
}
