/** Branded string IDs so an AccountId can't be passed where a DraftId is expected. */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type AccountId = Brand<string, "AccountId">;
export type DraftId = Brand<string, "DraftId">;
export type MessageId = Brand<string, "MessageId">;
export type ThreadId = Brand<string, "ThreadId">;
export type ContactId = Brand<string, "ContactId">;
export type TemplateId = Brand<string, "TemplateId">;
export type SequenceId = Brand<string, "SequenceId">;
export type SequenceStepId = Brand<string, "SequenceStepId">;
export type CampaignId = Brand<string, "CampaignId">;
export type EnrollmentId = Brand<string, "EnrollmentId">;
export type SendQueueId = Brand<string, "SendQueueId">;
export type LabelId = Brand<string, "LabelId">;
export type EventId = Brand<string, "EventId">;
export type InsightId = Brand<string, "InsightId">;
export type NotificationId = Brand<string, "NotificationId">;

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
export function asTemplateId(id: string): TemplateId {
  return id as TemplateId;
}
export function asSequenceId(id: string): SequenceId {
  return id as SequenceId;
}
export function asSequenceStepId(id: string): SequenceStepId {
  return id as SequenceStepId;
}
export function asCampaignId(id: string): CampaignId {
  return id as CampaignId;
}
export function asEnrollmentId(id: string): EnrollmentId {
  return id as EnrollmentId;
}
export function asSendQueueId(id: string): SendQueueId {
  return id as SendQueueId;
}
export function asLabelId(id: string): LabelId {
  return id as LabelId;
}
export function asEventId(id: string): EventId {
  return id as EventId;
}
export function asInsightId(id: string): InsightId {
  return id as InsightId;
}
export function asNotificationId(id: string): NotificationId {
  return id as NotificationId;
}

/** Generates a v4-shaped UUID without pulling in an external dependency for this narrow need. */
export function generateId(): string {
  return crypto.randomUUID();
}
