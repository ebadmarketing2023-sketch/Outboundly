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
}
