import { parse, type HTMLElement, type Node, NodeType } from "node-html-parser";
import type {
  BlockNode,
  Document,
  InlineNode,
  Mark,
  ParagraphBlock
} from "./document-model.js";
import { textRun } from "./document-model.js";

/**
 * Parses pasted/imported HTML into the Internal Document Model (Section 8.1). This is the one
 * place external HTML enters the pipeline; anything outside the allowed node schema below is
 * dropped or normalized here, so no unconstrained HTML ever reaches the renderers or MIME builder.
 */

const BLOCK_TAGS = new Set(["p", "div"]);
const LIST_TAGS = new Set(["ul", "ol"]);
/** Dropped entirely, including their content — never unwrapped like a merely-unstyled tag. */
const DROPPED_TAGS = new Set(["script", "style", "head", "meta", "iframe", "object", "noscript", "link"]);
const MARK_TAGS: Record<string, Mark> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline"
};

function collectInline(node: Node, marks: Mark[] = []): InlineNode[] {
  if (node.nodeType === NodeType.TEXT_NODE) {
    const text = node.rawText;
    if (!text) return [];
    return [textRun(text, marks)];
  }

  if (node.nodeType !== NodeType.ELEMENT_NODE) return [];
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase();

  if (tag && DROPPED_TAGS.has(tag)) return [];

  if (tag === "br") return [{ type: "break" }];

  if (tag === "a") {
    const href = el.getAttribute("href") ?? "";
    const children = el.childNodes.flatMap((child) => collectInline(child, marks));
    const textRuns = children.filter((c): c is Extract<InlineNode, { type: "text" }> => c.type === "text");
    return [{ type: "link", href, children: textRuns }];
  }

  const nextMarks = tag && MARK_TAGS[tag] ? [...marks, MARK_TAGS[tag]] : marks;
  return el.childNodes.flatMap((child) => collectInline(child, nextMarks));
}

function parseParagraph(el: HTMLElement): ParagraphBlock {
  return { type: "paragraph", children: el.childNodes.flatMap((c) => collectInline(c)) };
}

function parseBlocks(nodes: Node[]): BlockNode[] {
  const blocks: BlockNode[] = [];
  let pendingInline: InlineNode[] = [];

  const flushPending = () => {
    if (pendingInline.length > 0) {
      blocks.push({ type: "paragraph", children: pendingInline });
      pendingInline = [];
    }
  };

  for (const node of nodes) {
    if (node.nodeType === NodeType.TEXT_NODE) {
      pendingInline.push(...collectInline(node));
      continue;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) continue;

    const el = node as HTMLElement;
    const tag = el.tagName?.toLowerCase();

    if (tag && BLOCK_TAGS.has(tag)) {
      flushPending();
      blocks.push(parseParagraph(el));
    } else if (tag && LIST_TAGS.has(tag)) {
      flushPending();
      const items = el.childNodes
        .filter((c) => c.nodeType === NodeType.ELEMENT_NODE && (c as HTMLElement).tagName?.toLowerCase() === "li")
        .map((li) => (li as HTMLElement).childNodes.flatMap((c) => collectInline(c)));
      blocks.push({ type: "list", ordered: tag === "ol", items });
    } else if (tag === "blockquote") {
      flushPending();
      blocks.push({ type: "quote", children: parseBlocks(el.childNodes) });
    } else if (tag === "img") {
      flushPending();
      const src = el.getAttribute("src") ?? "";
      const contentId = src.startsWith("cid:") ? src.slice(4) : src;
      blocks.push({ type: "image", contentId, alt: el.getAttribute("alt") });
    } else if (!tag || !DROPPED_TAGS.has(tag)) {
      pendingInline.push(...collectInline(el));
    }
  }

  flushPending();
  return blocks;
}

export function parseHtmlToDocument(html: string): Document {
  const root = parse(html);
  return { blocks: parseBlocks(root.childNodes) };
}
