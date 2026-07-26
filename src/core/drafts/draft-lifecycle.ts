import type { Clock } from "../../ports/clock.port.js";
import type { Repository } from "../../ports/repository.port.js";
import type { NamedEmailAddress } from "../shared-kernel/email-address.js";
import { generateId } from "../shared-kernel/ids.js";
import type { AccountId, DraftId } from "../shared-kernel/ids.js";
import { resolveVariables } from "../rendering/document-model.js";
import { renderHtml } from "../rendering/html-renderer.js";
import { renderPlainText } from "../rendering/text-renderer.js";
import { generateMimeTree } from "../mime/mime-generator.js";
import { canonicalize } from "../mime/canonicalizer.js";
import { buildRfc5322Headers, generateMessageId } from "../mime/rfc5322-builder.js";
import type { BuiltMimeMessage } from "../mime/types.js";
import type { Draft, DraftPatch, NewDraftInput } from "./draft.js";

/**
 * Orchestrates the Draft Lifecycle (Section 7): Compose -> Draft Object -> (Personalization) ->
 * Internal Message Model -> RFC Message -> MIME Generation -> MIME Canonicalization. Provider
 * Draft materialization and Send Draft are the Provider Adapter's job (Section 12), invoked by
 * the application layer once this service hands back a BuiltMimeMessage.
 */
export class DraftLifecycleService {
  constructor(
    private readonly repository: Repository<Draft, DraftId>,
    private readonly clock: Clock
  ) {}

  async createDraft(input: NewDraftInput): Promise<Draft> {
    const draft: Draft = {
      id: generateId() as DraftId,
      accountId: input.accountId,
      threadId: input.threadId,
      subject: input.subject,
      document: input.document,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      inReplyTo: input.inReplyTo,
      references: input.references,
      autosaveVersion: 1,
      lastSavedAt: this.clock.now()
    };
    await this.repository.save(draft);
    return draft;
  }

  /** Autosave (Section 6): every significant edit bumps the version and timestamp. */
  async autosave(draftId: DraftId, patch: DraftPatch): Promise<Draft> {
    const existing = await this.repository.findById(draftId);
    if (!existing) throw new Error(`Draft ${draftId} not found`);

    const updated: Draft = {
      ...existing,
      ...patch,
      autosaveVersion: existing.autosaveVersion + 1,
      lastSavedAt: this.clock.now()
    };
    await this.repository.save(updated);
    return updated;
  }

  async recordProviderDraftRef(draftId: DraftId, providerDraftRef: string): Promise<Draft> {
    const existing = await this.repository.findById(draftId);
    if (!existing) throw new Error(`Draft ${draftId} not found`);
    const updated: Draft = { ...existing, providerDraftRef };
    await this.repository.save(updated);
    return updated;
  }

  /**
   * Runs Personalization through MIME Canonicalization (Section 9.2, stages 3-9) and returns
   * the finished BuiltMimeMessage. Missing personalization values surface as a hard stop here
   * (via resolveVariables/renderHtml), never discovered later at send time.
   */
  buildMimeMessage(
    draft: Draft,
    params: {
      from: NamedEmailAddress;
      sendingDomain: string;
      personalizationValues?: Record<string, string>;
    }
  ): BuiltMimeMessage {
    const resolvedDocument = params.personalizationValues
      ? resolveVariables(draft.document, params.personalizationValues)
      : draft.document;

    const html = renderHtml(resolvedDocument);
    const text = renderPlainText(resolvedDocument);
    const tree = generateMimeTree({ html, text });

    const headers = buildRfc5322Headers({
      from: params.from,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      date: this.clock.now(),
      messageId: generateMessageId(params.sendingDomain, draft.id),
      inReplyTo: draft.inReplyTo,
      references: draft.references
    });

    return canonicalize(headers, tree);
  }
}

export function accountIdOf(draft: Draft): AccountId {
  return draft.accountId;
}
