import type { ContactId } from "../core/shared-kernel/ids.js";

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
}

/** Leads/Contacts persistence (Section 5.5). Email is the natural key — a CSV re-import of an
 * already-known address updates the existing contact rather than creating a duplicate. */
export interface ContactRepository {
  findByEmail(email: string): Promise<Contact | undefined>;
  findById(id: ContactId): Promise<Contact | undefined>;
  upsertByEmail(input: NewContactInput): Promise<Contact>;
  list(): Promise<Contact[]>;
  delete(id: ContactId): Promise<void>;
}
