/**
 * CSV safety (Section 23: "Cells beginning with =, +, -, @ are neutralized on import and
 * re-export; field/row size limits prevent pathological files from exhausting memory").
 *
 * Formula injection: a spreadsheet app (Excel, Google Sheets, LibreOffice) treats a cell starting
 * with one of these four characters as a formula, not literal text — a contact's "company" field
 * containing `=HYPERLINK("http://evil.example","click")` or a DDE/command-execution payload like
 * `=cmd|'/c calc'!A1` would silently execute if someone later opens an exported CSV. The standard,
 * widely-used mitigation (the same one Excel/Sheets themselves apply when a user types a leading
 * apostrophe) is to prefix the value with `'` so it's forced back to literal text.
 */

const DANGEROUS_PREFIXES = ["=", "+", "-", "@"];

export function neutralizeCsvCell(value: string): string {
  if (DANGEROUS_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return `'${value}`;
  }
  return value;
}

/** Generous upper bounds for a "CSV of contacts" use case -- well beyond any realistic legitimate
 * file, just enough to reject a pathological one before it can exhaust memory. */
export const CSV_SAFETY_LIMITS = {
  maxTextLength: 20 * 1024 * 1024, // 20MB of raw CSV text, checked before parsing at all
  maxRows: 100_000,
  maxFieldLength: 10_000 // characters per cell
} as const;

export class CsvTooLargeError extends Error {}
