import { getAccountRef } from "../../adapters/persistence/campaign-scheduling-support.js";
import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import { contactToPersonalizationValues } from "../../core/campaigns/personalize.js";
import type { Draft } from "../../core/drafts/draft.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import { EmailAddress, parseNamedAddress, type NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import { asDraftId, asEnrollmentId, type AccountId, type CampaignId, type DraftId, type SendQueueId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { MailProvider } from "../../ports/mail-provider.port.js";
import type { ProviderSelector } from "../../ports/provider-selector.port.js";
import type { RateLimiter } from "../../ports/rate-limiter.port.js";
import type { Repository } from "../../ports/repository.port.js";
import type { SendQueueEntry, SendQueueRepository } from "../../ports/send-queue-repository.port.js";

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
  contactRepository: ContactRepository;
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
  failures: { sendQueueEntryId: SendQueueId; error: string }[];
}

type DispatchOutcome = "sent" | "retried" | "failed";

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
  const draftRef = await provider.createDraft(accountRef, built);
  await deps.draftLifecycle.recordProviderDraftRef(draft.id, draftRef.providerDraftId);
  const sendResult = await provider.sendDraft(accountRef, draftRef);
  await provider.appendToSentFolder(accountRef, Buffer.from(built.raw, "utf8"));

  await deps.conversationRepository.markMessageSent(message.id, { sentAt: now, providerMessageId: sendResult.providerMessageId });
  await deps.sendQueueRepository.markSent(claimed.id);
  return "sent";
}

/**
 * Send worker (Section 21.1): claims from send_queue and executes Rate Limiter -> Provider
 * Selector -> Provider Adapter -> Delivery for one message at a time, draining up to
 * MAX_CLAIMS_PER_TICK rows per call. Each claimed row's dispatch failure is isolated (Section
 * 21.3) — it retries with backoff rather than stalling the rest of the drain or crashing the
 * worker.
 */
export async function runSendWorkerTick(deps: SendWorkerDeps, now: Date): Promise<SendWorkerTickResult> {
  const result: SendWorkerTickResult = { claimed: 0, sent: 0, retried: 0, failed: 0, failures: [] };

  for (let i = 0; i < MAX_CLAIMS_PER_TICK; i++) {
    const claimed = await deps.sendQueueRepository.claimNext(now);
    if (!claimed) break;
    result.claimed++;

    try {
      const outcome = await dispatchOne(deps, claimed, now);
      if (outcome === "sent") result.sent++;
      else if (outcome === "retried") result.retried++;
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
