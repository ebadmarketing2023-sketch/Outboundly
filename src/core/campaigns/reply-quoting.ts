import type { BlockNode, Document, QuoteBlock } from "../rendering/document-model.js";
import { paragraph } from "../rendering/document-model.js";
import { parsePlainTextToDocument } from "../rendering/plain-text-parser.js";

/**
 * Gmail-style quoting of the previous email underneath a follow-up.
 *
 * Threading headers (In-Reply-To/References) are what *should* group a follow-up with the message
 * it answers, and Gmail honours them — but only in Conversation view. With conversation view off,
 * or in a client that threads differently, a bare "Re: ..." with no quoted text reads as an
 * unrelated second email that happens to share a subject. Every real mail client solves this the
 * same way: it includes the message being replied to underneath, behind the "show trimmed content"
 * control. That is what this builds, so a follow-up carries its own context regardless of how the
 * recipient's client is configured.
 *
 * The attribution line matches Gmail's own wording and ordering exactly — "On <date> <sender>
 * wrote:" — because it is the string every client's trimming heuristic looks for when deciding what
 * to collapse behind that control.
 */

const ATTRIBUTION_DATE = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true
});

export interface QuotedMessage {
  /** The message being replied to, as it was actually sent. */
  bodyText: string;
  /** RFC 5322 From of that message, e.g. `"Ada Lovelace" <ada@x.com>` or a bare address. */
  fromAddress: string;
  sentAt: Date;
}

/** "On Wed, Aug 5, 2026 at 10:00 AM Ada Lovelace <ada@x.com> wrote:" */
export function buildAttribution(quoted: QuotedMessage, timeZone?: string): string {
  const formatter = timeZone
    ? new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone
      })
    : ATTRIBUTION_DATE;

  const parts = formatter.formatToParts(quoted.sentAt);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const when = `${get("weekday")}, ${get("month")} ${get("day")}, ${get("year")} at ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
  return `On ${when} ${quoted.fromAddress.trim()} wrote:`;
}

/** The quote block itself: the previous message's own paragraphs, attributed. */
export function buildQuoteBlock(quoted: QuotedMessage, timeZone?: string): QuoteBlock {
  return {
    type: "quote",
    attribution: buildAttribution(quoted, timeZone),
    // Reparsed rather than reused: the stored body is the text that really went out (already
    // personalized), and parsing it back into blocks keeps the quote's own line structure.
    children: parsePlainTextToDocument(quoted.bodyText).blocks
  };
}

/**
 * A follow-up's document: its own copy first, then the quoted previous message underneath —
 * the same shape a reply composed by hand has.
 */
export function withQuotedReply(followUp: Document, quoted: QuotedMessage | undefined, timeZone?: string): Document {
  if (!quoted || quoted.bodyText.trim().length === 0) return followUp;
  // A blank line between the new copy and the quoted history, the way a hand-written reply reads.
  const blocks: BlockNode[] = [...followUp.blocks, paragraph(), buildQuoteBlock(quoted, timeZone)];
  return { blocks };
}
