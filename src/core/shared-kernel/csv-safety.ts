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

/**
 * Applied when *writing* a CSV, never to stored data. The apostrophe exists to stop a spreadsheet
 * app from evaluating the cell, and a spreadsheet file is the only place that risk exists -- but
 * this same value is also the text a lead reads in an email. Neutralizing on import meant a
 * company named "+Post Inc" or a title like "-Head of Growth" was *stored* mangled, so the lead
 * received "Saw you're at '+Post Inc." That was invisible while personalization was broken; it is
 * not any more.
 */
/** A value needs escaping if it opens with a formula character -- or if it opens with an
 * apostrophe that is itself sitting in front of one, since the reader below would otherwise
 * mistake the user's own apostrophe for an escape and eat it. */
function needsEscape(value: string): boolean {
  if (DANGEROUS_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;
  return value.startsWith("'") && needsEscape(value.slice(1));
}

export function neutralizeCsvCell(value: string): string {
  return needsEscape(value) ? `'${value}` : value;
}

/**
 * The exact inverse, applied when *reading* a CSV, so an export/re-import round-trips a value
 * unchanged instead of accumulating apostrophes. It strips a leading apostrophe only when what
 * follows is something neutralizeCsvCell would itself have escaped — so "'Tis Season Ltd" and
 * "O'Brien & Co" survive untouched, while the escape this app writes is undone exactly.
 */
export function denormalizeCsvCell(value: string): string {
  return value.startsWith("'") && needsEscape(value.slice(1)) ? value.slice(1) : value;
}

/** Generous upper bounds for a "CSV of contacts" use case -- well beyond any realistic legitimate
 * file, just enough to reject a pathological one before it can exhaust memory. */
export const CSV_SAFETY_LIMITS = {
  maxTextLength: 20 * 1024 * 1024, // 20MB of raw CSV text, checked before parsing at all
  maxRows: 100_000,
  maxFieldLength: 10_000 // characters per cell
} as const;

export class CsvTooLargeError extends Error {}
