import { evaluateGmailCompatibility, hasBlockingFindings } from "../../core/gmail-compatibility/engine.js";
import type { CompatibilityReport } from "../../core/gmail-compatibility/types.js";
import type { Draft } from "../../core/drafts/draft.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import { extractPlainAndHtmlBodies } from "../../core/mime/mime-generator.js";
import { findHeaderValue } from "../../core/mime/headers.js";
import { formatNamedAddress, type NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import type { AccountRef, MailProvider } from "../../ports/mail-provider.port.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";
import { ingestMessage } from "../sync-inbox/ingest-message.js";

/**
 * The send-message use case (Section 9.2, stages 3-19, condensed): builds the MIME message from
 * a draft, runs it through the Gmail Compatibility Layer, hands it to the Provider Adapter's
 * Draft Lifecycle send path (create provider draft, then send that draft — Section 7.2), and
 * finally runs the sent message through the Conversation Engine (Section 9.5's Sent Mail
 * Synchronization) so it's recorded locally — without this last step a reply would have nothing
 * to attach to, since the outbound message it's replying to would never have been stored.
 * Phase 1 has no Scheduler/Queue/Rate Limiter yet (those are Phase 4), so this is a direct,
 * synchronous send — the same pipeline stages still apply in the same order, just without the
 * intervening durability/pacing machinery those later phases add.
 */

export interface SendMessageResult {
  sent: boolean;
  compatibilityReport: CompatibilityReport;
  providerMessageId?: string;
}

export interface SendMessageParams {
  draft: Draft;
  from: NamedEmailAddress;
  sendingDomain: string;
  draftLifecycle: DraftLifecycleService;
  provider: MailProvider;
  accountRef: AccountRef;
  conversationRepo: ConversationRepository;
}

export async function sendDraftMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const built = params.draftLifecycle.buildMimeMessage(params.draft, {
    from: params.from,
    sendingDomain: params.sendingDomain
  });

  const compatibilityReport = evaluateGmailCompatibility(built);
  if (hasBlockingFindings(compatibilityReport)) {
    return { sent: false, compatibilityReport };
  }

  const draftRef = await params.provider.createDraft(params.accountRef, built);
  await params.draftLifecycle.recordProviderDraftRef(params.draft.id, draftRef.providerDraftId);
  const sendResult = await params.provider.sendDraft(params.accountRef, draftRef);

  // No-op for Gmail/Graph (they auto-file sent mail server-side); this is where SMTP/IMAP's Sent
  // folder actually gets written to, since plain SMTP has no server-side notion of "sent" at all.
  await params.provider.appendToSentFolder(params.accountRef, Buffer.from(built.raw, "utf8"));

  const bodies = extractPlainAndHtmlBodies(built.root);
  await ingestMessage(params.conversationRepo, {
    accountId: params.accountRef.accountId,
    direction: "outbound",
    providerMessageId: sendResult.providerMessageId,
    providerThreadId: sendResult.providerThreadId,
    messageIdHeader: findHeaderValue(built.headers, "Message-ID") ?? "",
    inReplyToHeader: findHeaderValue(built.headers, "In-Reply-To"),
    referencesHeader: findHeaderValue(built.headers, "References"),
    from: formatNamedAddress(params.from),
    to: params.draft.to.map(formatNamedAddress),
    cc: params.draft.cc.length > 0 ? params.draft.cc.map(formatNamedAddress) : undefined,
    subject: params.draft.subject,
    bodyHtml: bodies.html,
    bodyText: bodies.text
  });

  return { sent: true, compatibilityReport, providerMessageId: sendResult.providerMessageId };
}
