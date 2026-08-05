import { parse } from "csv-parse/sync";
import { CSV_SAFETY_LIMITS, CsvTooLargeError, denormalizeCsvCell } from "../../core/shared-kernel/csv-safety.js";
import { EmailAddress } from "../../core/shared-kernel/email-address.js";
import type { ContactId } from "../../core/shared-kernel/ids.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import type { LeadImportBatchRepository } from "../../ports/lead-import-batch-repository.port.js";

/**
 * CSV import for Leads/Contacts (Section 5.5). Real RFC-4180 parsing via csv-parse (handles
 * quoted fields with embedded commas/newlines correctly, unlike a naive split(",")), not a
 * hand-rolled parser.
 *
 * Column mapping: any column matching one of the known aliases below (case/whitespace/punctuation
 * -insensitive) maps to that contact field; every other column becomes a customFields entry,
 * keyed by its original header text. A row-level problem (missing/invalid email) is recorded and
 * skipped rather than aborting the whole import (Section 21.3's failure-isolation principle,
 * already used for inbox sync — the same reasoning applies here: one bad row in a CSV of
 * thousands shouldn't block the rest).
 */

type KnownContactField = "email" | "firstName" | "lastName" | "company" | "title" | "timezone";

const KNOWN_FIELD_ALIASES: Record<string, KnownContactField> = {
  email: "email",
  firstname: "firstName",
  lastname: "lastName",
  company: "company",
  title: "title",
  jobtitle: "title",
  timezone: "timezone"
};

/** Recognized but deliberately not captured: every contact imported through this path is always
 * stamped source: "csv_import" (see below) regardless of what a "source" column says — e.g. a
 * file produced by exportContactsCsv, which does write one — so this header is ignored rather
 * than falling through into customFields as if it were unrecognized. */
const IGNORED_HEADERS = new Set(["source"]);

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export interface MappedCsvRow {
  knownFields: Record<string, string>;
  customFields: Record<string, string>;
  /** True when some cell is over the safety limit — the importer skips such a row entirely. */
  fieldTooLong: boolean;
}

/**
 * Turns one parsed CSV record into the contact fields it would be imported as. Exported so the
 * campaign wizard's personalization preview can ask "what values would these leads actually have?"
 * against a CSV that has not been imported yet — using this exact mapping rather than a second,
 * drifting copy of the alias table.
 */
export function mapCsvRecordToContactFields(record: Record<string, string>): MappedCsvRow {
  const knownFields: Record<string, string> = {};
  const customFields: Record<string, string> = {};

  for (const [rawHeader, rawValue] of Object.entries(record)) {
    const value = (rawValue ?? "").trim();
    if (!value) continue;
    if (value.length > CSV_SAFETY_LIMITS.maxFieldLength) {
      return { knownFields, customFields, fieldTooLong: true };
    }
    // Stored verbatim, minus any escaping apostrophe the *source* file carried (exportContactsCsv
    // writes one, so this makes an export/re-import round-trip lossless). Neutralization belongs on
    // the way out, not here: the apostrophe only protects a spreadsheet app, while this value is
    // also the text a lead reads in an email -- storing it escaped sent "Saw you're at '+Post Inc."
    const safeValue = denormalizeCsvCell(value);
    const normalized = normalizeHeader(rawHeader);
    const knownField = KNOWN_FIELD_ALIASES[normalized];
    if (knownField) {
      knownFields[knownField] = safeValue;
    } else if (!IGNORED_HEADERS.has(normalized)) {
      customFields[rawHeader] = safeValue;
    }
  }

  return { knownFields, customFields, fieldTooLong: false };
}

export interface ImportContactsCsvResult {
  imported: number;
  skipped: Array<{ row: number; reason: string }>;
  /** The import batch this run created (Critical Improvement #3) — every successfully
   * imported/updated contact below is tagged with this id, whether it's new or a re-import. */
  batchId: string;
  /** Every contact id touched by this run, in row order — a campaign-specific CSV upload
   * (Critical Improvement #2) enrolls exactly these ids and nothing else. */
  contactIds: string[];
}

export async function importContactsCsv(
  csvText: string,
  contactRepository: ContactRepository,
  leadImportBatchRepository: LeadImportBatchRepository,
  filename: string
): Promise<ImportContactsCsvResult> {
  if (csvText.length > CSV_SAFETY_LIMITS.maxTextLength) {
    throw new CsvTooLargeError(
      `CSV is too large (${csvText.length} characters, max ${CSV_SAFETY_LIMITS.maxTextLength}) — checked before parsing to avoid exhausting memory on a pathological file`
    );
  }

  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

  if (records.length > CSV_SAFETY_LIMITS.maxRows) {
    throw new CsvTooLargeError(`CSV has too many rows (${records.length}, max ${CSV_SAFETY_LIMITS.maxRows})`);
  }

  const skipped: ImportContactsCsvResult["skipped"] = [];
  const contactIds: ContactId[] = [];
  let imported = 0;

  const batch = await leadImportBatchRepository.create({ filename, importedAt: new Date() });

  for (const [index, record] of records.entries()) {
    const rowNumber = index + 2; // +1 for 1-indexing, +1 for the header row itself

    const { knownFields, customFields, fieldTooLong } = mapCsvRecordToContactFields(record);

    if (fieldTooLong) {
      skipped.push({ row: rowNumber, reason: `A field exceeds the maximum allowed length (${CSV_SAFETY_LIMITS.maxFieldLength} characters)` });
      continue;
    }

    const emailRaw = knownFields.email;
    if (!emailRaw) {
      skipped.push({ row: rowNumber, reason: "No email column value present" });
      continue;
    }

    const parsedEmail = EmailAddress.tryParse(emailRaw);
    if (!parsedEmail) {
      skipped.push({ row: rowNumber, reason: `"${emailRaw}" is not a valid email address` });
      continue;
    }

    try {
      const contact = await contactRepository.upsertByEmail({
        email: parsedEmail.toString(),
        firstName: knownFields.firstName,
        lastName: knownFields.lastName,
        company: knownFields.company,
        title: knownFields.title,
        timezone: knownFields.timezone,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        source: "csv_import",
        importBatchId: batch.id
      });
      contactIds.push(contact.id);
      imported++;
    } catch (err) {
      skipped.push({ row: rowNumber, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { imported, skipped, batchId: batch.id, contactIds };
}
