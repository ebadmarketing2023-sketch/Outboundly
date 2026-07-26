/** Shared data types for the MIME pipeline (Section 9). Logic lives in mime-builder.ts / canonicalizer.ts. */

export interface MimeHeader {
  name: string;
  value: string;
}

export type TransferEncoding = "7bit" | "quoted-printable" | "base64";

export interface MimePart {
  contentType: string;
  headers: MimeHeader[];
  encoding: TransferEncoding;
  /** Present on leaf parts. */
  body?: string;
  /** Present on multipart/* parts. */
  parts?: MimePart[];
  /** multipart boundary, set by MIME Generation (Section 9.2 stage 8). */
  boundary?: string;
}

/**
 * The output of the full RFC 5322 + MIME Generation + Canonicalization stages
 * (Section 9.2, stages 7-9) — what the Provider Adapter and Gmail Compatibility
 * Layer both consume.
 */
export interface BuiltMimeMessage {
  headers: MimeHeader[];
  root: MimePart;
  /** Fully canonicalized wire-format bytes (CRLF line endings), ready for transport or base64url encoding. */
  raw: string;
}
