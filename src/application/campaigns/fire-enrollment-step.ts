import { evaluateGmailCompatibility, hasBlockingFindings as hasBlockingCompatibilityFindings } from "../../core/gmail-compatibility/engine.js";
import type { CompatibilityReport } from "../../core/gmail-compatibility/types.js";
import { evaluateDeliverability, hasBlockingFindings as hasBlockingDeliverabilityFindings } from "../../core/deliverability/engine.js";
import type { DeliverabilityReport } from "../../core/deliverability/types.js";
import { getAccountRef, buildSchedulingContext, type BuildSchedulingContextDeps } from "../../adapters/persistence/campaign-scheduling-support.js";
import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import { enqueueAndAdvanceEnrollment } from "../../adapters/persistence/enqueue-and-advance-support.js";
import type { CampaignEnrollment } from "../../core/campaigns/campaign.js";
import { contactToPersonalizationValues } from "../../core/campaigns/personalize.js";
import { selectWeightedVariant } from "../../core/campaigns/variant-selection.js";
import type { Document } from "../../core/rendering/document-model.js";
import { MissingPersonalizationValueError } from "../../core/rendering/document-model.js";
import { extractPlainAndHtmlBodies } from "../../core/mime/mime-generator.js";
import { findHeaderValue } from "../../core/mime/headers.js";
import { EmailAddress, formatNamedAddress, type NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import { schedule } from "../../core/scheduling/scheduler.js";
import { NoEligibleAccountError } from "../../core/scheduling/types.js";
import { asMessageId, type AccountId, type SendQueueId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import type { DeliverabilityReportRepository } from "../../ports/deliverability-report-repository.port.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import type { AdvanceEnrollmentInput, EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { ErrorLogRepository } from "../../ports/error-log-repository.port.js";
import type { SendQueueRepository } from "../../ports/send-queue-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";
import type { SubjectVariantRepository } from "../../ports/subject-variant-repository.port.js";
import type { SuppressionListRepository } from "../../ports/suppression-list.port.js";
import type { TemplateRepository } from "../../ports/template-repository.port.js";
import type { TemplateVariantRepository } from "../../ports/template-variant-repository.port.js";
import { ingestMessage } from "../sync-inbox/ingest-message.js";
import { maybeCompleteCampaign } from "./maybe-complete-campaign.js";
import { stopEnrollmentsForContact } from "./stop-enrollments.js";

export type FireEnrollmentStepResult =
  | { outcome: "enqueued"; sendQueueEntryId: SendQueueId; scheduledFor: Date; accountId: AccountId; enrollmentStatus: "active" | "completed" }
  | { outcome: "blocked"; compatibilityReport: CompatibilityReport; deliverabilityReport?: DeliverabilityReport }
  | { outcome: "no_eligible_account" }
  | { outcome: "suppressed" }
  | { outcome: "missing_personalization"; variableName: string };

export interface FireEnrollmentStepDeps extends BuildSchedulingContextDeps {
  db: OutboundlyDb;
  campaignRepository: CampaignRepository;
  sequenceRepository: SequenceRepository;
  templateRepository: TemplateRepository;
  templateVariantRepository: TemplateVariantRepository;
  subjectVariantRepository: SubjectVariantRepository;
  contactRepository: ContactRepository;
  suppressionListRepository: SuppressionListRepository;
  enrollmentRepository: EnrollmentRepository;
  sendQueueRepository: SendQueueRepository;
  deliverabilityReportRepository: DeliverabilityReportRepository;
  conversationRepository: ConversationRepository;
  draftLifecycle: DraftLifecycleService;
  /** Optional (Critical Improvement #12): when provided, the scheduler tick's own per-enrollment
   * failure isolation also records a structured, queryable log entry. Omitted in most existing
   * tests since it's a pure side effect. */
  errorLogRepository?: ErrorLogRepository;
}

/**
 * Fires one due enrollment's current step (Section 14.3): resolves the contact/template/subject,
 * personalizes, runs the same Gmail Compatibility + Deliverability gate every message goes through
 * (Section 9.2 stages 12-13), proposes a send time/account via the Scheduling Policy Engine, and
 * enqueues a durable send_queue row -- the actual dispatch (RateLimiter -> Provider Selector ->
 * Provider Adapter) is the Send worker's job (Section 21.1), not this function's. On successful
 * enqueue, advances the enrollment to the next step (or completes it), matching Section 14.3's "on
 * successful queuing, next_send_at advances" rule precisely -- queuing, not actual delivery, is
 * what advances the state machine.
 */
export async function fireEnrollmentStep(
  deps: FireEnrollmentStepDeps,
  enrollment: CampaignEnrollment,
  now: Date
): Promise<FireEnrollmentStepResult> {
  const contact = await deps.contactRepository.findById(enrollment.contactId);
  if (!contact) throw new Error(`Enrollment ${enrollment.id} references a contact that no longer exists`);

  if (await deps.suppressionListRepository.isSuppressed(contact.email)) {
    await stopEnrollmentsForContact(deps, contact.id, "stopped_suppressed");
    return { outcome: "suppressed" };
  }

  const campaign = await deps.campaignRepository.findById(enrollment.campaignId);
  if (!campaign) throw new Error(`Enrollment ${enrollment.id} references a campaign that no longer exists`);

  const sequence = await deps.sequenceRepository.findById(campaign.sequenceId);
  if (!sequence) throw new Error(`Campaign ${campaign.id} references a sequence that no longer exists`);

  const stepIndex = sequence.steps.findIndex((s) => s.id === enrollment.currentStepId);
  if (stepIndex === -1) throw new Error(`Enrollment ${enrollment.id}'s current step is not part of its sequence`);
  const step = sequence.steps[stepIndex]!;
  const nextStep = sequence.steps[stepIndex + 1];
  const isFollowUpStep = stepIndex > 0;

  const template = await deps.templateRepository.findById(step.templateId);
  if (!template) throw new Error(`Sequence step ${step.id} references a template that no longer exists`);

  const subjectVariants = await deps.subjectVariantRepository.findByStepId(step.id);
  if (subjectVariants.length === 0) throw new Error(`Sequence step ${step.id} has no subject line configured`);
  const selectedSubjectVariant = selectWeightedVariant(subjectVariants);

  // Follow-up threading (Section 14.3): only the first step is a brand-new email. Every step
  // after that continues the original message's subject/thread as a reply instead of going out as
  // a fresh, unrelated email -- the step's own configured subject variant is still recorded
  // against subjectVariantId below for analytics (Section 5.9/20.5), it's just not what's put on
  // the wire once a prior send in this enrollment exists to reply onto.
  const priorMessages = isFollowUpStep ? await deps.conversationRepository.findOutboundMessageHistoryForEnrollment(enrollment.id) : [];
  const originalMessage = priorMessages[0];
  const mostRecentMessage = priorMessages[priorMessages.length - 1];
  const subjectText = originalMessage ? `Re: ${originalMessage.subject.replace(/^re:\s*/i, "")}` : selectedSubjectVariant.subjectText;
  const inReplyTo = mostRecentMessage?.messageIdHeader;
  const references = priorMessages.length > 0 ? priorMessages.map((m) => m.messageIdHeader) : undefined;

  const templateVariants = await deps.templateVariantRepository.findByTemplateId(template.id);
  const document: Document =
    templateVariants.length === 0 ? template.document : (selectWeightedVariant(templateVariants).documentOverride ?? template.document);

  let candidate;
  try {
    const ctx = await buildSchedulingContext(deps, campaign, now, contact.timezone);
    candidate = schedule(now, ctx);
  } catch (err) {
    if (err instanceof NoEligibleAccountError) return { outcome: "no_eligible_account" };
    throw err;
  }

  const accountRef = getAccountRef(deps.db, candidate.candidateAccountId);
  if (!accountRef) throw new Error(`Scheduled account ${candidate.candidateAccountId} no longer exists`);

  const from: NamedEmailAddress = { address: EmailAddress.parse(accountRef.emailAddress), displayName: accountRef.displayName };
  const to: NamedEmailAddress = {
    address: EmailAddress.parse(contact.email),
    displayName: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined
  };
  const sendingDomain = accountRef.emailAddress.split("@")[1]!;

  const draft = await deps.draftLifecycle.createDraft({
    accountId: candidate.candidateAccountId,
    subject: subjectText,
    document,
    to: [to],
    inReplyTo,
    references
  });

  let built;
  try {
    built = deps.draftLifecycle.buildMimeMessage(draft, {
      from,
      sendingDomain,
      personalizationValues: contactToPersonalizationValues(contact)
    });
  } catch (err) {
    if (err instanceof MissingPersonalizationValueError) {
      return { outcome: "missing_personalization", variableName: err.variableName };
    }
    throw err;
  }

  const compatibilityReport = evaluateGmailCompatibility(built);
  if (hasBlockingCompatibilityFindings(compatibilityReport)) {
    return { outcome: "blocked", compatibilityReport };
  }

  const bodies = extractPlainAndHtmlBodies(built.root);
  const deliverabilityReport = evaluateDeliverability({
    message: built,
    compatibilityReport,
    authenticatedAccountEmail: accountRef.emailAddress,
    bodyHtml: bodies.html,
    bodyText: bodies.text
  });

  await deps.deliverabilityReportRepository.save({
    scope: "message",
    campaignId: campaign.id,
    accountId: accountRef.accountId,
    generatedAt: now,
    report: deliverabilityReport
  });

  if (hasBlockingDeliverabilityFindings(deliverabilityReport)) {
    return { outcome: "blocked", compatibilityReport, deliverabilityReport };
  }

  const ingestResult = await ingestMessage(deps.conversationRepository, {
    accountId: candidate.candidateAccountId,
    direction: "outbound",
    messageIdHeader: findHeaderValue(built.headers, "Message-ID") ?? "",
    inReplyToHeader: findHeaderValue(built.headers, "In-Reply-To"),
    referencesHeader: findHeaderValue(built.headers, "References"),
    from: formatNamedAddress(from),
    to: [formatNamedAddress(to)],
    subject: subjectText,
    bodyHtml: bodies.html,
    bodyText: bodies.text,
    status: "queued",
    campaignEnrollmentId: enrollment.id,
    draftId: draft.id,
    templateId: template.id,
    subjectVariantId: selectedSubjectVariant.id,
    occurredAt: now
  });

  // Database Integrity (Critical Improvement #13): the queue insert and the enrollment advance are
  // the two writes that must never be split by a crash -- an enqueued send with no corresponding
  // advance would leave the enrollment due again on the very step that already queued a send, and
  // (absent send_queue's own idempotency key) an advance with no queue row would silently drop a
  // send. One real db.transaction() makes them succeed or fail together.
  let enrollmentStatus: "active" | "completed";
  let advancePatch: AdvanceEnrollmentInput;
  if (nextStep) {
    const nextSendAt = new Date(now.getTime() + nextStep.delayDays * 24 * 60 * 60 * 1000 + nextStep.delayHours * 60 * 60 * 1000);
    advancePatch = { currentStepId: nextStep.id, nextSendAt, status: "active" };
    enrollmentStatus = "active";
  } else {
    advancePatch = { status: "completed", nextSendAt: undefined };
    enrollmentStatus = "completed";
  }

  const queueEntry = enqueueAndAdvanceEnrollment(deps.db, {
    queue: {
      messageId: asMessageId(ingestResult.messageId!),
      accountId: candidate.candidateAccountId,
      priority: "campaign",
      earliestSendAt: candidate.proposedSendAt,
      idempotencyKey: `${enrollment.id}:${step.id}`
    },
    enrollmentId: enrollment.id,
    advance: advancePatch
  });

  if (!nextStep) await maybeCompleteCampaign(deps, enrollment.campaignId);

  return {
    outcome: "enqueued",
    sendQueueEntryId: queueEntry.id,
    scheduledFor: candidate.proposedSendAt,
    accountId: candidate.candidateAccountId,
    enrollmentStatus
  };
}
