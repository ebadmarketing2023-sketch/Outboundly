/**
 * Opt-out intent detection for inbound replies.
 *
 * A real reported gap: a reply saying "please take me off your list" used to stop only that
 * contact's *currently active* enrollments (stop-enrollments.ts's stopped_reply path). The contact
 * was never added to the suppression list, so the moment they appeared in a later CSV import they'd
 * be enrolled and emailed again -- the exact outcome an opt-out request is meant to prevent, and a
 * real CAN-SPAM/CASL problem as well as a domain-reputation one.
 *
 * This deliberately does NOT rely on a List-Unsubscribe header or any click-tracked link: Gmail
 * itself doesn't put List-Unsubscribe on the mail it sends, and adding one is a recognized
 * bulk-mail marker that works against 1:1-looking outreach. A plain-language "just reply" opt-out
 * plus this detector is the equivalent mechanism for mail that's trying to look like a person
 * wrote it.
 *
 * Precision over recall, on purpose. A false positive permanently stops contacting a live lead, so
 * every pattern here requires an *explicit request to be removed*. Notably absent: "not
 * interested", "no thanks", "wrong person" -- those are soft nos that should (and already do) stop
 * the sequence via the ordinary reply path, but they are not requests for erasure from all future
 * campaigns. Suppression is reversible from the Leads screen if this ever gets one wrong.
 */

/**
 * Quoted original text is stripped before matching. Without this, our own outreach copy quoted back
 * inside a reply ("Not a fit? Just reply and I'll close your file.") would match on almost every
 * reply, suppressing leads who merely answered a question.
 */
export function stripQuotedReplyText(bodyText: string): string {
  const lines = bodyText.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Standard quote prefix (RFC 3676 style), used by essentially every mail client.
    if (trimmed.startsWith(">")) continue;
    // Attribution lines that introduce a quoted block -- everything after one is the original
    // message, not the reply. Matches Gmail's own "On <date> <person> wrote:" form and Outlook's
    // "-----Original Message-----" / "From: ... Sent: ..." block header.
    if (/^on\b.*\bwrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) break;
    if (/^_{5,}$/.test(trimmed)) break; // Outlook's horizontal-rule divider above a quoted block
    kept.push(line);
  }

  return kept.join("\n");
}

/**
 * Only the opening of a reply is considered. A genuine removal request is stated up front, whereas
 * a long thread can easily contain the word "unsubscribe" further down inside a signature block or
 * a forwarded newsletter footer.
 */
const MAX_CHARS_CONSIDERED = 600;

/**
 * Every pattern is an explicit request to stop/remove, not a mere negative sentiment. Kept as
 * whole-phrase patterns rather than bare keywords so that, for example, the word "stop" on its own
 * ("stop by our booth") can't trigger suppression.
 */
const OPT_OUT_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bopt(?:ing)?[-\s]?out\b/i,
  /\b(?:please\s+)?(?:remove|delete)\s+(?:me|us|my\s+(?:email|address|details|data)|our)\b/i,
  /\btake\s+(?:me|us)\s+off\b/i,
  /\b(?:stop|quit|cease)\s+(?:emailing|contacting|messaging|mailing)\b/i,
  /\bno\s+(?:more|further)\s+(?:emails?|messages?|contact)\b/i,
  /\b(?:do\s+not|don'?t)\s+(?:email|contact|message)\s+(?:me|us)\b/i,
  /\bhow\s+do\s+i\s+(?:unsubscribe|opt\s?out)\b/i
];

/**
 * True only when the reply contains an explicit request to be removed from future contact.
 * `subject` is matched too because a one-word "Unsubscribe" subject with an empty body is a common
 * real form of this request.
 */
export function looksLikeOptOutRequest(subject: string | undefined, bodyText: string | undefined): boolean {
  const body = stripQuotedReplyText(bodyText ?? "").slice(0, MAX_CHARS_CONSIDERED);
  const candidate = `${subject ?? ""}\n${body}`;
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(candidate));
}
