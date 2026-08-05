import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import { looksLikeOptOutRequest } from "../../core/campaigns/opt-out-detection.js";
import { parseNamedAddress } from "../../core/shared-kernel/email-address.js";
import { asAccountId, asEnrollmentId, type CampaignId, type ContactId, type EnrollmentId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import type { CampaignEnrollment } from "../../core/campaigns/campaign.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { EventRepository } from "../../ports/event-repository.port.js";
import type { NotificationRepository } from "../../ports/notification-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";
import type { SuppressionListRepository } from "../../ports/suppression-list.port.js";
import { maybeCompleteCampaign } from "./maybe-complete-campaign.js";

export type StopReason = "stopped_reply" | "stopped_bounce" | "stopped_manual" | "stopped_suppressed";

export interface StopEnrollmentsDeps {
  db: OutboundlyDb;
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
    await maybeCompleteCampaign(deps, enrollment.campaignId);
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
  conversationRepository: ConversationRepository;
  eventRepository: EventRepository;
  notificationRepository: NotificationRepository;
  /** Optional so existing callers/tests that only care about the stop-on-reply behavior keep
   * working unchanged; when provided, an explicit opt-out request in the reply also suppresses the
   * contact globally (see below). */
  suppressionListRepository?: SuppressionListRepository;
}

/** The reply's own content, used only to detect an explicit opt-out request. */
export interface ReplyContent {
  subject: string;
  bodyText?: string;
}

/** Resolves an inbound message's From address to a Contact and stops every active enrollment that
 * respects stopOnReply, wired to the real reply signal the Conversation Engine already produces
 * (sync-inbox.ts's onReplyDetected, Section 11). Silently a no-op for a From address that isn't a
 * known contact — not every reply comes from an enrolled lead. Separately, if the reply threaded
 * back to one of our own campaign sends, records a 'replied' event attributed to that specific
 * campaign (Section 20.1) -- a narrower, thread-correlated attribution than the broad per-contact
 * fan-out stopEnrollmentsForContact performs, since accurate reply-rate analytics needs to know
 * which campaign got the reply, not just that this contact should stop hearing from all of them.
 * Always surfaces a 'reply_arrived' notification (Section 3) for a known contact, whether or not
 * the reply correlated to a campaign. */
export async function handleReplyDetected(
  deps: HandleReplyDetectedDeps,
  fromHeader: string,
  context: { threadId: string; accountId: string },
  replyContent?: ReplyContent
): Promise<EnrollmentId[]> {
  const email = parseNamedAddress(fromHeader).address.toString();
  const contact = await deps.contactRepository.findByEmail(email);
  if (!contact) return [];

  // An explicit "remove me" is a fact about the *contact*, not about the campaign they happened to
  // reply to: stopping only their current enrollments (what the stopped_reply path below does on
  // its own) would let the very next CSV import enroll and email them all over again. Suppressing
  // here is what actually honors the request across every future campaign. Reversible from the
  // Leads screen's suppressed-contacts list if the detector ever gets one wrong.
  const optedOut = replyContent ? looksLikeOptOutRequest(replyContent.subject, replyContent.bodyText) : false;

  const enrollmentId = await deps.conversationRepository.findCampaignEnrollmentIdForThread(context.threadId);
  let campaignId: CampaignId | undefined;
  if (enrollmentId) {
    const enrollment = await deps.enrollmentRepository.findById(asEnrollmentId(enrollmentId));
    if (enrollment) {
      campaignId = enrollment.campaignId;
      await deps.eventRepository.record({
        eventType: "replied",
        campaignId: enrollment.campaignId,
        accountId: asAccountId(context.accountId),
        occurredAt: new Date()
      });
    }
  }

  if (optedOut && deps.suppressionListRepository) {
    await deps.suppressionListRepository.add(contact.email, "unsubscribed");
    // Recorded with the same event type the manual unsubscribeContact path uses, so opt-outs
    // arriving by reply show up in the same analytics as ones clicked through the UI rather than
    // silently under-reporting the campaign's real unsubscribe rate.
    await deps.eventRepository.record({
      eventType: "unsubscribed",
      campaignId,
      accountId: asAccountId(context.accountId),
      occurredAt: new Date(),
      metadata: { contactId: contact.id, detectedFrom: "reply" }
    });
    await deps.notificationRepository.record({
      notificationType: "contact_opted_out",
      severity: "info",
      message: `${email} asked to be removed and was added to the suppression list`,
      relatedAccountId: asAccountId(context.accountId),
      relatedCampaignId: campaignId,
      createdAt: new Date()
    });
  }

  await deps.notificationRepository.record({
    notificationType: "reply_arrived",
    severity: "info",
    message: `${email} replied`,
    relatedAccountId: asAccountId(context.accountId),
    relatedCampaignId: campaignId,
    createdAt: new Date()
  });

  // An explicit removal request stops unconditionally (stopped_suppressed), bypassing the current
  // step's own stopOnReply flag -- a sequence deliberately configured to keep going through
  // replies must still honor "stop contacting me". An ordinary reply keeps the pre-existing
  // per-step behavior unchanged.
  return stopEnrollmentsForContact(deps, contact.id, optedOut ? "stopped_suppressed" : "stopped_reply");
}

export interface HandleBounceDetectedDeps extends StopEnrollmentsDeps {
  conversationRepository: ConversationRepository;
  eventRepository: EventRepository;
  contactRepository: ContactRepository;
}

/**
 * Resolves a bounce notification back to the contact whose delivery failed, records a 'bounced'
 * event for the campaign involved (Section 20.1), and stops every active enrollment that respects
 * stopOnBounce for that contact.
 *
 * Two ways of resolving it, in order:
 *   1. the thread it arrived on (findCampaignEnrollmentIdForThread), which works when the DSN
 *      threaded back to one of our own sends;
 *   2. failing that, the address the DSN itself names as having failed (RFC 3464 Final-Recipient).
 *
 * The fallback is not a nicety. Plenty of MTAs send a DSN as a brand-new message carrying the
 * original only as an attachment, with no In-Reply-To to thread on -- so correlating by thread
 * alone meant those bounces were ingested, matched nothing, and the campaign carried on mailing an
 * address that had already hard-bounced. Nothing about that is visible from inside the app, while
 * the sending domain's reputation pays for it.
 *
 * Still a no-op when neither route identifies a contact with an active enrollment.
 */
export async function handleBounceDetected(
  deps: HandleBounceDetectedDeps,
  threadId: string,
  accountId: string,
  failedRecipient?: string
): Promise<EnrollmentId[]> {
  const enrollment = (await enrollmentFromThread(deps, threadId)) ?? (await enrollmentFromRecipient(deps, failedRecipient));
  if (!enrollment) return [];

  await deps.eventRepository.record({
    eventType: "bounced",
    campaignId: enrollment.campaignId,
    accountId: asAccountId(accountId),
    occurredAt: new Date()
  });

  return stopEnrollmentsForContact(deps, enrollment.contactId, "stopped_bounce");
}

async function enrollmentFromThread(deps: HandleBounceDetectedDeps, threadId: string): Promise<CampaignEnrollment | undefined> {
  const enrollmentId = await deps.conversationRepository.findCampaignEnrollmentIdForThread(threadId);
  if (!enrollmentId) return undefined;
  return deps.enrollmentRepository.findById(asEnrollmentId(enrollmentId));
}

async function enrollmentFromRecipient(
  deps: HandleBounceDetectedDeps,
  failedRecipient: string | undefined
): Promise<CampaignEnrollment | undefined> {
  if (!failedRecipient) return undefined;
  const contact = await deps.contactRepository.findByEmail(failedRecipient.toLowerCase());
  if (!contact) return undefined;
  // Any one active enrollment is enough to attribute the 'bounced' event to a campaign;
  // stopEnrollmentsForContact then fans the stop out across every campaign this contact is in.
  const active = await deps.enrollmentRepository.findActiveByContact(contact.id);
  return active[0];
}

export interface UnsubscribeContactDeps extends StopEnrollmentsDeps {
  contactRepository: ContactRepository;
  suppressionListRepository: SuppressionListRepository;
  eventRepository: EventRepository;
}

/** Manual unsubscribe (Section 20.2, Section 22.3's suppression-aware enrollment) -- there is no
 * real unsubscribe-link infrastructure in this codebase (a click-tracked link needs a publicly
 * reachable server this local desktop app doesn't have), so this is the only real trigger point:
 * a user action, typically from the campaign whose email they clicked "unsubscribe" on, which is
 * why campaignId is accepted here for event attribution even though the resulting suppression is
 * global (Section 5.5) -- once suppressed, every campaign's own enrollment check skips them. */
export async function unsubscribeContact(
  deps: UnsubscribeContactDeps,
  contactId: ContactId,
  campaignId?: CampaignId,
  now: Date = new Date()
): Promise<EnrollmentId[]> {
  const contact = await deps.contactRepository.findById(contactId);
  if (!contact) throw new Error(`Contact ${contactId} not found`);

  await deps.suppressionListRepository.add(contact.email, "unsubscribed");
  await deps.eventRepository.record({ eventType: "unsubscribed", campaignId, occurredAt: now, metadata: { contactId } });

  return stopEnrollmentsForContact(deps, contactId, "stopped_suppressed");
}
