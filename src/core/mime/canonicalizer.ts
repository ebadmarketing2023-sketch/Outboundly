import { randomBytes } from "node:crypto";
import type { BuiltMimeMessage, MimeHeader, MimePart } from "./types.js";

/**
 * MIME Canonicalization (Section 9.2, stage 9 / Section 9.4): normalizes the wire format of an
 * already-structurally-correct MIME tree — header ordering, header folding, CRLF normalization,
 * quoted-printable/base64 encoding, boundary generation, duplicate header removal. Deliberately
 * separate from mime-generator.ts, which only decides the tree's shape.
 */

const HEADER_ORDER = [
  "Message-ID",
  "Date",
  "From",
  "To",
  "Cc",
  "Bcc",
  "Subject",
  "Reply-To",
  "In-Reply-To",
  "References",
  "MIME-Version",
  "Content-Type",
  "Content-Transfer-Encoding"
];

/** Keeps the first occurrence of each header name (case-insensitive) and drops later duplicates. */
export function dedupeAndOrderHeaders(headers: MimeHeader[]): MimeHeader[] {
  const seen = new Set<string>();
  const deduped: MimeHeader[] = [];
  for (const header of headers) {
    const key = header.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(header);
  }

  const orderIndex = (name: string): number => {
    const idx = HEADER_ORDER.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return idx === -1 ? HEADER_ORDER.length : idx;
  };

  // Array#sort is spec-guaranteed stable, so headers outside HEADER_ORDER keep their relative order.
  return [...deduped].sort((a, b) => orderIndex(a.name) - orderIndex(b.name));
}

const MAX_LINE_LENGTH = 78;

/** Folds a header line at word boundaries so no line exceeds the RFC 5322 recommended length. */
export function foldHeaderLine(name: string, value: string): string {
  const prefix = `${name}: `;
  if ((prefix + value).length <= MAX_LINE_LENGTH) return prefix + value;

  const words = value.split(" ");
  const lines: string[] = [];
  let currentLine = prefix;
  let lineHasWord = false;

  for (const word of words) {
    const addition = lineHasWord ? ` ${word}` : word;
    if (lineHasWord && currentLine.length + addition.length > MAX_LINE_LENGTH) {
      lines.push(currentLine);
      currentLine = ` ${word}`; // continuation lines begin with folding whitespace
    } else {
      currentLine += addition;
      lineHasWord = true;
    }
  }
  lines.push(currentLine);
  return lines.join("\r\n");
}

function qpEncodeLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    const isLast = i === bytes.length - 1;
    const printable = byte >= 33 && byte <= 126 && byte !== 0x3d;
    const nonTrailingWhitespace = (byte === 0x20 || byte === 0x09) && !isLast;
    out += printable || nonTrailingWhitespace ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function wrapQpLine(encodedLine: string): string {
  const MAX = 75; // leaves room for the trailing "=" soft-break marker
  let result = "";
  let col = 0;
  let i = 0;
  while (i < encodedLine.length) {
    const isEscape = encodedLine[i] === "=";
    const tokenLen = isEscape ? 3 : 1;
    if (col + tokenLen > MAX) {
      result += "=\r\n";
      col = 0;
    }
    result += encodedLine.slice(i, i + tokenLen);
    col += tokenLen;
    i += tokenLen;
  }
  return result;
}

/** RFC 2045 quoted-printable encoding, operating on UTF-8 octets, with soft line-wrapping at 76 cols. */
export function quotedPrintableEncode(text: string): string {
  return text
    .split("\n")
    .map((line) => wrapQpLine(qpEncodeLine(line)))
    .join("\r\n");
}

/** Wraps an already-base64-encoded string to RFC 2045's 76-character line length. */
export function wrapBase64(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 76) {
    lines.push(base64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/** Cryptographically random, effectively collision-free multipart boundary. */
export function generateBoundary(): string {
  return `----=_Part_${randomBytes(16).toString("hex")}`;
}

function assignBoundaries(part: MimePart): MimePart {
  if (!part.parts) return part;
  return {
    ...part,
    boundary: part.boundary ?? generateBoundary(),
    parts: part.parts.map(assignBoundaries)
  };
}

function partHeaders(part: MimePart): MimeHeader[] {
  if (part.parts) {
    return dedupeAndOrderHeaders([
      { name: "Content-Type", value: `${part.contentType}; boundary="${part.boundary}"` },
      ...part.headers
    ]);
  }
  return dedupeAndOrderHeaders([
    { name: "Content-Type", value: part.contentType },
    { name: "Content-Transfer-Encoding", value: part.encoding },
    ...part.headers
  ]);
}

function encodeBody(part: MimePart): string {
  if (part.body === undefined) return "";
  if (part.encoding === "quoted-printable") return quotedPrintableEncode(part.body);
  if (part.encoding === "base64") return wrapBase64(part.body);
  return part.body.replace(/\r\n|\r|\n/g, "\r\n");
}

function serializeHeaderBlock(headers: MimeHeader[]): string {
  return headers.map((h) => foldHeaderLine(h.name, h.value)).join("\r\n");
}

function serializePart(part: MimePart): string {
  const headerBlock = serializeHeaderBlock(partHeaders(part));
  if (part.parts) {
    const body =
      part.parts.map((child) => `--${part.boundary}\r\n${serializePart(child)}\r\n`).join("") +
      `--${part.boundary}--`;
    return `${headerBlock}\r\n\r\n${body}`;
  }
  return `${headerBlock}\r\n\r\n${encodeBody(part)}`;
}

/**
 * The Canonicalization entry point: merges the RFC 5322 headers with the root MIME part's
 * Content-Type (assigning boundaries along the way) into one ordered, folded header block,
 * then serializes the body. This is the seam the MIME Compatibility Testing suite
 * (Section 24.7) diffs against real Gmail-generated MIME.
 */
export function canonicalize(rfc5322Headers: MimeHeader[], rootInput: MimePart): BuiltMimeMessage {
  const root = assignBoundaries(rootInput);
  const mergedHeaders = dedupeAndOrderHeaders([
    ...rfc5322Headers,
    { name: "MIME-Version", value: "1.0" },
    ...partHeaders(root)
  ]);
  const topHeaderBlock = serializeHeaderBlock(mergedHeaders);

  const bodyOnly = root.parts
    ? root.parts.map((child) => `--${root.boundary}\r\n${serializePart(child)}\r\n`).join("") +
      `--${root.boundary}--`
    : encodeBody(root);

  const raw = `${topHeaderBlock}\r\n\r\n${bodyOnly}`;
  return { headers: mergedHeaders, root, raw };
}
