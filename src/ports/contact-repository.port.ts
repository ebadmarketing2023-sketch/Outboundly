import type { ContactId, LeadImportBatchId } from "../core/shared-kernel/ids.js";

export type ContactSource = "csv_import" | "manual" | "reply";

export interface Contact {
  id: ContactId;
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  timezone?: string;
  customFields?: Record<string, string>;
  source: ContactSource;
  /** The CSV import this contact last appeared in (Critical Improvement #3), if any. */
  importBatchId?: LeadImportBatchId;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  timezone?: string;
  customFields?: Record<string, string>;
  source: ContactSource;
  importBatchId?: LeadImportBatchId;
}

/** Leads/Contacts persistence (Section 5.5). Email is the natural key — a CSV re-import of an
 * already-known address updates the existing contact rather than creating a duplicate. */
export interface ContactRepository {
  findByEmail(email: string): Promise<Contact | undefined>;
  findById(id: ContactId): Promise<Contact | undefined>;
  upsertByEmail(input: NewContactInput): Promise<Contact>;
  /** Excludes soft-deleted contacts (see delete()). */
  list(): Promise<Contact[]>;
  /** Soft delete: marks deletedAt rather than removing the row, since campaign_enrollments may
   * hold a real FK to this contact and its message/analytics history must survive. Callers that
   * need to keep campaign statistics accurate should stop any active enrollments first (see
   * src/application/leads/delete-contact.ts). Re-importing the same email un-deletes it. */
  delete(id: ContactId): Promise<void>;
}
