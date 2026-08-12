import type {
  BlockNode,
  Document,
  InlineNode,
  LinkRun,
  TextRun
} from "./document-model.js";
import { MissingPersonalizationValueError } from "./document-model.js";

/**
 * Serializes the Internal Document Model into clean, constrained HTML (Section 8.2-8.4).
 * This is a closed serializer over a known node schema — it never passes arbitrary content
 * through, so it cannot emit an unclosed tag or a disallowed element (Section 8.3).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function renderTextRun(run: TextRun): string {
  let html = escapeHtml(run.text);
  if (run.marks.includes("bold")) html = `<b>${html}</b>`;
  if (run.marks.includes("italic")) html = `<i>${html}</i>`;
  if (run.marks.includes("underline")) html = `<u>${html}</u>`;
  return html;
}

function renderLinkRun(link: LinkRun): string {
  const inner = link.children.map(renderTextRun).join("");
  return `<a href="${escapeAttr(link.href)}">${inner}</a>`;
}

function renderInline(node: InlineNode): string {
  switch (node.type) {
    case "text":
      return renderTextRun(node);
    case "link":
      return renderLinkRun(node);
    case "break":
      return "<br>";
    case "variable":
      throw new MissingPersonalizationValueError(node.name);
  }
}

function renderBlock(block: BlockNode): string {
  switch (block.type) {
    case "paragraph": {
      // A paragraph with no children represents a blank typed line (Section 8.4): Gmail's own
      // compose renders that as <div><br></div>, not an empty <div></div> — a bare empty div
      // has no content to establish a line box and can collapse to zero height in some clients.
      if (block.children.length === 0) return "<div><br></div>";
      return `<div>${block.children.map(renderInline).join("")}</div>`;
    }
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li>${item.map(renderInline).join("")}</li>`)
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "quote": {
      // Gmail's own reply markup, matched structurally: a gmail_quote wrapper around a
      // dir="ltr" gmail_attr attribution line and a gmail_quote blockquote. The wrapper and the
      // class names are what a receiving client's trimming heuristic looks for when deciding to
      // collapse the quoted history behind the "..." control, so a follow-up that carries its
      // previous message reads as a reply rather than as a wall of repeated text.
      const attribution = block.attribution
        ? `<div dir="ltr" class="gmail_attr">${escapeHtml(block.attribution)}<br></div>`
        : "";
      const inner = block.children.map(renderBlock).join("");
      return (
        `<div class="gmail_quote">${attribution}<blockquote class="gmail_quote" ` +
        `style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote></div>`
      );
    }
    case "image":
      return `<img src="cid:${escapeAttr(block.contentId)}" alt="${escapeAttr(block.alt ?? "")}">`;
  }
}

/**
 * Renders a fully personalized Document (no remaining VariableRun nodes) into HTML.
 * Throws MissingPersonalizationValueError if an unresolved token slipped through — that error
 * belongs at the Personalization stage (Section 9.2, stage 3), not here, so surfacing it late
 * is treated as a pipeline bug, not a normal user-facing validation path.
 */
export function renderHtml(document: Document): string {
  const body = document.blocks.map(renderBlock).join("");
  return `<div dir="ltr">${body}</div>`;
}
