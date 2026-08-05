import { describe, expect, it } from "vitest";
import { CSV_SAFETY_LIMITS, CsvTooLargeError, denormalizeCsvCell, neutralizeCsvCell } from "../../src/core/shared-kernel/csv-safety.js";

/**
 * Section 23: "Cells beginning with =, +, -, @ are neutralized ... field/row size limits prevent
 * pathological files from exhausting memory."
 *
 * Neutralization applies when writing a CSV only. Doing it on import corrupted the stored value,
 * which is also the text a lead reads in an email -- see neutralizeCsvCell's own comment.
 */
describe("neutralizeCsvCell", () => {
  it.each(["=cmd|'/c calc'!A1", "+1+1", "-1+1", "@SUM(1+1)"])(
    "prefixes a cell starting with a formula-triggering character (%s) with an apostrophe",
    (value) => {
      expect(neutralizeCsvCell(value)).toBe(`'${value}`);
    }
  );

  it("leaves an ordinary value untouched", () => {
    expect(neutralizeCsvCell("Acme, Inc.")).toBe("Acme, Inc.");
  });

  it("leaves an empty string untouched", () => {
    expect(neutralizeCsvCell("")).toBe("");
  });

  it("does not neutralize a dangerous character that isn't in the leading position", () => {
    expect(neutralizeCsvCell("Jane=Doe")).toBe("Jane=Doe");
  });
});

describe("denormalizeCsvCell", () => {
  it.each(["=cmd|'/c calc'!A1", "+1+1", "-1+1", "@SUM(1+1)"])("undoes the escape this module adds (%s)", (value) => {
    expect(denormalizeCsvCell(neutralizeCsvCell(value))).toBe(value);
  });

  it("leaves an apostrophe that is part of the actual value alone", () => {
    expect(denormalizeCsvCell("'Tis Season Ltd")).toBe("'Tis Season Ltd");
    expect(denormalizeCsvCell("O'Brien & Co")).toBe("O'Brien & Co");
  });

  it("round-trips a value that itself begins with an apostrophe in front of a formula character", () => {
    // The one case a naive one-character strip would corrupt: the user's own apostrophe would be
    // eaten as if it were the escape. Export writes a second one precisely so this survives.
    expect(neutralizeCsvCell("'=x")).toBe("''=x");
    expect(denormalizeCsvCell("''=x")).toBe("'=x");
  });

  it("leaves an ordinary value and an empty string untouched", () => {
    expect(denormalizeCsvCell("Acme, Inc.")).toBe("Acme, Inc.");
    expect(denormalizeCsvCell("")).toBe("");
  });
});

describe("CsvTooLargeError", () => {
  it("is a real Error subclass carrying the given message", () => {
    const err = new CsvTooLargeError("too big");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("too big");
  });
});

describe("CSV_SAFETY_LIMITS", () => {
  it("defines generous but finite bounds", () => {
    expect(CSV_SAFETY_LIMITS.maxTextLength).toBeGreaterThan(0);
    expect(CSV_SAFETY_LIMITS.maxRows).toBeGreaterThan(0);
    expect(CSV_SAFETY_LIMITS.maxFieldLength).toBeGreaterThan(0);
  });
});
