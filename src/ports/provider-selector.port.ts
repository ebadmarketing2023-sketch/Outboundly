import type { AccountId, CampaignId } from "../core/shared-kernel/ids.js";

export type RotationStrategy = "round-robin" | "least-recently-used" | "health-weighted";

export interface ProviderSelectionInput {
  /** The Scheduler's proposed account (Section 15.4) — tried first, since it already passed the
   * Scheduling Policy Engine's warm-up/rate-limit checks and the Queue's authoritative RateLimiter. */
  candidateAccountId: AccountId;
  /** campaign.sending_account_ids (Section 14.4) — the full pool this send is allowed to rotate
   * within. Ignored (single-account send) when it contains only candidateAccountId. */
  rotationPool: AccountId[];
  /** Accounts already known ineligible before this call (e.g. the Scheduler's own
   * rejectedAccountIds) — skipped without re-checking. */
  excludedAccountIds: AccountId[];
  strategy: RotationStrategy;
  campaignId?: CampaignId;
}

export type ProviderSelectionResult =
  | { selected: true; accountId: AccountId; substituted: boolean }
  | { selected: false; reason: string };

/** Resolves the final concrete sending account for a rate-limiter-approved message (Section 16.3)
 * — the "confirm late" half of the propose-early/confirm-late pattern (Section 15.4). Substitutes
 * the next eligible account from the same rotation pool when the Scheduler's original proposal is
 * no longer eligible by dispatch time (disconnected, newly critical, unexpectedly over quota),
 * rather than failing the send outright. */
export interface ProviderSelector {
  select(input: ProviderSelectionInput): Promise<ProviderSelectionResult>;
}
