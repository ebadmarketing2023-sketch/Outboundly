/**
 * The domain event bus (Section 1.2). Modules publish/subscribe to typed events instead of
 * calling each other directly, so e.g. the Campaign Engine and Conversation Engine never import
 * one another.
 */
export interface DomainEvent {
  type: string;
  occurredAt: Date;
}

export interface DraftSavedEvent extends DomainEvent {
  type: "DraftSaved";
  draftId: string;
}

export interface MessageSentEvent extends DomainEvent {
  type: "MessageSent";
  messageId: string;
  accountId: string;
  providerMessageId: string;
}

export interface CompatibilityIssueFoundEvent extends DomainEvent {
  type: "CompatibilityIssueFound";
  draftId: string;
  ruleId: string;
  severity: "blocking" | "warning" | "info";
}

export type OutboundlyEvent = DraftSavedEvent | MessageSentEvent | CompatibilityIssueFoundEvent;

export type EventHandler<E extends OutboundlyEvent = OutboundlyEvent> = (event: E) => void;

export interface EventBus {
  publish(event: OutboundlyEvent): void;
  subscribe<T extends OutboundlyEvent["type"]>(
    type: T,
    handler: EventHandler<Extract<OutboundlyEvent, { type: T }>>
  ): void;
}
