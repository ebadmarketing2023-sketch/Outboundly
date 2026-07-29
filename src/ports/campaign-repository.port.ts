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
  /** Cascades safely regardless of how many leads the campaign has (Section 14.2):
   * campaign_enrollments.campaign_id is a real FK, so a raw delete would otherwise throw. This
   * cancels any outstanding queued sends for the campaign's enrollments, removes the enrollment
   * rows, then the campaign, all in one transaction -- sent messages and their analytics history
   * are untouched (messages.campaignEnrollmentId has no real FK precisely so historical rows can
   * safely outlive the campaign that produced them). */
  delete(id: CampaignId): Promise<void>;
}
