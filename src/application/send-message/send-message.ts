import { evaluateGmailCompatibility, hasBlockingFindings } from "../../core/gmail-compatibility/engine.js";
import type { CompatibilityReport } from "../../core/gmail-compatibility/types.js";
import type { Draft } from "../../core/drafts/draft.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import type { NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import type { AccountRef, MailProvider } from "../../ports/mail-provider.port.js";

/**
 * The send-message use case (Section 9.2, stages 3-19, condensed): builds the MIME message from
 * a draft, runs it through the Gmail Compatibility Layer, and only then hands it to the Provider
 * Adapter's Draft Lifecycle send path (create provider draft, then send that draft — Section 7.2).
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

  return { sent: true, compatibilityReport, providerMessageId: sendResult.providerMessageId };
}
