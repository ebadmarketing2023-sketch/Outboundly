import { eq } from "drizzle-orm";
import type { Repository } from "../../../ports/repository.port.js";
import type { Draft } from "../../../core/drafts/draft.js";
import type { Document } from "../../../core/rendering/document-model.js";
import type { NamedEmailAddress } from "../../../core/shared-kernel/email-address.js";
import { formatNamedAddress, parseNamedAddress } from "../../../core/shared-kernel/email-address.js";
import { asAccountId, asDraftId, asThreadId, type DraftId } from "../../../core/shared-kernel/ids.js";
import type { OutboundlyDb } from "../db.js";
import { drafts as draftsTable } from "../schema.js";

type DraftRow = typeof draftsTable.$inferSelect;

function serializeAddresses(list: NamedEmailAddress[]): string[] {
  return list.map(formatNamedAddress);
}

function deserializeAddresses(list: string[] | null | undefined): NamedEmailAddress[] {
  return (list ?? []).map(parseNamedAddress);
}

/** SQLite-backed implementation of the Repository port (Section 4) for Draft Objects. */
export class SqliteDraftRepository implements Repository<Draft, DraftId> {
  constructor(private readonly db: OutboundlyDb) {}

  async findById(id: DraftId): Promise<Draft | undefined> {
    const row = this.db.select().from(draftsTable).where(eq(draftsTable.id, id)).get();
    return row ? this.toDomain(row) : undefined;
  }

  async save(draft: Draft): Promise<void> {
    const row = this.toRow(draft);
    this.db
      .insert(draftsTable)
      .values(row)
      .onConflictDoUpdate({ target: draftsTable.id, set: row })
      .run();
  }

  async delete(id: DraftId): Promise<void> {
    this.db.delete(draftsTable).where(eq(draftsTable.id, id)).run();
  }

  private toRow(draft: Draft): typeof draftsTable.$inferInsert {
    return {
      id: draft.id,
      accountId: draft.accountId,
      threadId: draft.threadId,
      subject: draft.subject,
      documentModelJson: JSON.stringify(draft.document),
      toAddresses: serializeAddresses(draft.to),
      ccAddresses: draft.cc.length ? serializeAddresses(draft.cc) : undefined,
      bccAddresses: draft.bcc.length ? serializeAddresses(draft.bcc) : undefined,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.length ? draft.references : undefined,
      providerDraftRef: draft.providerDraftRef,
      autosaveVersion: draft.autosaveVersion,
      lastSavedAt: draft.lastSavedAt
    };
  }

  private toDomain(row: DraftRow): Draft {
    const document = JSON.parse(row.documentModelJson) as Document;
    return {
      id: asDraftId(row.id),
      accountId: asAccountId(row.accountId),
      threadId: row.threadId ? asThreadId(row.threadId) : undefined,
      subject: row.subject,
      document,
      to: deserializeAddresses(row.toAddresses),
      cc: deserializeAddresses(row.ccAddresses),
      bcc: deserializeAddresses(row.bccAddresses),
      inReplyTo: row.inReplyTo ?? undefined,
      references: row.references ?? undefined,
      providerDraftRef: row.providerDraftRef ?? undefined,
      autosaveVersion: row.autosaveVersion,
      lastSavedAt: row.lastSavedAt
    };
  }
}
