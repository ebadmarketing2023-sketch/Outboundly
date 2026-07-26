import type { NamedEmailAddress } from "../shared-kernel/email-address.js";
import type { AccountId, DraftId, ThreadId } from "../shared-kernel/ids.js";
import type { Document } from "../rendering/document-model.js";

/**
 * The Draft Object at the heart of the Gmail-Style Draft Lifecycle (Section 7). Every outbound
 * message — manual or campaign-generated — exists as one of these before anything else happens.
 */
export interface Draft {
  id: DraftId;
  accountId: AccountId;
  threadId?: ThreadId;
  subject: string;
  document: Document;
  to: NamedEmailAddress[];
  cc: NamedEmailAddress[];
  bcc: NamedEmailAddress[];
  inReplyTo?: string;
  references?: string[];
  providerDraftRef?: string;
  autosaveVersion: number;
  lastSavedAt: Date;
}

export interface NewDraftInput {
  accountId: AccountId;
  subject: string;
  document: Document;
  to: NamedEmailAddress[];
  cc?: NamedEmailAddress[];
  bcc?: NamedEmailAddress[];
  threadId?: ThreadId;
  inReplyTo?: string;
  references?: string[];
}

export type DraftPatch = Partial<
  Pick<Draft, "subject" | "document" | "to" | "cc" | "bcc">
>;
