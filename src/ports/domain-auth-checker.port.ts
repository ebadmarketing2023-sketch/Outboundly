export type AuthStatus = "pass" | "fail" | "none";

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
