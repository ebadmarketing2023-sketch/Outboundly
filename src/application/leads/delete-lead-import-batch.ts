import { eq } from "drizzle-orm";
import { contacts as contactsTable } from "../../adapters/persistence/schema.js";
import { asContactId, type LeadImportBatchId } from "../../core/shared-kernel/ids.js";
import type { LeadImportBatchRepository } from "../../ports/lead-import-batch-repository.port.js";
import type { DeleteContactDeps } from "./delete-contact.js";
import { deleteContact } from "./delete-contact.js";

export interface DeleteLeadImportBatchDeps extends DeleteContactDeps {
  leadImportBatchRepository: LeadImportBatchRepository;
}

/**
 * Deletes an entire CSV import at once (Critical Improvement #3's "delete a specific upload"),
 * rather than one lead at a time. Every contact ever tagged with this batch (including one already
 * soft-deleted individually) goes through the same deleteContact path -- stopping its active
 * enrollments first, then soft-deleting it -- so campaign statistics stay accurate exactly as they
 * would for a manual per-lead delete. contacts.import_batch_id is then cleared for the whole batch
 * (a real FK to lead_import_batches) so the batch row itself can be removed, which is what makes it
 * disappear from the Leads screen's group switcher.
 */
export async function deleteLeadImportBatch(deps: DeleteLeadImportBatchDeps, batchId: LeadImportBatchId): Promise<void> {
  const rows = deps.db
    .select({ id: contactsTable.id, deletedAt: contactsTable.deletedAt })
    .from(contactsTable)
    .where(eq(contactsTable.importBatchId, batchId))
    .all();

  for (const row of rows) {
    if (!row.deletedAt) await deleteContact(deps, asContactId(row.id));
  }

  deps.db.update(contactsTable).set({ importBatchId: null }).where(eq(contactsTable.importBatchId, batchId)).run();
  await deps.leadImportBatchRepository.delete(batchId);
}
