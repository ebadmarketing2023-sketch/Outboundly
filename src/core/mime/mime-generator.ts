import type { MimePart } from "./types.js";

/**
 * MIME Generation (Section 9.2, stage 8 / Section 9.3): builds the structurally correct
 * multipart tree. Only concerned with shape — boundary strings, header folding, and encoding
 * are all Canonicalization's job (Section 9.4), kept deliberately separate so each stage has
 * its own narrow, independently testable contract.
 */

export interface InlineImageInput {
  contentId: string;
  contentType: string;
  /** Base64-encoded binary data. */
  dataBase64: string;
}

export interface AttachmentInput {
  filename: string;
  contentType: string;
  /** Base64-encoded binary data. */
  dataBase64: string;
}

export interface GeneratedContent {
  html: string;
  text: string;
  inlineImages?: InlineImageInput[];
  attachments?: AttachmentInput[];
}

export function generateMimeTree(content: GeneratedContent): MimePart {
  const textPart: MimePart = {
    contentType: 'text/plain; charset="UTF-8"',
    headers: [],
    encoding: "quoted-printable",
    body: content.text
  };

  const htmlPart: MimePart = {
    contentType: 'text/html; charset="UTF-8"',
    headers: [],
    encoding: "quoted-printable",
    body: content.html
  };

  let root: MimePart = {
    contentType: "multipart/alternative",
    headers: [],
    encoding: "7bit",
    parts: [textPart, htmlPart]
  };

  if (content.inlineImages && content.inlineImages.length > 0) {
    const imageParts: MimePart[] = content.inlineImages.map((img) => ({
      contentType: img.contentType,
      headers: [
        { name: "Content-ID", value: `<${img.contentId}>` },
        { name: "Content-Disposition", value: "inline" }
      ],
      encoding: "base64",
      body: img.dataBase64
    }));
    root = {
      contentType: "multipart/related",
      headers: [],
      encoding: "7bit",
      parts: [root, ...imageParts]
    };
  }

  if (content.attachments && content.attachments.length > 0) {
    const attachmentParts: MimePart[] = content.attachments.map((att) => ({
      contentType: att.contentType,
      headers: [
        { name: "Content-Disposition", value: `attachment; filename="${att.filename}"` }
      ],
      encoding: "base64",
      body: att.dataBase64
    }));
    root = {
      contentType: "multipart/mixed",
      headers: [],
      encoding: "7bit",
      parts: [root, ...attachmentParts]
    };
  }

  return root;
}

/**
 * Recovers the plain-text/HTML source content from an already-built MIME tree — used by Sent
 * Mail Synchronization (Section 9.5) to store a sent message's body without re-parsing the
 * canonicalized wire format. Leaf parts' `body` field holds the pre-encoding source content
 * (Section 9.4's canonicalize() encodes into `raw` without mutating it), so this is a plain tree
 * walk, not a MIME parser.
 */
export function extractPlainAndHtmlBodies(root: MimePart): { text?: string; html?: string } {
  let text: string | undefined;
  let html: string | undefined;

  if (root.contentType.startsWith("text/plain") && root.body !== undefined) text = root.body;
  if (root.contentType.startsWith("text/html") && root.body !== undefined) html = root.body;

  for (const child of root.parts ?? []) {
    const nested = extractPlainAndHtmlBodies(child);
    text = text ?? nested.text;
    html = html ?? nested.html;
  }

  return { text, html };
}
