import { eq } from "drizzle-orm";
import { asContactId, generateId, type ContactId } from "../../../core/shared-kernel/ids.js";
import type { Contact, ContactRepository, NewContactInput } from "../../../ports/contact-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { contacts as contactsTable } from "../schema.js";

type ContactRow = typeof contactsTable.$inferSelect;

function toDomain(row: ContactRow): Contact {
  return {
    id: asContactId(row.id),
    email: row.email,
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    company: row.company ?? undefined,
    title: row.title ?? undefined,
    timezone: row.timezone ?? undefined,
    customFields: row.customFields ?? undefined,
    source: row.source as Contact["source"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** SQLite-backed implementation of ContactRepository (Section 5.5). */
export class SqliteContactRepository implements ContactRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async findByEmail(email: string): Promise<Contact | undefined> {
    const row = this.db.select().from(contactsTable).where(eq(contactsTable.email, email)).get();
    return row ? toDomain(row) : undefined;
  }

  async findById(id: ContactId): Promise<Contact | undefined> {
    const row = this.db.select().from(contactsTable).where(eq(contactsTable.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  async upsertByEmail(input: NewContactInput): Promise<Contact> {
    const existing = this.db.select().from(contactsTable).where(eq(contactsTable.email, input.email)).get();
    const now = new Date();

    if (existing) {
      this.db
        .update(contactsTable)
        .set({
          firstName: input.firstName,
          lastName: input.lastName,
          company: input.company,
          title: input.title,
          timezone: input.timezone,
          customFields: input.customFields,
          updatedAt: now
        })
        .where(eq(contactsTable.id, existing.id))
        .run();
      const updated = this.db.select().from(contactsTable).where(eq(contactsTable.id, existing.id)).get();
      return toDomain(updated!);
    }

    const id = generateId();
    this.db
      .insert(contactsTable)
      .values({
        id,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        company: input.company,
        title: input.title,
        timezone: input.timezone,
        customFields: input.customFields,
        source: input.source,
        createdAt: now,
        updatedAt: now
      })
      .run();
    const created = this.db.select().from(contactsTable).where(eq(contactsTable.id, id)).get();
    return toDomain(created!);
  }

  async list(): Promise<Contact[]> {
    return this.db.select().from(contactsTable).all().map(toDomain);
  }

  async delete(id: ContactId): Promise<void> {
    this.db.delete(contactsTable).where(eq(contactsTable.id, id)).run();
  }
}
