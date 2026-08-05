import { createHash } from "node:crypto";
import type { NamedEmailAddress } from "../shared-kernel/email-address.js";
import { encodeHeaderText, formatAddressForHeader } from "./encoded-word.js";
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

/**
 * The zone's real offset at this instant, in minutes east of UTC — DST-correct, and correct for
 * the half-hour zones (Asia/Kolkata's +05:30, Australia/Adelaide's +09:30/+10:30) that a fixed
 * offset table gets wrong. Returns undefined if the runtime can't resolve the zone, so the caller
 * falls back to UTC rather than emitting a wrong Date.
 */
function utcOffsetMinutes(date: Date, timeZone: string): number | undefined {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    if (!name) return undefined;
    if (name === "GMT" || name === "UTC") return 0; // some runtimes render a zero offset bare
    const match = /^(?:GMT|UTC)([+-])(\d{2}):(\d{2})$/.exec(name);
    if (!match) return undefined;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return undefined;
  }
}

/**
 * RFC 5322 date-time with a numeric zone offset — the current, non-obsolete form.
 *
 * @param timeZone the sender's IANA timezone. Omitted (or unresolvable) means UTC.
 *
 * Every message used to be stamped +0000 no matter who sent it or from where. That is not what a
 * person's mail client does — Gmail stamps the offset of the account's own configured timezone,
 * so a human's mail carries -0500, +0500, +05:30, and it shifts with their DST. A mailbox whose
 * every message claims UTC while its send times cluster neatly inside one region's working hours
 * is describing itself as automated. The date is not wrong either way (the instant is the same);
 * it is the uniformity that stands out.
 */
export function formatRfc5322Date(date: Date, timeZone?: string): string {
  const offsetMinutes = timeZone ? utcOffsetMinutes(date, timeZone) ?? 0 : 0;
  // Shifting the instant lets the same getUTC* accessors render local wall-clock components, which
  // is exactly what the offset suffix then declares them to be.
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);

  const day = DAYS[shifted.getUTCDay()];
  const dd = pad2(shifted.getUTCDate());
  const mon = MONTHS[shifted.getUTCMonth()];
  const yyyy = shifted.getUTCFullYear();
  const hh = pad2(shifted.getUTCHours());
  const mm = pad2(shifted.getUTCMinutes());
  const ss = pad2(shifted.getUTCSeconds());

  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absolute / 60))}${pad2(absolute % 60)}`;

  return `${day}, ${dd} ${mon} ${yyyy} ${hh}:${mm}:${ss} ${offset}`;
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
  /** The sender's IANA timezone, for the Date header's offset. Omitted means UTC. */
  timeZone?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: NamedEmailAddress;
}

/** formatAddressForHeader, not formatNamedAddress: display names crossing onto the wire need RFC
 * 2047 encoding when they aren't pure ASCII (see encoded-word.ts). The plain formatter remains the
 * right one for storage/display, which is why the distinction exists. */
function joinAddresses(addresses: NamedEmailAddress[]): string {
  return addresses.map(formatAddressForHeader).join(", ");
}

export function buildRfc5322Headers(input: Rfc5322BuilderInput): MimeHeader[] {
  const headers: MimeHeader[] = [
    { name: "Message-ID", value: input.messageId },
    { name: "Date", value: formatRfc5322Date(input.date, input.timeZone) },
    { name: "From", value: formatAddressForHeader(input.from) },
    { name: "To", value: joinAddresses(input.to) },
    { name: "Subject", value: encodeHeaderText(input.subject) }
  ];

  if (input.cc?.length) headers.push({ name: "Cc", value: joinAddresses(input.cc) });
  // Bcc is intentionally included here, not stripped: Gmail API's raw-message send derives its
  // recipient list from To/Cc/Bcc headers and strips Bcc from the copy other recipients see,
  // matching standard Gmail compose behavior. A future direct-SMTP adapter would need to strip
  // this per-recipient itself, since SMTP has no equivalent server-side behavior to rely on.
  if (input.bcc?.length) headers.push({ name: "Bcc", value: joinAddresses(input.bcc) });
  if (input.replyTo) headers.push({ name: "Reply-To", value: formatAddressForHeader(input.replyTo) });
  if (input.inReplyTo) headers.push({ name: "In-Reply-To", value: input.inReplyTo });
  if (input.references?.length) headers.push({ name: "References", value: input.references.join(" ") });

  return headers;
}
