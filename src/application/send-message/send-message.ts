import { evaluateGmailCompatibility, hasBlockingFindings as hasBlockingCompatibilityFindings } from "../../core/gmail-compatibility/engine.js";
import type { CompatibilityReport } from "../../core/gmail-compatibility/types.js";
import { evaluateDeliverability, hasBlockingFindings as hasBlockingDeliverabilityFindings } from "../../core/deliverability/engine.js";
import type { DeliverabilityReport } from "../../core/deliverability/types.js";
import type { Draft } from "../../core/drafts/draft.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import { extractPlainAndHtmlBodies } from "../../core/mime/mime-generator.js";
import { findHeaderValue } from "../../core/mime/headers.js";
import { formatNamedAddress, type NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import type { AccountRef, MailProvider } from "../../ports/mail-provider.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import type { DeliverabilityReportRepository } from "../../ports/deliverability-report-repository.port.js";
import { ingestMessage } from "../sync-inbox/ingest-message.js";

/**
 * The send-message use case (Section 9.2, stages 3-19, condensed): builds the MIME message from
 * a draft, runs it through the Gmail Compatibility Layer and then the Deliverability Engine
 * (stages 12-13), hands it to the Provider Adapter's Draft Lifecycle send path (create provider
 * draft, then send that draft — Section 7.2), and finally runs the sent message through the
 * Conversation Engine (Section 9.5's Sent Mail Synchronization) so it's recorded locally —
 * without this last step a reply would have nothing to attach to, since the outbound message it's
 * replying to would never have been stored. Phase 1/2/3 have no Scheduler/Queue/Rate Limiter yet
 * (those are Phase 4), so this is a direct, synchronous send — the same pipeline stages still
 * apply in the same order, just without the intervening durability/pacing machinery those later
 * phases add.
 */

export interface SendMessageResult {
  sent: boolean;
  compatibilityReport: CompatibilityReport;
  deliverabilityReport?: DeliverabilityReport;
  providerMessageId?: string;
}

export interface SendMessageParams {
  draft: Draft;
  from: NamedEmailAddress;
  draftLifecycle: DraftLifecycleService;
  provider: MailProvider;
  accountRef: AccountRef;
  conversationRepo: ConversationRepository;
  deliverabilityReportRepo: DeliverabilityReportRepository;
}

export async function sendDraftMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const built = params.draftLifecycle.buildMimeMessage(params.draft, {
    from: params.from,
    sendingDomain: params.accountRef.emailAddress.split("@")[1]!,
    // A person clicking Send is in their own timezone, and their mail client would stamp it --
    // this is the one send path where the machine's own zone is exactly the right answer.
    senderTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });

  const compatibilityReport = evaluateGmailCompatibility(built);
  if (hasBlockingCompatibilityFindings(compatibilityReport)) {
    return { sent: false, compatibilityReport };
  }

  const bodies = extractPlainAndHtmlBodies(built.root);
  const deliverabilityReport = evaluateDeliverability({
    message: built,
    compatibilityReport,
    authenticatedAccountEmail: params.accountRef.emailAddress,
    bodyHtml: bodies.html,
    bodyText: bodies.text
  });

  // messageId stays unset: this check runs before the message exists as a `messages` row (that
  // row is only created below, by Sent Mail Synchronization, once the send actually happens) —
  // there is no real message id to attach yet, matching the schema's nullable message_id column.
  await params.deliverabilityReportRepo.save({
    scope: "message",
    accountId: params.accountRef.accountId,
    generatedAt: new Date(),
    report: deliverabilityReport
  });

  if (hasBlockingDeliverabilityFindings(deliverabilityReport)) {
    return { sent: false, compatibilityReport, deliverabilityReport };
  }

  const draftRef = await params.provider.createDraft(params.accountRef, built);
  await params.draftLifecycle.recordProviderDraftRef(params.draft.id, draftRef.providerDraftId);
  const sendResult = await params.provider.sendDraft(params.accountRef, draftRef);

  // No-op for Gmail/Graph (they auto-file sent mail server-side); this is where SMTP/IMAP's Sent
  // folder actually gets written to, since plain SMTP has no server-side notion of "sent" at all.
  await params.provider.appendToSentFolder(params.accountRef, Buffer.from(built.raw, "utf8"));

  await ingestMessage(params.conversationRepo, {
    accountId: params.accountRef.accountId,
    direction: "outbound",
    providerMessageId: sendResult.providerMessageId,
    providerThreadId: sendResult.providerThreadId,
    // Prefer the provider-confirmed, actually-delivered Message-ID (Gmail/Graph both rewrite it
    // on send) over the provisional value our own MIME builder generated -- this message row is
    // only ever inserted here, after the send already completed, so there's no "provisional now,
    // corrected later" step the way the campaign send-worker path has via markMessageSent.
    messageIdHeader: sendResult.messageIdHeader ?? findHeaderValue(built.headers, "Message-ID") ?? "",
    inReplyToHeader: findHeaderValue(built.headers, "In-Reply-To"),
    referencesHeader: findHeaderValue(built.headers, "References"),
    from: formatNamedAddress(params.from),
    to: params.draft.to.map(formatNamedAddress),
    cc: params.draft.cc.length > 0 ? params.draft.cc.map(formatNamedAddress) : undefined,
    subject: params.draft.subject,
    bodyHtml: bodies.html,
    bodyText: bodies.text
  });

  return { sent: true, compatibilityReport, deliverabilityReport, providerMessageId: sendResult.providerMessageId };
}
