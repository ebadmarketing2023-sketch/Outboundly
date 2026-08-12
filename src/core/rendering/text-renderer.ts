import type { BlockNode, Document, InlineNode, LinkRun, TextRun } from "./document-model.js";
import { MissingPersonalizationValueError } from "./document-model.js";

/**
 * Serializes the same Internal Document Model consumed by html-renderer.ts into a genuine
 * plain-text alternative (Section 8.2) — never a derived-by-stripping-tags stub. Because both
 * renderers read from the same source, the HTML and plain-text parts can only ever differ in
 * presentation, never in substance.
 */

function renderTextRun(run: TextRun): string {
  return run.text;
}

function renderLinkRun(link: LinkRun): string {
  const label = link.children.map(renderTextRun).join("");
  return label === link.href ? link.href : `${label} (${link.href})`;
}

function renderInline(node: InlineNode): string {
  switch (node.type) {
    case "text":
      return renderTextRun(node);
    case "link":
      return renderLinkRun(node);
    case "break":
      return "\n";
    case "variable":
      throw new MissingPersonalizationValueError(node.name);
  }
}

function indentQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function renderBlock(block: BlockNode): string {
  switch (block.type) {
    case "paragraph":
      return block.children.map(renderInline).join("");
    case "list":
      return block.items
        .map((item, index) => {
          const prefix = block.ordered ? `${index + 1}. ` : "- ";
          return prefix + item.map(renderInline).join("");
        })
        .join("\n");
    case "quote": {
      // "\n", not "\n\n": Section 8.4's per-line paragraph model already represents a blank line
      // as its own empty paragraph, exactly as renderPlainText's own top-level join assumes.
      // Joining with "\n\n" here doubled every blank line inside a quoted message, so a quoted
      // three-line email came back with two blank lines between each of its lines.
      const attribution = block.attribution ? `${block.attribution}\n` : "";
      const inner = block.children.map(renderBlock).join("\n");
      return attribution + indentQuote(inner);
    }
    case "image":
      return `[image: ${block.alt ?? block.contentId}]`;
  }
}

export function renderPlainText(document: Document): string {
  // A single "\n" between top-level blocks, not "\n\n": Section 8.4's per-line paragraph model
  // means blank lines are already their own (empty) paragraph blocks in the sequence, so a
  // single join separator reproduces the original typed spacing exactly rather than doubling it.
  return document.blocks.map(renderBlock).join("\n");
}
