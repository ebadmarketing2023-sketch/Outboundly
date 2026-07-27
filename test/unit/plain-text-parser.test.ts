import { describe, expect, it } from "vitest";
import { parsePlainTextToDocument } from "../../src/core/rendering/plain-text-parser.js";
import { renderHtml } from "../../src/core/rendering/html-renderer.js";
import { renderPlainText } from "../../src/core/rendering/text-renderer.js";

describe("parsePlainTextToDocument (Section 8.4: matches Gmail's real per-line behavior)", () => {
  it("gives every typed line its own <div>, matching Gmail's own compose exactly", () => {
    const doc = parsePlainTextToDocument("Line one\nLine two");
    expect(doc.blocks).toHaveLength(2);

    const html = renderHtml(doc);
    expect(html).toBe('<div dir="ltr"><div>Line one</div><div>Line two</div></div>');

    const text = renderPlainText(doc);
    expect(text).toBe("Line one\nLine two");
  });

  it("renders a blank line as <div><br></div>, not a bare empty <div></div>", () => {
    const doc = parsePlainTextToDocument("First paragraph.\n\nSecond paragraph.");
    expect(doc.blocks).toHaveLength(3); // "First paragraph.", "", "Second paragraph."

    const html = renderHtml(doc);
    expect(html).toBe(
      '<div dir="ltr"><div>First paragraph.</div><div><br></div><div>Second paragraph.</div></div>'
    );

    // Plain text reproduces the original spacing exactly.
    expect(renderPlainText(doc)).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("handles the exact case reported: a closing line and a signature separated by one Enter", () => {
    const doc = parsePlainTextToDocument(
      "Hey Evan, this is Ebad. I'll complete this soon.\nRegards, Syed Ebad."
    );
    const html = renderHtml(doc);
    expect(html).toContain("<div>Hey Evan, this is Ebad. I'll complete this soon.</div><div>Regards, Syed Ebad.</div>");
  });

  it("preserves multiple consecutive blank lines exactly, without collapsing them", () => {
    const doc = parsePlainTextToDocument("A\n\n\n\nB");
    // "A", "", "", "", "B" — three blank lines between A and B, none collapsed, matching
    // real Gmail behavior where pressing Enter multiple times keeps every blank line.
    expect(doc.blocks).toHaveLength(5);
    expect(renderPlainText(doc)).toBe("A\n\n\n\nB");
  });

  it("returns a single empty paragraph for empty input rather than an empty block list", () => {
    const doc = parsePlainTextToDocument("");
    expect(doc.blocks).toHaveLength(1);
    expect(renderPlainText(doc)).toBe("");
    expect(renderHtml(doc)).toBe('<div dir="ltr"><div><br></div></div>');
  });
});
