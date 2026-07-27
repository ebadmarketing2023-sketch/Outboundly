/**
 * Subject normalization (Section 11.2). Strips reply/forward decorations so the normalized form
 * is usable for storage/search/display, but this is deliberately a *corroborating* signal only —
 * it never decides thread placement on its own (Section 11.3: the header graph is authoritative
 * across every provider, subject text is not, since it's mangled by forwarding/localization).
 */

const REPLY_FORWARD_PREFIX = /^(re|fwd?|fw)\s*:\s*/i;

export function normalizeSubject(subject: string): string {
  let current = subject.trim();
  // Repeated prefixes ("Re: Re: Fwd: ...") are common after several rounds of back-and-forth.
  let stripped = current.replace(REPLY_FORWARD_PREFIX, "");
  while (stripped !== current) {
    current = stripped.trim();
    stripped = current.replace(REPLY_FORWARD_PREFIX, "");
  }
  return current.replace(/\s+/g, " ").trim();
}
