import { decideConversationPlacement, nextConversationState } from "../../core/conversation/conversation-engine.js";
import { deriveParticipants } from "../../core/conversation/participants.js";
import { parseReferenceChain } from "../../core/conversation/reference-graph.js";
import { normalizeSubject } from "../../core/conversation/subject-normalizer.js";
import type { ConversationRepository } from "../../ports/conversation-repository.port.js";

/**
 * Runs one message — inbound (synced) or outbound (just sent) — through the Conversation
 * Engine's placement decision and persists the result. Shared by inbox sync (Section 11) and
 * Sent Mail Synchronization (Section 9.5) so a manually composed reply and an inbound reply to
 * it end up in the same thread via the exact same logic, not two parallel code paths.
 */

export interface IngestMessageInput {
  accountId: string;
  direction: "inbound" | "outbound";
  providerMessageId?: string;
  providerThreadId?: string;
  messageIdHeader: string;
  inReplyToHeader?: string;
  referencesHeader?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  snippet?: string;
  occurredAt?: Date;
  /** Defaults to "sent" — the existing behavior for manual compose (Section 9.5) and inbound sync
   * (Section 11). A campaign step queues its message before it's actually dispatched (Section
   * 14.3), so it ingests here with status "queued" and no sentAt yet; the Send worker (Section
   * 21.1) updates it to "sent" once delivery actually completes. */
  status?: string;
  campaignEnrollmentId?: string;
  draftId?: string;
  templateId?: string;
  subjectVariantId?: string;
}

export interface IngestMessageResult {
  outcome: "duplicate" | "new-thread" | "attached" | "merged";
  threadId: string;
  messageId?: string;
}

export async function ingestMessage(
  repo: ConversationRepository,
  input: IngestMessageInput
): Promise<IngestMessageResult> {
  const ancestorChain = parseReferenceChain(input);
  const relevantMessageIds = [...ancestorChain, input.messageIdHeader];

  const knownMessageIdToThreadId = await repo.findThreadIdsForMessageIds(relevantMessageIds);
  const knownProviderThreadIdToThreadId = new Map<string, string>();
  if (input.providerThreadId) {
    const threadId = await repo.findThreadIdForProviderThreadId(input.accountId, input.providerThreadId);
    if (threadId) knownProviderThreadIdToThreadId.set(input.providerThreadId, threadId);
  }

  const placement = decideConversationPlacement(
    {
      messageIdHeader: input.messageIdHeader,
      inReplyToHeader: input.inReplyToHeader,
      referencesHeader: input.referencesHeader,
      providerThreadId: input.providerThreadId
    },
    { knownMessageIdToThreadId, knownProviderThreadIdToThreadId }
  );

  if (placement.kind === "duplicate") {
    return { outcome: "duplicate", threadId: placement.threadId };
  }

  let threadId: string;
  let outcome: IngestMessageResult["outcome"];

  if (placement.kind === "new-thread") {
    threadId = await repo.createThread({
      accountId: input.accountId,
      providerThreadId: input.providerThreadId,
      subjectNormalized: normalizeSubject(input.subject),
      conversationState: nextConversationState("active", input.direction)
    });
    outcome = "new-thread";
  } else {
    threadId = placement.threadId;
    if (placement.absorbThreadIds.length > 0) {
      await repo.mergeThreads(threadId, placement.absorbThreadIds, "header-graph");
      outcome = "merged";
    } else {
      outcome = "attached";
    }
    await repo.updateThreadState(threadId, nextConversationState("active", input.direction));
  }

  const occurredAt = input.occurredAt ?? new Date();
  const status = input.status ?? "sent";
  const messageId = await repo.insertMessage({
    accountId: input.accountId,
    threadId,
    providerMessageId: input.providerMessageId,
    messageIdHeader: input.messageIdHeader,
    inReplyToHeader: input.inReplyToHeader,
    referencesHeader: input.referencesHeader,
    direction: input.direction,
    fromAddress: input.from,
    toAddresses: input.to,
    ccAddresses: input.cc,
    subject: input.subject,
    bodyHtml: input.bodyHtml,
    bodyText: input.bodyText,
    snippet: input.snippet,
    sentAt: input.direction === "outbound" && status === "sent" ? occurredAt : undefined,
    receivedAt: input.direction === "inbound" ? occurredAt : undefined,
    status,
    campaignEnrollmentId: input.campaignEnrollmentId,
    draftId: input.draftId,
    templateId: input.templateId,
    subjectVariantId: input.subjectVariantId
  });

  await repo.insertReferenceEdges(messageId, ancestorChain);
  const participants = deriveParticipants({ from: input.from, to: input.to, cc: input.cc });
  await repo.upsertParticipants(threadId, participants);

  return { outcome, threadId, messageId };
}
