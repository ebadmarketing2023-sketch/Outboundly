import { parseNamedAddress } from "../../core/shared-kernel/email-address.js";
import type { EnrollmentId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { CampaignEnrollment } from "../../core/campaigns/campaign.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";

export type StopReason = "stopped_reply" | "stopped_bounce" | "stopped_manual" | "stopped_suppressed";

export interface StopEnrollmentsDeps {
  enrollmentRepository: EnrollmentRepository;
  campaignRepository: CampaignRepository;
  sequenceRepository: SequenceRepository;
}

/**
 * Fans a stop event out to every active enrollment a contact has, across every campaign (Section
 * 14.3) — a reply/bounce/suppression is a fact about the contact, not about a single campaign.
 * stopped_reply/stopped_bounce respect the current step's own stopOnReply/stopOnBounce flag
 * (Section 5.6) first; stopped_manual/stopped_suppressed always apply unconditionally (a user
 * override or a compliance requirement, not a per-step content decision).
 */
export async function stopEnrollmentsForContact(
  deps: StopEnrollmentsDeps,
  contactId: CampaignEnrollment["contactId"],
  reason: StopReason
): Promise<EnrollmentId[]> {
  const active = await deps.enrollmentRepository.findActiveByContact(contactId);
  const stopped: EnrollmentId[] = [];

  for (const enrollment of active) {
    if ((reason === "stopped_reply" || reason === "stopped_bounce") && !(await shouldStepStop(deps, enrollment, reason))) {
      continue;
    }
    await deps.enrollmentRepository.advance(enrollment.id, { status: reason, nextSendAt: undefined });
    stopped.push(enrollment.id);
  }

  return stopped;
}

async function shouldStepStop(
  deps: StopEnrollmentsDeps,
  enrollment: CampaignEnrollment,
  reason: "stopped_reply" | "stopped_bounce"
): Promise<boolean> {
  if (!enrollment.currentStepId) return true; // no step context — stop is the safe default

  const campaign = await deps.campaignRepository.findById(enrollment.campaignId);
  if (!campaign) return true;

  const sequence = await deps.sequenceRepository.findById(campaign.sequenceId);
  const step = sequence?.steps.find((s) => s.id === enrollment.currentStepId);
  if (!step) return true;

  return reason === "stopped_reply" ? step.stopOnReply : step.stopOnBounce;
}

export interface HandleReplyDetectedDeps extends StopEnrollmentsDeps {
  contactRepository: ContactRepository;
}

/** Resolves an inbound message's From address to a Contact and stops every active enrollment that
 * respects stopOnReply, wired to the real reply signal the Conversation Engine already produces
 * (sync-inbox.ts's onReplyDetected, Section 11). Silently a no-op for a From address that isn't a
 * known contact — not every reply comes from an enrolled lead. */
export async function handleReplyDetected(deps: HandleReplyDetectedDeps, fromHeader: string): Promise<EnrollmentId[]> {
  const email = parseNamedAddress(fromHeader).address.toString();
  const contact = await deps.contactRepository.findByEmail(email);
  if (!contact) return [];
  return stopEnrollmentsForContact(deps, contact.id, "stopped_reply");
}
