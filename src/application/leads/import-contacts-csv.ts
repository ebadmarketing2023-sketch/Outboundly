import { parse } from "csv-parse/sync";
import { EmailAddress } from "../../core/shared-kernel/email-address.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";

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

export interface ImportContactsCsvResult {
  imported: number;
  skipped: Array<{ row: number; reason: string }>;
}

export async function importContactsCsv(
  csvText: string,
  contactRepository: ContactRepository
): Promise<ImportContactsCsvResult> {
  const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

  const skipped: ImportContactsCsvResult["skipped"] = [];
  let imported = 0;

  for (const [index, record] of records.entries()) {
    const rowNumber = index + 2; // +1 for 1-indexing, +1 for the header row itself

    const knownFields: Record<string, string> = {};
    const customFields: Record<string, string> = {};

    for (const [rawHeader, rawValue] of Object.entries(record)) {
      const value = (rawValue ?? "").trim();
      if (!value) continue;
      const normalized = normalizeHeader(rawHeader);
      const knownField = KNOWN_FIELD_ALIASES[normalized];
      if (knownField) {
        knownFields[knownField] = value;
      } else if (!IGNORED_HEADERS.has(normalized)) {
        customFields[rawHeader] = value;
      }
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
      await contactRepository.upsertByEmail({
        email: parsedEmail.toString(),
        firstName: knownFields.firstName,
        lastName: knownFields.lastName,
        company: knownFields.company,
        title: knownFields.title,
        timezone: knownFields.timezone,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
        source: "csv_import"
      });
      imported++;
    } catch (err) {
      skipped.push({ row: rowNumber, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { imported, skipped };
}
