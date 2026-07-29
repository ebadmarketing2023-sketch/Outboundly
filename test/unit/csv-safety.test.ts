import { describe, expect, it } from "vitest";
import { CSV_SAFETY_LIMITS, CsvTooLargeError, neutralizeCsvCell } from "../../src/core/shared-kernel/csv-safety.js";

/**
 * Section 23: "Cells beginning with =, +, -, @ are neutralized on import and re-export; field/row
 * size limits prevent pathological files from exhausting memory."
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
