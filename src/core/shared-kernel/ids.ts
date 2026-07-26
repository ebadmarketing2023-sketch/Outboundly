/** Branded string IDs so an AccountId can't be passed where a DraftId is expected. */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type AccountId = Brand<string, "AccountId">;
export type DraftId = Brand<string, "DraftId">;
export type MessageId = Brand<string, "MessageId">;
export type ThreadId = Brand<string, "ThreadId">;
export type ContactId = Brand<string, "ContactId">;

export function asAccountId(id: string): AccountId {
  return id as AccountId;
}
export function asDraftId(id: string): DraftId {
  return id as DraftId;
}
export function asMessageId(id: string): MessageId {
  return id as MessageId;
}
export function asThreadId(id: string): ThreadId {
  return id as ThreadId;
}
export function asContactId(id: string): ContactId {
  return id as ContactId;
}

/** Generates a v4-shaped UUID without pulling in an external dependency for this narrow need. */
export function generateId(): string {
  return crypto.randomUUID();
}
