import type { Campaign, CampaignStatus, NewCampaignInput } from "../core/campaigns/campaign.js";
import type { CampaignId } from "../core/shared-kernel/ids.js";

export interface UpdateCampaignInput {
  name: string;
  businessHoursProfileId: string;
}

export interface CampaignRepository {
  create(input: NewCampaignInput): Promise<Campaign>;
  findById(id: CampaignId): Promise<Campaign | undefined>;
  list(): Promise<Campaign[]>;
  setStatus(id: CampaignId, status: CampaignStatus): Promise<void>;
  /** Deliberately narrow (Section 14.1): renaming or switching the business-hours profile is safe
   * at any point. Changing the sequence or sending accounts once leads may already be enrolled has
   * much bigger implications (mid-flight personalization/attribution changes) and isn't supported
   * here -- pause and create a new campaign instead. */
  update(id: CampaignId, patch: UpdateCampaignInput): Promise<Campaign>;
  /** The caller is responsible for checking the campaign has no enrollments first (Section 14.2):
   * campaign_enrollments.campaign_id is a real FK, so this throws if any still reference it --
   * deleting a campaign with real send history would either violate that constraint or require
   * cascading through enrollments/messages, which would destroy analytics history this app exists
   * to preserve. Delete is for an unused draft only; pause a campaign with real history instead. */
  delete(id: CampaignId): Promise<void>;
}
