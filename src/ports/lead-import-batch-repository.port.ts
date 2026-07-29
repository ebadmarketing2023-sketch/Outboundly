import type { LeadImportBatchId } from "../core/shared-kernel/ids.js";

/** A single CSV import event (Critical Improvement #3) — the unit the Leads screen groups
 * contacts by, and the unit a campaign-specific CSV upload (Critical Improvement #2) enrolls. */
export interface LeadImportBatch {
  id: LeadImportBatchId;
  filename: string;
  importedAt: Date;
}

export interface NewLeadImportBatchInput {
  filename: string;
  importedAt: Date;
}

export interface LeadImportBatchRepository {
  create(input: NewLeadImportBatchInput): Promise<LeadImportBatch>;
  list(): Promise<LeadImportBatch[]>;
  findById(id: LeadImportBatchId): Promise<LeadImportBatch | undefined>;
  /** The caller is responsible for clearing contacts.importBatchId for every contact tagged with
   * this batch first (see deleteLeadImportBatch) -- contacts.import_batch_id is a real FK, so this
   * throws if any row still references it. */
  delete(id: LeadImportBatchId): Promise<void>;
}
