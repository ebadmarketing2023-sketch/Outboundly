import { eq } from "drizzle-orm";
import { getAccountRef } from "../../adapters/persistence/campaign-scheduling-support.js";
import { accounts as accountsTable } from "../../adapters/persistence/schema.js";
import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import { isPermanentSmtpRejection } from "../../core/campaigns/bounce-detection.js";
import { isWithinBusinessHours, nextWindowOpening } from "../../core/scheduling/business-hours-window.js";
import { personalizationValuesFor } from "../../core/campaigns/personalize.js";
import type { Draft } from "../../core/drafts/draft.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import { EmailAddress, parseNamedAddress, type NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import { asDraftId, asEnrollmentId, asMessageId, type AccountId, type CampaignId, type DraftId, type SendQueueId } from "../../core/shared-kernel/ids.js";
import type { BusinessHoursProfileRepository } from "../../ports/business-hours-profile-repository.port.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { ErrorLogRepository } from "../../ports/error-log-repository.port.js";
import type { EventRepository } from "../../ports/event-repository.port.js";
import type { MailProvider } from "../../ports/mail-provider.port.js";
import type { NotificationRepository } from "../../ports/notification-repository.port.js";
import type { ProviderSelector } from "../../ports/provider-selector.port.js";
import type { RateLimiter } from "../../ports/rate-limiter.port.js";
import type { Repository } from "../../ports/repository.port.js";
import type { SendQueueEntry, SendQueueRepository } from "../../ports/send-queue-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";
import { maybeCompleteCampaign } from "./maybe-complete-campaign.js";
import { stopEnrollmentsForContact } from "./stop-enrollments.js";

const NO_ACCOUNT_RETRY_MS = 5 * 60 * 1000;
const PAUSED_CAMPAIGN_RETRY_MS = 5 * 60 * 1000;
const MAX_CLAIMS_PER_TICK = 50; // bounded drain per tick (Section 21.2) rather than an unbounded loop

/** Process-lifetime dedupe for the ineligible-account alert. Cleared whenever an account does
 * dispatch successfully, so a genuine recovery re-arms the warning for next time. */
const reportedIneligibleAccounts = new Set<string>();

export interface SendWorkerDeps {
  db: OutboundlyDb;
  sendQueueRepository: SendQueueRepository;
  rateLimiter: RateLimiter;
  providerSelector: ProviderSelector;
  conversationRepository: ConversationRepository;
  enrollmentRepository: EnrollmentRepository;
  campaignRepository: CampaignRepository;
  /** Read at dispatch time, not only at scheduling time -- see the business-hours re-check in
   * dispatchOne for what a retry does to an already-snapped send time. */
  businessHoursProfileRepository: BusinessHoursProfileRepository;
  sequenceRepository: SequenceRepository;
  contactRepository: ContactRepository;
  eventRepository: EventRepository;
  notificationRepository: NotificationRepository;
  draftRepository: Repository<Draft, DraftId>;
  draftLifecycle: DraftLifecycleService;
  /** Optional (Critical Improvement #12): when provided, every dispatch failure this worker
   * handles is also recorded as a structured, queryable log entry, not just returned in this
   * tick's own result object. Omitted in most existing tests since it's a pure side effect. */
  errorLogRepository?: ErrorLogRepository;
  /** Concrete MailProvider construction by account/provider type is main-process wiring (Section
   * 12.3), not application logic — injected so this stays testable against a fake. */
  getProviderForAccount: (accountId: AccountId) => Promise<MailProvider>;
}

async function logSendFailure(
  deps: SendWorkerDeps,
  now: Date,
  opts: { errorType: string; errorMessage: string; campaignId?: CampaignId; accountId?: AccountId; recipientEmail?: string; retryCount?: number }
): Promise<void> {
  await deps.errorLogRepository?.record({
    occurredAt: now,
    source: "send-worker",
    errorType: opts.errorType,
    errorMessage: opts.errorMessage,
    campaignId: opts.campaignId,
    accountId: opts.accountId,
    recipientEmail: opts.recipientEmail,
    retryCount: opts.retryCount
  });
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

interface PoolAvailability {
  /** True when no account in the pool is even usable -- none connected, or every connected one is
   * refused for a reason the Rate Limiter isn't responsible for (i.e. Account Health). */
  structurallyUnavailable: boolean;
  /** The soonest a queued row could plausibly be taken by *any* account in the pool. */
  earliestRetryAt?: Date;
}

/**
 * Every deferral must land strictly in the future. A release time of "now" (or earlier) puts the
 * row straight back into the same tick's claim loop, which re-defers it, claims it again, and burns
 * the whole per-tick budget churning one row -- while its due time visibly jitters. The rolling
 * windows make this reachable: a daily denial's retryAfter is oldestSentAt + 24h, which lands on
 * roughly *now* the moment the oldest send is about to age out.
 */
const MIN_DEFER_MS = 30_000;

function deferUntil(now: Date, candidate: Date | undefined, fallbackMs: number): Date {
  const floor = now.getTime() + MIN_DEFER_MS;
  const target = candidate?.getTime() ?? now.getTime() + fallbackMs;
  return new Date(Math.max(target, floor));
}

/** Why the whole rotation pool refused, so the caller can tell "everyone is at quota, wait" apart
 * from "nothing here can ever send until someone intervenes". */
function describePoolAvailability(deps: SendWorkerDeps, rotationPool: AccountId[], claimedId: string, now: Date): PoolAvailability {
  let anyUsable = false;
  let anyAllowedByLimiter = false;
  let earliestRetryAt: Date | undefined;

  for (const accountId of rotationPool) {
    const account = deps.db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).get();
    // Existing *and* connected: a removed or disconnected mailbox is not something waiting will fix.
    if (!account || account.status !== "connected") continue;
    anyUsable = true;
    const decision = deps.rateLimiter.checkAndReserve(accountId, undefined, { excludeSendQueueId: claimedId, now });
    if (decision.allowed) {
      anyAllowedByLimiter = true;
      continue;
    }
    if (decision.retryAfter && (!earliestRetryAt || decision.retryAfter < earliestRetryAt)) {
      earliestRetryAt = decision.retryAfter;
    }
  }

  // An account the limiter would allow, that the selector still refused, was refused on health
  // grounds -- which, like having no usable account at all, needs a human rather than time.
  return { structurallyUnavailable: !anyUsable || anyAllowedByLimiter, earliestRetryAt };
}

async function dispatchOne(deps: SendWorkerDeps, claimed: SendQueueEntry, now: Date): Promise<DispatchOutcome> {
  const message = await deps.conversationRepository.findMessageById(claimed.messageId);
  if (!message) {
    const errorMessage = `send_queue row ${claimed.id} references a message that no longer exists`;
    await deps.sendQueueRepository.markFailed(claimed.id, errorMessage, { permanent: true, now });
    await logSendFailure(deps, now, { errorType: "message_missing", errorMessage, accountId: claimed.accountId });
    return "failed";
  }

  // The Rate Limiter is deliberately *not* consulted for claimed.accountId here. It used to be, and
  // returning on its denial meant the Provider Selector below -- the one component that knows the
  // campaign's rotation pool -- never ran. A campaign with two accounts capped at 5/day therefore
  // sent ~5 from whichever account the Scheduler happened to pin the batch to and parked the rest
  // for a full 24 hours, with the second account completely idle, which makes selecting more than
  // one account pointless. The per-account check still happens, per candidate, inside
  // ProviderSelector.isEligible -- so no account can exceed its own limit; the difference is that
  // an account being at its limit now means "try the next one", not "hold everything until
  // tomorrow".

  // Resolved before the campaign checks below rather than at the point of use, because the
  // business-hours re-check needs this contact's own timezone -- the same one the Timezone Policy
  // resolved against when the message was first scheduled (Section 15.2).
  const recipientEmail = message.toAddresses[0];
  const contact = recipientEmail ? await deps.contactRepository.findByEmail(parseNamedAddress(recipientEmail).address.toString()) : undefined;

  let rotationPool: AccountId[] = [claimed.accountId];
  let campaignId: CampaignId | undefined;
  /** The campaign's business-hours timezone, for the Date header's offset -- see
   * formatRfc5322Date. Left undefined for a manual send, which falls back to UTC. */
  let senderTimeZone: string | undefined;
  if (message.campaignEnrollmentId) {
    const enrollment = await deps.enrollmentRepository.findById(asEnrollmentId(message.campaignEnrollmentId));
    const campaign = enrollment ? await deps.campaignRepository.findById(enrollment.campaignId) : undefined;
    if (campaign) {
      // A real reported bug: pausing a campaign only ever gated the Scheduler from enqueuing *new*
      // sends (Section 14.2's campaigns.status='running' join in findDueForScheduling) -- this
      // worker's claimNext just drains send_queue in FIFO order with no awareness of campaigns at
      // all, so a message that was already queued *before* the pause click kept going out anyway.
      // Releasing it back to pending here (rather than sending it) means a paused/no-longer-running
      // campaign genuinely stops dispatching, and the exact same row picks back up once resumed --
      // nothing is lost or skipped, just held.
      if (campaign.status !== "running") {
        await deps.sendQueueRepository.releaseForRetry(claimed.id, deferUntil(now, undefined, PAUSED_CAMPAIGN_RETRY_MS));
        return "retried";
      }

      // The campaign's business hours, re-checked at the moment of dispatch rather than trusted
      // from enqueue time. The Scheduler does snap the original send into an allowed window, but
      // every path that moves a queued row afterwards is plain clock arithmetic with no idea the
      // window exists: the transient-failure backoff (1 minute, doubling to a 24h ceiling), the
      // Rate Limiter's retryAfter, the paused-campaign hold above, and unclean-shutdown recovery.
      // A send that failed once at 16:55 came back at 17:55 and went out past the 17:00 cutoff;
      // a few doublings put it at 3am or on a Sunday, which is precisely the sending pattern that
      // gets cold outreach filed as spam. Holding the row until the window reopens costs nothing
      // -- the same row picks up where it left off, exactly like the pause path.
      const profile = await deps.businessHoursProfileRepository.findById(campaign.businessHoursProfileId);
      if (profile) {
        senderTimeZone = profile.timezone;
        const timezone = contact?.timezone ?? profile.timezone;
        if (!isWithinBusinessHours(now, profile, timezone)) {
          await deps.sendQueueRepository.releaseForRetry(claimed.id, deferUntil(now, nextWindowOpening(now, profile, timezone), NO_ACCOUNT_RETRY_MS));
          return "retried";
        }
      }

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
    campaignId,
    excludeSendQueueId: claimed.id,
    now
  });
  if (!selection.selected) {
    const pool = describePoolAvailability(deps, rotationPool, claimed.id, now);
    // Two very different situations reach here, and conflating them is what made this invisible:
    // every account merely being at its quota (normal, clears on its own) versus every account
    // being unusable (disconnected, or health-critical) which never clears without a human.
    if (pool.structurallyUnavailable && !reportedIneligibleAccounts.has(claimed.accountId)) {
      reportedIneligibleAccounts.add(claimed.accountId);
      const who = rotationPool.map((id) => getAccountRef(deps.db, id)?.emailAddress ?? id).join(", ");
      const message = `No sending account for this campaign can send (${who}). Queued emails are being held until one is usable again — the usual causes are an account that needs reconnecting, or one Account Health has flagged critical.`;
      await logSendFailure(deps, now, { errorType: "no_eligible_account", errorMessage: message, campaignId, accountId: claimed.accountId });
      await deps.notificationRepository.record({
        notificationType: "send_failure",
        severity: "warning",
        message,
        relatedAccountId: claimed.accountId,
        relatedCampaignId: campaignId,
        createdAt: now
      });
    }
    // Held until the soonest moment any account in the pool could take it, rather than whatever
    // the originally-pinned account's own window happened to be.
    await deps.sendQueueRepository.releaseForRetry(claimed.id, deferUntil(now, pool.earliestRetryAt, NO_ACCOUNT_RETRY_MS));
    return "retried";
  }

  // Commit this account's next randomized pacing window now, exactly once -- on the account
  // actually selected (which may differ from claimed.accountId if the Provider Selector
  // substituted), and only now that dispatch is truly committed, not during the eligibility checks
  // above (see RateLimiter.reserveNextSend's doc comment for why those must stay side-effect-free).
  deps.rateLimiter.reserveNextSend(selection.accountId, now);
  reportedIneligibleAccounts.delete(selection.accountId);

  if (!message.draftId) {
    const errorMessage = "queued message has no associated draft to build MIME from";
    await deps.sendQueueRepository.markFailed(claimed.id, errorMessage, { permanent: true, now });
    await logSendFailure(deps, now, { errorType: "draft_missing", errorMessage, campaignId, accountId: selection.accountId, recipientEmail });
    return "failed";
  }
  const draft = await deps.draftRepository.findById(asDraftId(message.draftId));
  if (!draft) {
    const errorMessage = `draft ${message.draftId} no longer exists`;
    await deps.sendQueueRepository.markFailed(claimed.id, errorMessage, { permanent: true, now });
    await logSendFailure(deps, now, { errorType: "draft_missing", errorMessage, campaignId, accountId: selection.accountId, recipientEmail });
    return "failed";
  }

  const accountRef = getAccountRef(deps.db, selection.accountId);
  if (!accountRef) {
    const errorMessage = `account ${selection.accountId} no longer exists`;
    await deps.sendQueueRepository.markFailed(claimed.id, errorMessage, { permanent: true, now });
    await logSendFailure(deps, now, { errorType: "account_missing", errorMessage, campaignId, accountId: selection.accountId, recipientEmail });
    return "failed";
  }

  const from: NamedEmailAddress = { address: EmailAddress.parse(accountRef.emailAddress), displayName: accountRef.displayName };
  // Deliberately draft.accountId here, not selection.accountId/accountRef above: buildMimeMessage's
  // Message-ID must be derived from the account the draft was originally created against (stable,
  // immutable) so it agrees with the compatibility-check build done at enqueue time
  // (fire-enrollment-step.ts) even when the Provider Selector substitutes a different account for
  // this actual dispatch -- see buildMimeMessage's own comment for what breaks otherwise. Falling
  // back to accountRef only guards the practically-impossible case of the draft's original account
  // having been removed entirely by the time this dispatches.
  const draftAccountRef = getAccountRef(deps.db, draft.accountId) ?? accountRef;
  const built = deps.draftLifecycle.buildMimeMessage(draft, {
    from,
    sendingDomain: draftAccountRef.emailAddress.split("@")[1]!,
    // accountRef, not draftAccountRef: {{Account Name}} has to name the mailbox this copy is
    // actually going out from, which is the one the From header above carries.
    personalizationValues: personalizationValuesFor(contact, accountRef),
    senderTimeZone
  });

  const provider = await deps.getProviderForAccount(selection.accountId);
  // Only reuse a provider thread id if it actually belongs to the account dispatching right now --
  // Gmail (and providers generally) scope thread ids per-account, so a thread id from a *different*
  // account (possible after a Provider Selector substitution) isn't just unhelpful, it's rejected
  // outright by the real API. The In-Reply-To/References headers already in `built` are what
  // thread this correctly for the recipient regardless; this is purely a bonus for keeping the
  // dispatching account's own mailbox view grouped too, when it's actually able to be.
  const providerThreadId = message.threadId
    ? await deps.conversationRepository.findProviderThreadId(message.threadId, selection.accountId)
    : undefined;
  let sendResult;
  try {
    const draftRef = await provider.createDraft(accountRef, built, providerThreadId);
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
    await logSendFailure(deps, now, {
      errorType: "permanent_smtp_rejection",
      errorMessage,
      campaignId,
      accountId: selection.accountId,
      recipientEmail,
      retryCount: claimed.attemptCount
    });
    if (contact) await stopEnrollmentsForContact(deps, contact.id, "stopped_bounce");
    return "bounced";
  }

  await deps.conversationRepository.markMessageSent(message.id, {
    sentAt: now,
    providerMessageId: sendResult.providerMessageId,
    providerThreadId: sendResult.providerThreadId,
    messageIdHeader: sendResult.messageIdHeader,
    sentFromAccountId: selection.accountId
  });
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

  // This may be the last outstanding queued send maybeCompleteCampaign (called at enqueue time,
  // Section 14.3) was waiting on -- an enrollment can already be sitting in a terminal status with
  // nothing left to do the moment its last message actually leaves the queue, so re-check here
  // rather than only ever checking at enqueue time.
  if (campaignId) await maybeCompleteCampaign(deps, campaignId);

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
      await logSendFailure(deps, now, {
        errorType: "transient_dispatch_failure",
        errorMessage,
        accountId: claimed.accountId,
        retryCount: claimed.attemptCount + 1
      });
      result.failed++;
      result.failures.push({ sendQueueEntryId: claimed.id, error: errorMessage });
    }
  }

  return result;
}
