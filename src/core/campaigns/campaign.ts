import type { AccountId, CampaignId, ContactId, EnrollmentId, SequenceId, SequenceStepId } from "../shared-kernel/ids.js";

export type CampaignStatus = "draft" | "running" | "paused" | "completed";

/** A running instance of a sequence (Section 5.6, Section 14.1) — bound to sending accounts (for
 * rotation, Section 14.4) and scheduling policy configuration. */
export interface Campaign {
  id: CampaignId;
  name: string;
  sequenceId: SequenceId;
  sendingAccountIds: AccountId[];
  businessHoursProfileId: string;
  warmupProfileId?: string;
  delayPolicyId?: string;
  status: CampaignStatus;
  dailyLimitOverride?: number;
  createdAt: Date;
}

export interface NewCampaignInput {
  name: string;
  sequenceId: SequenceId;
  sendingAccountIds: AccountId[];
  businessHoursProfileId: string;
  warmupProfileId?: string;
  delayPolicyId?: string;
  dailyLimitOverride?: number;
}

export type EnrollmentStatus =
  | "active"
  | "stopped_reply"
  | "stopped_bounce"
  | "stopped_manual"
  | "stopped_suppressed"
  | "completed";

/** One contact's progress through one campaign (Section 14.2) — the actual state machine. */
export interface CampaignEnrollment {
  id: EnrollmentId;
  campaignId: CampaignId;
  contactId: ContactId;
  currentStepId?: SequenceStepId;
  status: EnrollmentStatus;
  nextSendAt?: Date;
  enrolledAt: Date;
  updatedAt: Date;
}
