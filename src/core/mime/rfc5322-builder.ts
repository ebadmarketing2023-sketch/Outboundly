import { createHash } from "node:crypto";
import type { NamedEmailAddress } from "../shared-kernel/email-address.js";
import { formatNamedAddress } from "../shared-kernel/email-address.js";
import type { MimeHeader } from "./types.js";

/**
 * RFC 5322 Message Builder (Section 9.2, stage 7). Produces the required top-level headers.
 * MIME-Version and Content-Type are added later, during canonicalization (Section 9.4), once
 * the MIME tree's boundary is known.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** RFC 5322 date-time with a numeric zone offset — the current, non-obsolete form. */
export function formatRfc5322Date(date: Date): string {
  const day = DAYS[date.getUTCDay()];
  const dd = pad2(date.getUTCDate());
  const mon = MONTHS[date.getUTCMonth()];
  const yyyy = date.getUTCFullYear();
  const hh = pad2(date.getUTCHours());
  const mm = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return `${day}, ${dd} ${mon} ${yyyy} ${hh}:${mm}:${ss} +0000`;
}

/**
 * A deterministic Message-ID derived from a stable seed (the draft's own ID) so that retrying
 * a build for the same draft never mints a second, different Message-ID (Section 9.2, stage 7).
 */
export function generateMessageId(sendingDomain: string, seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `<${digest}@${sendingDomain}>`;
}

export interface Rfc5322BuilderInput {
  from: NamedEmailAddress;
  to: NamedEmailAddress[];
  cc?: NamedEmailAddress[];
  bcc?: NamedEmailAddress[];
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: NamedEmailAddress;
}

function joinAddresses(addresses: NamedEmailAddress[]): string {
  return addresses.map(formatNamedAddress).join(", ");
}

export function buildRfc5322Headers(input: Rfc5322BuilderInput): MimeHeader[] {
  const headers: MimeHeader[] = [
    { name: "Message-ID", value: input.messageId },
    { name: "Date", value: formatRfc5322Date(input.date) },
    { name: "From", value: formatNamedAddress(input.from) },
    { name: "To", value: joinAddresses(input.to) },
    { name: "Subject", value: input.subject }
  ];

  if (input.cc?.length) headers.push({ name: "Cc", value: joinAddresses(input.cc) });
  // Bcc is intentionally included here, not stripped: Gmail API's raw-message send derives its
  // recipient list from To/Cc/Bcc headers and strips Bcc from the copy other recipients see,
  // matching standard Gmail compose behavior. A future direct-SMTP adapter would need to strip
  // this per-recipient itself, since SMTP has no equivalent server-side behavior to rely on.
  if (input.bcc?.length) headers.push({ name: "Bcc", value: joinAddresses(input.bcc) });
  if (input.replyTo) headers.push({ name: "Reply-To", value: formatNamedAddress(input.replyTo) });
  if (input.inReplyTo) headers.push({ name: "In-Reply-To", value: input.inReplyTo });
  if (input.references?.length) headers.push({ name: "References", value: input.references.join(" ") });

  return headers;
}
