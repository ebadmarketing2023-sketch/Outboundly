import type { CampaignEnrollment, EnrollmentStatus } from "../core/campaigns/campaign.js";
import type { CampaignId, ContactId, EnrollmentId, SequenceStepId } from "../core/shared-kernel/ids.js";

export interface NewEnrollmentInput {
  campaignId: CampaignId;
  contactId: ContactId;
  currentStepId: SequenceStepId;
  nextSendAt: Date;
}

export interface AdvanceEnrollmentInput {
  currentStepId?: SequenceStepId;
  nextSendAt?: Date;
  status?: EnrollmentStatus;
}

/** Enrollment state machine persistence (Section 14.2). findDueForScheduling is the hot path the
 * Scheduler tick worker polls (Section 5.10, Section 21.1) — backed by the
 * (status, next_send_at) index on campaign_enrollments. */
export interface EnrollmentRepository {
  enroll(input: NewEnrollmentInput): Promise<CampaignEnrollment>;
  findById(id: EnrollmentId): Promise<CampaignEnrollment | undefined>;
  findActiveByCampaignAndContact(campaignId: CampaignId, contactId: ContactId): Promise<CampaignEnrollment | undefined>;
  listByCampaign(campaignId: CampaignId): Promise<CampaignEnrollment[]>;
  findDueForScheduling(now: Date): Promise<CampaignEnrollment[]>;
  advance(id: EnrollmentId, patch: AdvanceEnrollmentInput): Promise<void>;
  /** Every currently-active enrollment for a contact across all campaigns — used to fan out a
   * ReplyDetected/BounceDetected/UnsubscribeRequested event to every campaign it should stop
   * (Section 14.3), since a contact can be enrolled in more than one campaign at once. */
  findActiveByContact(contactId: ContactId): Promise<CampaignEnrollment[]>;
}
