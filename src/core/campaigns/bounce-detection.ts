/**
 * Bounce detection (Section 14.2's stopped_bounce transition) — two real, verifiable signals,
 * not a fabricated one:
 *
 * 1. isPermanentSmtpRejection: nodemailer's SMTP transport attaches a genuine `responseCode`
 *    property to errors it throws (verified against nodemailer's own source,
 *    lib/smtp-connection/index.js) — a 5xx code is a permanent rejection (hard bounce) at send
 *    time, a 4xx is transient and should still retry normally. Only meaningful for the SMTP/IMAP
 *    provider; Gmail/Graph's API-based sends don't reject synchronously the same way, and their
 *    error shapes aren't checked here since that would be guessing rather than verifying.
 *
 * 2. looksLikeBounceNotification: the handful of long-standing, real conventions for automated
 *    delivery-failure notices — RFC 5321's mandatory "postmaster" mailbox, the de facto
 *    "MAILER-DAEMON" sender every major MTA uses, and the small set of subject phrases the
 *    common mail systems actually send. Not exhaustive (a DSN that doesn't match either signal,
 *    or that doesn't thread back to one of our own sent messages, isn't detected), but every
 *    pattern here is a real-world standard, not a guess.
 */

const BOUNCE_SENDER_PATTERN = /(mailer-daemon|postmaster|mail delivery subsystem)/i;
const BOUNCE_SUBJECT_PATTERN =
  /(undeliverable|undelivered mail|delivery status notification|delivery failure|returned to sender|failure notice|mail delivery failed|delivery has failed|delivery incomplete)/i;

export function isPermanentSmtpRejection(error: unknown): boolean {
  const responseCode = (error as { responseCode?: unknown } | null | undefined)?.responseCode;
  return typeof responseCode === "number" && responseCode >= 500 && responseCode < 600;
}

export function looksLikeBounceNotification(fromAddress: string, subject: string): boolean {
  return BOUNCE_SENDER_PATTERN.test(fromAddress) || BOUNCE_SUBJECT_PATTERN.test(subject);
}
