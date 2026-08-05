import type { ContactId, CampaignId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";
import type { SuppressionListRepository } from "../../ports/suppression-list.port.js";

/**
 * The single place an enrollment row gets created — shared by the manual contact picker, the
 * campaign-specific CSV upload (Critical Improvement #2), the batch picker and the creation wizard,
 * so every path enforces the same admission rules.
 *
 * Extracted out of the Electron main process so those rules are actually testable; the main process
 * keeps only the repository wiring.
 */

export interface EnrollContactsDeps {
  campaignRepository: CampaignRepository;
  sequenceRepository: SequenceRepository;
  contactRepository: ContactRepository;
  enrollmentRepository: EnrollmentRepository;
  suppressionListRepository: SuppressionListRepository;
}

export interface EnrollContactsRequest {
  campaignId: CampaignId;
  contactIds: ContactId[];
  /**
   * Lets a lead be enrolled in a second campaign while their first is still running. Off by
   * default, and deliberately so: two campaigns that share a lead list send that person two
   * unrelated cold emails from the same domain, sometimes minutes apart, and the recipient's
   * reading of that is "this company is spamming me" — a spam complaint costs the sending domain
   * far more than the extra touch could ever be worth. Nothing here stops enrolling a lead in
   * another campaign once the first has *finished*; the guard only looks at active enrollments.
   */
  allowConcurrentCampaigns?: boolean;
}

export interface EnrollContactsResult {
  enrolled: number;
  skipped: Array<{ contactId: string; reason: string }>;
}

const ALREADY_IN_THIS_CAMPAIGN = "Already actively enrolled in this campaign";

export async function enrollContactsIntoCampaign(
  deps: EnrollContactsDeps,
  request: EnrollContactsRequest
): Promise<EnrollContactsResult> {
  const campaign = await deps.campaignRepository.findById(request.campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const sequence = await deps.sequenceRepository.findById(campaign.sequenceId);
  if (!sequence || sequence.steps.length === 0) throw new Error("Campaign's sequence has no steps");
  const firstStep = sequence.steps[0]!;

  let enrolled = 0;
  const skipped: EnrollContactsResult["skipped"] = [];

  for (const contactId of request.contactIds) {
    const contact = await deps.contactRepository.findById(contactId);
    if (!contact) {
      skipped.push({ contactId, reason: "Contact not found" });
      continue;
    }
    if (await deps.suppressionListRepository.isSuppressed(contact.email)) {
      skipped.push({ contactId, reason: "Contact is on the suppression list" });
      continue;
    }

    const active = await deps.enrollmentRepository.findActiveByContact(contactId);
    if (active.some((e) => e.campaignId === campaign.id)) {
      skipped.push({ contactId, reason: ALREADY_IN_THIS_CAMPAIGN });
      continue;
    }
    if (!request.allowConcurrentCampaigns) {
      const elsewhere = active[0];
      if (elsewhere) {
        const other = await deps.campaignRepository.findById(elsewhere.campaignId);
        skipped.push({
          contactId,
          reason: `Already active in another campaign${other ? ` ("${other.name}")` : ""} — enrolling them here too would send this person two cold emails from you`
        });
        continue;
      }
    }

    try {
      await deps.enrollmentRepository.enroll({
        campaignId: campaign.id,
        contactId,
        currentStepId: firstStep.id,
        nextSendAt: new Date()
      });
      enrolled++;
    } catch {
      // Database Integrity (Critical Improvement #13): campaign_enrollments has a real partial
      // unique index on (campaign_id, contact_id) WHERE status = 'active', so a genuine race
      // between two overlapping enroll requests for the same contact (the check above passing for
      // both before either insert lands) throws here instead of silently creating a duplicate
      // active enrollment. Treated the same as losing the check above -- skip this one contact,
      // not the rest of the batch.
      skipped.push({ contactId, reason: ALREADY_IN_THIS_CAMPAIGN });
    }
  }

  return { enrolled, skipped };
}
