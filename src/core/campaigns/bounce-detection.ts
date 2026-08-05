/**
 * Bounce detection (Section 14.2's stopped_bounce transition) — real, verifiable signals, not
 * fabricated ones:
 *
 * 1. isPermanentSmtpRejection: nodemailer's SMTP transport attaches a genuine `responseCode`
 *    property to errors it throws (verified against nodemailer's own source,
 *    lib/smtp-connection/index.js) — a 5xx code is a permanent rejection (hard bounce) at send
 *    time, a 4xx is transient and should still retry normally. Only meaningful for the SMTP/IMAP
 *    provider; Gmail/Graph's API-based sends don't reject synchronously the same way, and their
 *    error shapes aren't checked here since that would be guessing rather than verifying.
 *
 * 2. classifyBounceNotification: the long-standing conventions for automated delivery-failure
 *    notices — RFC 5321's mandatory "postmaster" mailbox, the de facto "MAILER-DAEMON" sender
 *    every major MTA uses, and the subject phrases common mail systems actually send — plus
 *    RFC 3464's machine-readable message/delivery-status fields, which are what actually
 *    distinguish a permanent failure from a temporary one.
 *
 * That last distinction is the point. "Delivery Status Notification (Delay)" — what Gmail sends
 * when a message is merely deferred (greylisting, the receiving server briefly down) — matches the
 * same subject wording as a real failure. Treating it as a hard bounce stopped the sequence and
 * wrote off a lead whose mail was, in all likelihood, delivered minutes later. A delay notice is
 * now classified as "transient": the enrollment is left alone, and it is not counted as a reply
 * either, since nobody replied.
 *
 * The default for an unclassifiable notice stays "permanent", deliberately. Continuing to mail an
 * address that is genuinely dead is the more expensive mistake — bounce rate is the single fastest
 * way to wreck a sending domain's reputation — so a notice is only downgraded on a positive signal
 * that it is temporary, never on the absence of one.
 */

const BOUNCE_SENDER_PATTERN = /(mailer-daemon|postmaster|mail delivery subsystem|mail delivery system)/i;
const BOUNCE_SUBJECT_PATTERN =
  /(undeliverable|undelivered mail|delivery status notification|delivery failure|returned to sender|failure notice|mail delivery failed|delivery has failed|delivery incomplete|delivery delayed|warning: message)/i;

/** RFC 3464 §2.3.3: the status code's first digit is the class — 4 temporary, 5 permanent. */
const DSN_STATUS_PATTERN = /^\s*status:\s*([245])\.\d{1,3}\.\d{1,3}/im;
/** RFC 3464 §2.3.2: "failed" is permanent, "delayed" is explicitly not. */
const DSN_ACTION_DELAYED_PATTERN = /^\s*action:\s*delayed/im;
const DSN_ACTION_FAILED_PATTERN = /^\s*action:\s*failed/im;

/** Wording every major provider uses for a deferral, for notices that carry no DSN part at all.
 * Consulted only after the Status/Action fields above, which are authoritative — so a real failure
 * whose text happens to mention an earlier delay is still classified from its DSN part. */
const TRANSIENT_PHRASE_PATTERN =
  /(\(delay\)|\bdelayed\b|still trying|will retry|temporarily (?:unavailable|deferred|rejected)|temporary failure|greylist)/i;

export type BounceClassification = "permanent" | "transient" | "not-a-bounce";

export function isPermanentSmtpRejection(error: unknown): boolean {
  const responseCode = (error as { responseCode?: unknown } | null | undefined)?.responseCode;
  return typeof responseCode === "number" && responseCode >= 500 && responseCode < 600;
}

function looksLikeBounceNotification(fromAddress: string, subject: string): boolean {
  return BOUNCE_SENDER_PATTERN.test(fromAddress) || BOUNCE_SUBJECT_PATTERN.test(subject);
}

/**
 * @param body the notice's text, when available — a real DSN carries a machine-readable
 *   message/delivery-status part whose Status/Action fields are authoritative, and are preferred
 *   over any wording in the subject.
 */
export function classifyBounceNotification(fromAddress: string, subject: string, body?: string): BounceClassification {
  if (!looksLikeBounceNotification(fromAddress, subject)) return "not-a-bounce";

  const text = body ?? "";

  // Machine-readable fields first: they are unambiguous where wording is not.
  const status = DSN_STATUS_PATTERN.exec(text);
  if (status) return status[1] === "4" ? "transient" : "permanent";
  if (DSN_ACTION_DELAYED_PATTERN.test(text)) return "transient";
  if (DSN_ACTION_FAILED_PATTERN.test(text)) return "permanent";

  if (TRANSIENT_PHRASE_PATTERN.test(subject) || TRANSIENT_PHRASE_PATTERN.test(text)) return "transient";

  return "permanent";
}

/**
 * The address the delivery actually failed for, per RFC 3464 §2.3.1/§2.3.2 — e.g.
 * "Final-Recipient: rfc822; lead@example.com".
 *
 * Worth parsing because a DSN does not reliably thread back to the message it is reporting on:
 * many MTAs send it as a fresh message carrying the original only as an attachment, with no
 * In-Reply-To at all. Correlating by thread alone therefore misses those entirely — the bounce is
 * ingested, matches nothing, and the campaign keeps mailing a dead address. Final-Recipient names
 * the lead outright.
 */
export function extractFailedRecipient(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const match = /^\s*(?:final|original)-recipient:\s*(?:rfc822|x-[\w-]+)\s*;\s*(.+)$/im.exec(body);
  if (!match) return undefined;
  const address = match[1]!.trim().replace(/^<|>$/g, "").trim();
  return address.includes("@") ? address : undefined;
}
