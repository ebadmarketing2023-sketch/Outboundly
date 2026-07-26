import { describe, expect, it } from "vitest";
import { parsePlainTextToDocument } from "../../src/core/rendering/plain-text-parser.js";
import { renderHtml } from "../../src/core/rendering/html-renderer.js";
import { renderPlainText } from "../../src/core/rendering/text-renderer.js";

describe("parsePlainTextToDocument (line-break vs paragraph-break detection)", () => {
  it("treats a single Enter as a line break within the same paragraph, not a new paragraph", () => {
    const doc = parsePlainTextToDocument("Line one\nLine two");
    expect(doc.blocks).toHaveLength(1);

    const html = renderHtml(doc);
    expect(html).toBe('<div dir="ltr"><div>Line one<br>Line two</div></div>');

    const text = renderPlainText(doc);
    expect(text).toBe("Line one\nLine two");
  });

  it("treats a blank line (double Enter) as a new paragraph", () => {
    const doc = parsePlainTextToDocument("First paragraph.\n\nSecond paragraph.");
    expect(doc.blocks).toHaveLength(2);

    const html = renderHtml(doc);
    expect(html).toBe('<div dir="ltr"><div>First paragraph.</div><div>Second paragraph.</div></div>');
  });

  it("handles the exact case reported: a closing line and a signature separated by one Enter", () => {
    const doc = parsePlainTextToDocument(
      "Hey Evan, this is Ebad. I'll complete this soon.\nRegards, Syed Ebad."
    );
    const html = renderHtml(doc);
    expect(html).toContain("I'll complete this soon.<br>Regards, Syed Ebad.");
  });

  it("collapses 3+ blank lines the same as exactly one blank line between paragraphs", () => {
    const doc = parsePlainTextToDocument("A\n\n\n\nB");
    expect(doc.blocks).toHaveLength(2);
  });

  it("returns a single empty paragraph for empty input rather than an empty block list", () => {
    const doc = parsePlainTextToDocument("");
    expect(doc.blocks).toHaveLength(1);
    expect(renderPlainText(doc)).toBe("");
  });
});
