import type { Document, InlineNode, ParagraphBlock } from "./document-model.js";
import { paragraph, textRun } from "./document-model.js";

/**
 * Parses plain typed text into the Internal Document Model (Section 8.1) — the plain-text
 * counterpart to html-parser.ts's parseHtmlToDocument. Mirrors the convention every Gmail-like
 * compose box uses: a blank line (two or more consecutive newlines) starts a new paragraph,
 * while a single newline is a line break *within* the current paragraph, not a paragraph break.
 *
 * Getting this distinction right matters: collapsing a single Enter press into nothing (as the
 * naive `text.split("\n\n")` version of this function used to) silently drops the writer's
 * intended line breaks from the sent message.
 */
export function parsePlainTextToDocument(text: string): Document {
  const paragraphTexts = text.split(/\n{2,}/);
  const blocks: ParagraphBlock[] = paragraphTexts.map((paragraphText) => {
    const lines = paragraphText.split("\n");
    const children: InlineNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) children.push({ type: "break" });
      children.push(textRun(line));
    });
    return paragraph(...children);
  });

  return { blocks: blocks.length > 0 ? blocks : [paragraph()] };
}
