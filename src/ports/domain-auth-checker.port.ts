/**
 * "unknown" is distinct from "none": "none" means this checker looked for a record in the right
 * place and found nothing (a real, actionable gap); "unknown" means this checker has no reliable
 * way to check at all for this domain/provider combination (e.g. DKIM on a consumer @gmail.com
 * address — see DnsDomainAuthChecker's docblock) and is deliberately not guessing. Findings code
 * must not treat "unknown" the same as "none".
 */
export type AuthStatus = "pass" | "fail" | "none" | "unknown";

export interface DomainAuthStatus {
  spf: AuthStatus;
  dkim: AuthStatus;
  dmarc: AuthStatus;
}

/**
 * SPF/DKIM/DMARC posture for a sending domain (Section 19.2). This is a DNS presence/syntax
 * check, not a real SPF/DKIM evaluation against an actual delivery — that requires the sending
 * IP and message signature at delivery time, which only the receiving mail system has. "pass"
 * here means "a well-formed record is published," the strongest signal obtainable from a
 * standalone DNS lookup; it is not a guarantee any specific message would pass authentication.
 */
export interface DomainAuthChecker {
  check(domain: string, provider: string): Promise<DomainAuthStatus>;
}
