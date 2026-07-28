import { getAccountRef } from "../../adapters/persistence/campaign-scheduling-support.js";
import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import { isPermanentSmtpRejection } from "../../core/campaigns/bounce-detection.js";
import { contactToPersonalizationValues } from "../../core/campaigns/personalize.js";
import type { Draft } from "../../core/drafts/draft.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import { EmailAddress, parseNamedAddress, type NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import { asDraftId, asEnrollmentId, asMessageId, type AccountId, type CampaignId, type DraftId, type SendQueueId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { EventRepository } from "../../ports/event-repository.port.js";
import type { MailProvider } from "../../ports/mail-provider.port.js";
import type { NotificationRepository } from "../../ports/notification-repository.port.js";
import type { ProviderSelector } from "../../ports/provider-selector.port.js";
import type { RateLimiter } from "../../ports/rate-limiter.port.js";
import type { Repository } from "../../ports/repository.port.js";
import type { SendQueueEntry, SendQueueRepository } from "../../ports/send-queue-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";
import { stopEnrollmentsForContact } from "./stop-enrollments.js";

const NO_ACCOUNT_RETRY_MS = 5 * 60 * 1000;
const MAX_CLAIMS_PER_TICK = 50; // bounded drain per tick (Section 21.2) rather than an unbounded loop

export interface SendWorkerDeps {
  db: OutboundlyDb;
  sendQueueRepository: SendQueueRepository;
  rateLimiter: RateLimiter;
  providerSelector: ProviderSelector;
  conversationRepository: ConversationRepository;
  enrollmentRepository: EnrollmentRepository;
  campaignRepository: CampaignRepository;
  sequenceRepository: SequenceRepository;
  contactRepository: ContactRepository;
  eventRepository: EventRepository;
  notificationRepository: NotificationRepository;
  draftRepository: Repository<Draft, DraftId>;
  draftLifecycle: DraftLifecycleService;
  /** Concrete MailProvider construction by account/provider type is main-process wiring (Section
   * 12.3), not application logic — injected so this stays testable against a fake. */
  getProviderForAccount: (accountId: AccountId) => Promise<MailProvider>;
}

export interface SendWorkerTickResult {
  claimed: number;
  sent: number;
  /** Released back to pending for a later retry — an authoritative rate-limit denial or a
   * momentarily-ineligible account, neither a failure of the send itself (Section 16.2/16.3). */
  retried: number;
  failed: number;
  /** A permanent (5xx) SMTP rejection at send time (Section 14.2's stopped_bounce) — counted
   * separately from "failed" since it also stopped matching enrollments, not just failed a send. */
  bounced: number;
  failures: { sendQueueEntryId: SendQueueId; error: string }[];
}

type DispatchOutcome = "sent" | "retried" | "failed" | "bounced";

async function dispatchOne(deps: SendWorkerDeps, claimed: SendQueueEntry, now: Date): Promise<DispatchOutcome> {
  const message = await deps.conversationRepository.findMessageById(claimed.messageId);
  if (!message) {
    await deps.sendQueueRepository.markFailed(claimed.id, `send_queue row ${claimed.id} references a message that no longer exists`, {
      permanent: true,
      now
    });
    return "failed";
  }

  const rateDecision = deps.rateLimiter.checkAndReserve(claimed.accountId);
  if (!rateDecision.allowed) {
    await deps.sendQueueRepository.releaseForRetry(claimed.id, rateDecision.retryAfter);
    return "retried";
  }

  let rotationPool: AccountId[] = [claimed.accountId];
  let campaignId: CampaignId | undefined;
  if (message.campaignEnrollmentId) {
    const enrollment = await deps.enrollmentRepository.findById(asEnrollmentId(message.campaignEnrollmentId));
    const campaign = enrollment ? await deps.campaignRepository.findById(enrollment.campaignId) : undefined;
    if (campaign) {
      rotationPool = campaign.sendingAccountIds;
      campaignId = campaign.id;
    }
  }

  const selection = await deps.providerSelector.select({
    candidateAccountId: claimed.accountId,
    rotationPool,
    excludedAccountIds: [],
    // Campaigns don't persist a configured rotation strategy yet (Section 5.6) — round-robin is a
    // safe, deterministic default until that's added.
    strategy: "round-robin",
    campaignId
  });
  if (!selection.selected) {
    await deps.sendQueueRepository.releaseForRetry(claimed.id, new Date(now.getTime() + NO_ACCOUNT_RETRY_MS));
    return "retried";
  }

  if (!message.draftId) {
    await deps.sendQueueRepository.markFailed(claimed.id, "queued message has no associated draft to build MIME from", {
      permanent: true,
      now
    });
    return "failed";
  }
  const draft = await deps.draftRepository.findById(asDraftId(message.draftId));
  if (!draft) {
    await deps.sendQueueRepository.markFailed(claimed.id, `draft ${message.draftId} no longer exists`, { permanent: true, now });
    return "failed";
  }

  const accountRef = getAccountRef(deps.db, selection.accountId);
  if (!accountRef) {
    await deps.sendQueueRepository.markFailed(claimed.id, `account ${selection.accountId} no longer exists`, { permanent: true, now });
    return "failed";
  }

  const recipientEmail = message.toAddresses[0];
  const contact = recipientEmail ? await deps.contactRepository.findByEmail(parseNamedAddress(recipientEmail).address.toString()) : undefined;

  const from: NamedEmailAddress = { address: EmailAddress.parse(accountRef.emailAddress) };
  const built = deps.draftLifecycle.buildMimeMessage(draft, {
    from,
    sendingDomain: accountRef.emailAddress.split("@")[1]!,
    personalizationValues: contact ? contactToPersonalizationValues(contact) : undefined
  });

  const provider = await deps.getProviderForAccount(selection.accountId);
  let sendResult;
  try {
    const draftRef = await provider.createDraft(accountRef, built);
    await deps.draftLifecycle.recordProviderDraftRef(draft.id, draftRef.providerDraftId);
    sendResult = await provider.sendDraft(accountRef, draftRef);
    await provider.appendToSentFolder(accountRef, Buffer.from(built.raw, "utf8"));
  } catch (err) {
    if (!isPermanentSmtpRejection(err)) throw err; // let the outer catch retry it as transient

    const errorMessage = err instanceof Error ? err.message : String(err);
    await deps.sendQueueRepository.markFailed(claimed.id, errorMessage, { permanent: true, now });
    await deps.eventRepository.record({
      eventType: "bounced",
      messageId: asMessageId(message.id),
      campaignId,
      accountId: selection.accountId,
      occurredAt: now,
      metadata: { reason: errorMessage }
    });
    // Permanent send failures surface to Notifications (Section 16.4, Section 24.4) rather than
    // retrying forever -- this is the terminal outcome, so it's the one point that needs surfacing.
    await deps.notificationRepository.record({
      notificationType: "send_failure",
      severity: "warning",
      message: `A message to ${recipientEmail ?? "a recipient"} failed permanently: ${errorMessage}`,
      relatedAccountId: selection.accountId,
      relatedCampaignId: campaignId,
      createdAt: now
    });
    if (contact) await stopEnrollmentsForContact(deps, contact.id, "stopped_bounce");
    return "bounced";
  }

  await deps.conversationRepository.markMessageSent(message.id, { sentAt: now, providerMessageId: sendResult.providerMessageId });
  await deps.sendQueueRepository.markSent(claimed.id);
  await deps.eventRepository.record({
    eventType: "sent",
    messageId: asMessageId(message.id),
    campaignId,
    accountId: selection.accountId,
    occurredAt: now,
    metadata:
      message.templateId || message.subjectVariantId
        ? { templateId: message.templateId, subjectVariantId: message.subjectVariantId }
        : undefined
  });
  return "sent";
}

/**
 * Send worker (Section 21.1): claims from send_queue and executes Rate Limiter -> Provider
 * Selector -> Provider Adapter -> Delivery for one message at a time, draining up to
 * MAX_CLAIMS_PER_TICK rows per call. Each claimed row's dispatch failure is isolated (Section
 * 21.3) — it retries with backoff rather than stalling the rest of the drain or crashing the
 * worker, except a permanent SMTP rejection (Section 14.2's stopped_bounce), which fails the row
 * terminally and stops the recipient's matching enrollments instead of retrying a send that will
 * never succeed.
 */
export async function runSendWorkerTick(deps: SendWorkerDeps, now: Date): Promise<SendWorkerTickResult> {
  const result: SendWorkerTickResult = { claimed: 0, sent: 0, retried: 0, failed: 0, bounced: 0, failures: [] };

  for (let i = 0; i < MAX_CLAIMS_PER_TICK; i++) {
    const claimed = await deps.sendQueueRepository.claimNext(now);
    if (!claimed) break;
    result.claimed++;

    try {
      const outcome = await dispatchOne(deps, claimed, now);
      if (outcome === "sent") result.sent++;
      else if (outcome === "retried") result.retried++;
      else if (outcome === "bounced") result.bounced++;
      else result.failed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await deps.sendQueueRepository.markFailed(claimed.id, errorMessage, { permanent: false, now });
      result.failed++;
      result.failures.push({ sendQueueEntryId: claimed.id, error: errorMessage });
    }
  }

  return result;
}
