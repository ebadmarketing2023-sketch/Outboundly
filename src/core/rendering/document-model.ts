/**
 * The Internal Document Model (Section 8.1) — the single source of truth for message content.
 * The compose editor writes into this directly; pasted/imported HTML is parsed into it
 * (html-parser.ts); nothing downstream ever sees a raw HTML string until the HTML Renderer
 * produces one.
 */

export type Mark = "bold" | "italic" | "underline";

export interface TextRun {
  type: "text";
  text: string;
  marks: Mark[];
}

export interface LinkRun {
  type: "link";
  href: string;
  children: TextRun[];
}

/** An unresolved personalization token, e.g. {{first_name}}. Resolved into TextRun(s) by resolveVariables. */
export interface VariableRun {
  type: "variable";
  name: string;
}

export interface LineBreakNode {
  type: "break";
}

export type InlineNode = TextRun | LinkRun | VariableRun | LineBreakNode;

export interface ParagraphBlock {
  type: "paragraph";
  children: InlineNode[];
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: InlineNode[][];
}

/** A reply/forward quote block, rendered as a Gmail-style attributed blockquote (Section 8.4). */
export interface QuoteBlock {
  type: "quote";
  attribution?: string;
  children: BlockNode[];
}

/** An inline image referenced by Content-ID, matched to a MIME part (Section 6). */
export interface ImageBlock {
  type: "image";
  contentId: string;
  alt?: string;
}

export type BlockNode = ParagraphBlock | ListBlock | QuoteBlock | ImageBlock;

export interface Document {
  blocks: BlockNode[];
}

export function textRun(text: string, marks: Mark[] = []): TextRun {
  return { type: "text", text, marks };
}

export function paragraph(...children: InlineNode[]): ParagraphBlock {
  return { type: "paragraph", children };
}

export function emptyDocument(): Document {
  return { blocks: [] };
}

/** Every unresolved {{variable}} token still present in the document, in first-seen order. */
export function collectVariableNames(document: Document): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const visitInline = (node: InlineNode): void => {
    if (node.type === "variable" && !seen.has(node.name)) {
      seen.add(node.name);
      names.push(node.name);
    }
  };

  const visitBlock = (block: BlockNode): void => {
    if (block.type === "paragraph") {
      block.children.forEach(visitInline);
    } else if (block.type === "list") {
      block.items.forEach((item) => item.forEach(visitInline));
    } else if (block.type === "quote") {
      block.children.forEach(visitBlock);
    }
  };

  document.blocks.forEach(visitBlock);
  return names;
}

/**
 * Personalization (Section 9.2, stage 3): replaces every VariableRun with a resolved TextRun.
 * Missing values are a hard stop — the caller is expected to check collectVariableNames()
 * against the available contact fields before calling this, per the "Hi {{first_name}}," rule.
 */
export class MissingPersonalizationValueError extends Error {
  constructor(readonly variableName: string) {
    super(`No value supplied for personalization variable "${variableName}"`);
    this.name = "MissingPersonalizationValueError";
  }
}

export function resolveVariables(document: Document, values: Record<string, string>): Document {
  const resolveInline = (node: InlineNode): InlineNode => {
    if (node.type !== "variable") return node;
    const value = values[node.name];
    if (value === undefined) throw new MissingPersonalizationValueError(node.name);
    return textRun(value);
  };

  const resolveBlock = (block: BlockNode): BlockNode => {
    if (block.type === "paragraph") {
      return { ...block, children: block.children.map(resolveInline) };
    }
    if (block.type === "list") {
      return { ...block, items: block.items.map((item) => item.map(resolveInline)) };
    }
    if (block.type === "quote") {
      return { ...block, children: block.children.map(resolveBlock) };
    }
    return block;
  };

  return { blocks: document.blocks.map(resolveBlock) };
}
