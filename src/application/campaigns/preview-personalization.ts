import { parse } from "csv-parse/sync";
import { previewPersonalization } from "../../core/campaigns/personalization-preview.js";
import type { PersonalizationPreview } from "../../core/campaigns/personalization-preview.js";
import { contactFieldsToPersonalizationValues } from "../../core/campaigns/personalize.js";
import { CSV_SAFETY_LIMITS, CsvTooLargeError } from "../../core/shared-kernel/csv-safety.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import { mapCsvRecordToContactFields } from "../leads/import-contacts-csv.js";

/**
 * Runs the campaign wizard's copy against the leads it is about to be launched with, before
 * anything is written, so a token no lead has a value for is a warning on the Review step instead
 * of a silent per-contact skip weeks into the campaign.
 *
 * Reads only — it deliberately does not import the CSV, because the user may still go back and
 * change the copy or the file. That means the CSV is parsed twice (once here, once at launch), a
 * trivial cost for a file bounded by CSV_SAFETY_LIMITS.
 */

export interface PreviewCampaignPersonalizationDeps {
  contactRepository: ContactRepository;
}

export type PreviewLeadsSource = { type: "csv"; csvText: string } | { type: "batch"; batchId: string };

export interface PreviewCampaignPersonalizationRequest {
  /** Every subject and body the campaign will send, first-touch groups and follow-ups alike. */
  texts: string[];
  leadsSource: PreviewLeadsSource;
}

export async function previewCampaignPersonalization(
  deps: PreviewCampaignPersonalizationDeps,
  request: PreviewCampaignPersonalizationRequest
): Promise<PersonalizationPreview> {
  const leadValues =
    request.leadsSource.type === "csv"
      ? valuesFromCsv(request.leadsSource.csvText)
      : await valuesFromBatch(deps, request.leadsSource.batchId);

  return previewPersonalization(request.texts, leadValues);
}

function valuesFromCsv(csvText: string): Array<Record<string, string>> {
  if (csvText.length > CSV_SAFETY_LIMITS.maxTextLength) {
    throw new CsvTooLargeError(`CSV is too large (${csvText.length} characters, max ${CSV_SAFETY_LIMITS.maxTextLength})`);
  }

  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  if (records.length > CSV_SAFETY_LIMITS.maxRows) {
    throw new CsvTooLargeError(`CSV has too many rows (${records.length}, max ${CSV_SAFETY_LIMITS.maxRows})`);
  }

  const values: Array<Record<string, string>> = [];
  for (const record of records) {
    const { knownFields, customFields, fieldTooLong } = mapCsvRecordToContactFields(record);
    // Rows the importer will refuse (over-long field, no/invalid email) are left out rather than
    // counted as leads with missing values -- they are never going to become contacts at all, so
    // counting them would overstate the personalization problem.
    if (fieldTooLong || !knownFields.email) continue;
    values.push(
      contactFieldsToPersonalizationValues({
        email: knownFields.email,
        firstName: knownFields.firstName,
        lastName: knownFields.lastName,
        company: knownFields.company,
        title: knownFields.title,
        timezone: knownFields.timezone,
        customFields
      })
    );
  }
  return values;
}

async function valuesFromBatch(
  deps: PreviewCampaignPersonalizationDeps,
  batchId: string
): Promise<Array<Record<string, string>>> {
  const contacts = await deps.contactRepository.list();
  return contacts.filter((c) => c.importBatchId === batchId).map(contactFieldsToPersonalizationValues);
}
