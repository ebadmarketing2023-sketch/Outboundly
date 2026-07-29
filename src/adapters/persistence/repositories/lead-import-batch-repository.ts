import { desc, eq } from "drizzle-orm";
import { asLeadImportBatchId, generateId, type LeadImportBatchId } from "../../../core/shared-kernel/ids.js";
import type {
  LeadImportBatch,
  LeadImportBatchRepository,
  NewLeadImportBatchInput
} from "../../../ports/lead-import-batch-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { leadImportBatches as batchesTable } from "../schema.js";

type BatchRow = typeof batchesTable.$inferSelect;

function toDomain(row: BatchRow): LeadImportBatch {
  return { id: asLeadImportBatchId(row.id), filename: row.filename, importedAt: row.importedAt };
}

/** SQLite-backed implementation of LeadImportBatchRepository (Critical Improvement #3). */
export class SqliteLeadImportBatchRepository implements LeadImportBatchRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewLeadImportBatchInput): Promise<LeadImportBatch> {
    const id = generateId();
    this.db.insert(batchesTable).values({ id, filename: input.filename, importedAt: input.importedAt }).run();
    const created = this.db.select().from(batchesTable).where(eq(batchesTable.id, id)).get();
    return toDomain(created!);
  }

  async list(): Promise<LeadImportBatch[]> {
    return this.db.select().from(batchesTable).orderBy(desc(batchesTable.importedAt)).all().map(toDomain);
  }

  async findById(id: LeadImportBatchId): Promise<LeadImportBatch | undefined> {
    const row = this.db.select().from(batchesTable).where(eq(batchesTable.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  async delete(id: LeadImportBatchId): Promise<void> {
    this.db.delete(batchesTable).where(eq(batchesTable.id, id)).run();
  }
}
