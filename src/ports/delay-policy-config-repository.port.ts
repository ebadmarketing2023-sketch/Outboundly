import type { DelayPolicyConfig } from "../core/scheduling/types.js";
import type { CampaignId } from "../core/shared-kernel/ids.js";

export interface NewDelayPolicyConfigInput {
  campaignId?: CampaignId;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  jitterStrategy: "uniform";
}

/** Delay Policy configuration persistence (Section 5.7) — the Scheduling Policy Engine's Delay
 * Policy reads from this. */
export interface DelayPolicyConfigRepository {
  create(input: NewDelayPolicyConfigInput): Promise<DelayPolicyConfig>;
  findByCampaignId(campaignId: CampaignId): Promise<DelayPolicyConfig | undefined>;
}
