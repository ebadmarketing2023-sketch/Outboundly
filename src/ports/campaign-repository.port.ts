import type { Campaign, CampaignStatus, NewCampaignInput } from "../core/campaigns/campaign.js";
import type { CampaignId } from "../core/shared-kernel/ids.js";

export interface CampaignRepository {
  create(input: NewCampaignInput): Promise<Campaign>;
  findById(id: CampaignId): Promise<Campaign | undefined>;
  list(): Promise<Campaign[]>;
  setStatus(id: CampaignId, status: CampaignStatus): Promise<void>;
}
