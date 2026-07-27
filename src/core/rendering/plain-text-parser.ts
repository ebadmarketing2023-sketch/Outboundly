import type { Document, ParagraphBlock } from "./document-model.js";
import { paragraph, textRun } from "./document-model.js";

/**
 * Parses plain typed text into the Internal Document Model (Section 8.1) — the plain-text
 * counterpart to html-parser.ts's parseHtmlToDocument.
 *
 * Matches real Gmail compose behavior exactly: every Enter press starts a new line, full stop —
 * Gmail's own contenteditable box has no separate "soft break within a paragraph" concept the
 * way word processors distinguish Enter from Shift+Enter, and a plain `<textarea>` can't make
 * that distinction at all (there is no Shift+Enter signal to capture). So every typed line
 * becomes its own paragraph block; a blank line is simply an empty paragraph, which the HTML
 * renderer turns into <div><br></div> (Section 8.4) exactly the way Gmail's own compose does.
 */
export function parsePlainTextToDocument(text: string): Document {
  const lines = text.split("\n");
  const blocks: ParagraphBlock[] = lines.map((line) => (line.length === 0 ? paragraph() : paragraph(textRun(line))));

  return { blocks: blocks.length > 0 ? blocks : [paragraph()] };
}
