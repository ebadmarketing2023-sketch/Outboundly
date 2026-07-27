import { parseReferenceChain } from "./reference-graph.js";

/**
 * The Conversation Engine's core placement decision (Section 11.2, 11.3): given one incoming
 * message and what's already known, decide whether it's a duplicate, which thread it belongs
 * to, or whether two previously-distinct threads (typically an SMTP/IMAP-only account's copy of
 * a thread a Gmail/Graph account already has under a different provider thread id) turn out to
 * be the same conversation and should merge.
 *
 * This is pure decision logic — it takes a snapshot of what's already known rather than querying
 * anything itself, so the actual database reads/writes stay entirely in the inbox sync use case
 * (Section 4: core/ never does I/O).
 */

export type ConversationState = "active" | "awaiting_reply" | "stale" | "closed";

export interface ConversationEngineMessage {
  messageIdHeader: string;
  inReplyToHeader?: string;
  referencesHeader?: string;
  providerThreadId?: string;
}

export interface ConversationEngineKnownState {
  /** Every Message-ID this engine has already ingested, mapped to the thread it landed in. */
  knownMessageIdToThreadId: ReadonlyMap<string, string>;
  /** Every known provider thread id, mapped to our internal thread id (fast-path corroboration). */
  knownProviderThreadIdToThreadId: ReadonlyMap<string, string>;
}

export type ConversationPlacement =
  | { kind: "duplicate"; threadId: string }
  | { kind: "attach"; threadId: string; absorbThreadIds: string[] }
  | { kind: "new-thread" };

export function decideConversationPlacement(
  message: ConversationEngineMessage,
  known: ConversationEngineKnownState
): ConversationPlacement {
  const existingThreadForThisMessage = known.knownMessageIdToThreadId.get(message.messageIdHeader);
  if (existingThreadForThisMessage) {
    return { kind: "duplicate", threadId: existingThreadForThisMessage };
  }

  const ancestorChain = parseReferenceChain(message);
  const candidateThreadIds = new Set<string>();

  for (const ancestorMessageId of ancestorChain) {
    const threadId = known.knownMessageIdToThreadId.get(ancestorMessageId);
    if (threadId) candidateThreadIds.add(threadId);
  }

  if (message.providerThreadId) {
    const threadId = known.knownProviderThreadIdToThreadId.get(message.providerThreadId);
    if (threadId) candidateThreadIds.add(threadId);
  }

  if (candidateThreadIds.size === 0) {
    return { kind: "new-thread" };
  }

  // Exactly one distinct candidate: attach, no merge needed.
  // More than one: the header graph proves these are the same conversation even though they
  // were previously tracked as separate threads (Section 11.2's thread-merging responsibility) —
  // keep the first (lowest-id, deterministic) as canonical and absorb the rest.
  const sorted = [...candidateThreadIds].sort();
  const [canonicalThreadId, ...absorbThreadIds] = sorted;
  return { kind: "attach", threadId: canonicalThreadId!, absorbThreadIds };
}

/**
 * Message-driven conversation state (Section 11.2). Time-based transitions into "stale" and
 * user-driven transitions into "closed" (archiving) are out of scope here — they need a clock
 * or an explicit user action, neither of which this pure per-message function has (Section 21's
 * background workers and Section 11.4's archive action own those transitions respectively).
 */
export function nextConversationState(
  _current: ConversationState,
  incomingDirection: "inbound" | "outbound"
): ConversationState {
  return incomingDirection === "inbound" ? "active" : "awaiting_reply";
}
