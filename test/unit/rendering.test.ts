import { describe, expect, it } from "vitest";
import {
  collectVariableNames,
  emptyDocument,
  paragraph,
  resolveVariables,
  textRun,
  type Document
} from "../../src/core/rendering/document-model.js";
import { renderHtml } from "../../src/core/rendering/html-renderer.js";
import { renderPlainText } from "../../src/core/rendering/text-renderer.js";
import { parseHtmlToDocument } from "../../src/core/rendering/html-parser.js";

describe("Rendering Engine", () => {
  it("renders an empty document as empty content in both renderers", () => {
    const doc = emptyDocument();
    expect(renderHtml(doc)).toBe('<div dir="ltr"></div>');
    expect(renderPlainText(doc)).toBe("");
  });

  it("HTML and plain text renderers stay in content parity for the same document", () => {
    const doc: Document = {
      blocks: [
        paragraph(textRun("Hi "), textRun("Alex", ["bold"]), textRun(", thanks for the reply.")),
        {
          type: "quote",
          attribution: "On Mon, Jan 1, 2026, Alex wrote:",
          children: [paragraph(textRun("Sounds good."))]
        }
      ]
    };

    const html = renderHtml(doc);
    const text = renderPlainText(doc);

    expect(html).toContain("Hi <b>Alex</b>, thanks for the reply.");
    expect(html).toContain('class="gmail_quote"');
    expect(text).toContain("Hi Alex, thanks for the reply.");
    expect(text).toContain("> Sounds good.");
  });

  it("escapes HTML-significant characters but leaves plain text untouched", () => {
    const doc: Document = { blocks: [paragraph(textRun("<script>alert(1)</script> & co"))] };
    expect(renderHtml(doc)).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(renderPlainText(doc)).toContain("<script>alert(1)</script> & co");
  });

  it("collects unresolved personalization variables and resolves them", () => {
    const doc: Document = {
      blocks: [paragraph(textRun("Hi "), { type: "variable", name: "first_name" }, textRun("!"))]
    };
    expect(collectVariableNames(doc)).toEqual(["first_name"]);

    const resolved = resolveVariables(doc, { first_name: "Jordan" });
    expect(renderPlainText(resolved)).toBe("Hi Jordan!");
  });

  it("throws when rendering a document with an unresolved variable", () => {
    const doc: Document = {
      blocks: [paragraph({ type: "variable", name: "company" })]
    };
    expect(() => renderHtml(doc)).toThrow(/company/);
  });

  it("parses pasted HTML into the Internal Document Model and round-trips through both renderers", () => {
    const pasted = "<p>Hello <b>there</b>, visit <a href=\"https://example.com\">our site</a>.</p>";
    const doc = parseHtmlToDocument(pasted);

    expect(renderPlainText(doc)).toBe("Hello there, visit our site (https://example.com).");
    expect(renderHtml(doc)).toContain("Hello <b>there</b>, visit");
  });

  it("drops disallowed/unknown tags when parsing pasted HTML rather than passing them through", () => {
    const pasted = '<p>Safe text</p><script>alert("xss")</script>';
    const doc = parseHtmlToDocument(pasted);
    const html = renderHtml(doc);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert");
  });
});
