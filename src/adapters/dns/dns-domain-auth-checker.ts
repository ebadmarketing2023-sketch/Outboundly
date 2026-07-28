import { resolveCname, resolveTxt } from "node:dns/promises";
import type { AuthStatus, DomainAuthChecker, DomainAuthStatus } from "../../ports/domain-auth-checker.port.js";

// Consumer mailbox domains owned by the provider itself, not by the account holder — DKIM there
// is entirely Google's/Microsoft's own internal setup, signed with an unpublished, rotating
// selector (verified for real: a live query for google._domainkey.gmail.com returns ENOTFOUND,
// even though Gmail-sent mail genuinely does pass DKIM — the selector convention Workspace
// documents simply doesn't apply here). There is no selector name to check, so this isn't "none",
// it's "unknown" — checking would just be guessing.
const GOOGLE_CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_CONSUMER_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

/**
 * Real DNS-based SPF/DKIM/DMARC posture checker (Section 19.2), backing the DomainAuthChecker
 * port. A DNS resolution failure that means "no record here" (ENOTFOUND/ENODATA) is reported as
 * "none" — a real, actionable gap. A domain/provider combination this checker has no reliable way
 * to check at all (see GOOGLE_CONSUMER_DOMAINS/MICROSOFT_CONSUMER_DOMAINS above) is reported as
 * "unknown" instead, so callers don't mistake "can't check this" for "checked and it's missing".
 */
export class DnsDomainAuthChecker implements DomainAuthChecker {
  async check(domain: string, provider: string): Promise<DomainAuthStatus> {
    const [spf, dmarc, dkim] = await Promise.all([
      this.checkSpf(domain),
      this.checkDmarc(domain),
      this.checkDkim(domain, provider)
    ]);
    return { spf, dmarc, dkim };
  }

  private async lookupTxtRecords(hostname: string): Promise<string[] | undefined> {
    try {
      const records = await resolveTxt(hostname);
      return records.map((chunks) => chunks.join(""));
    } catch {
      return undefined;
    }
  }

  private async checkSpf(domain: string): Promise<AuthStatus> {
    const records = await this.lookupTxtRecords(domain);
    if (!records) return "none";
    const spfRecords = records.filter((r) => r.startsWith("v=spf1"));
    if (spfRecords.length === 0) return "none";
    // RFC 7208: a domain publishing more than one SPF record causes SPF to permanently fail —
    // this is a real, checkable misconfiguration, not a guess.
    if (spfRecords.length > 1) return "fail";
    return "pass";
  }

  private async checkDmarc(domain: string): Promise<AuthStatus> {
    const records = await this.lookupTxtRecords(`_dmarc.${domain}`);
    if (!records) return "none";
    const dmarcRecord = records.find((r) => r.startsWith("v=DMARC1"));
    if (!dmarcRecord) return "none";
    // A DMARC record must declare a policy (p=none/quarantine/reject) to be valid at all.
    return /(?:^|;)\s*p=(none|quarantine|reject)\b/i.test(dmarcRecord) ? "pass" : "fail";
  }

  private async checkDkim(domain: string, provider: string): Promise<AuthStatus> {
    // DKIM selectors are provider-specific and not discoverable via DNS alone — checking the
    // wrong selector name would just be guessing, which this app's "no guesswork" stance rules
    // out. Only Google Workspace's and Microsoft 365's own documented *default* selectors are
    // checked, and only for a custom domain routed through that provider; a custom selector on
    // either provider, the provider's own consumer domain (gmail.com, outlook.com, etc. — see the
    // module-level comment), or any selector at all on a generic SMTP/IMAP provider, is honestly
    // "unknown" to this checker rather than guessed.
    if (provider === "google") {
      if (GOOGLE_CONSUMER_DOMAINS.has(domain.toLowerCase())) return "unknown";
      const records = await this.lookupTxtRecords(`google._domainkey.${domain}`);
      if (!records) return "none";
      return records.some((r) => r.includes("p=") && !r.includes("p=;")) ? "pass" : "fail";
    }
    if (provider === "microsoft") {
      if (MICROSOFT_CONSUMER_DOMAINS.has(domain.toLowerCase())) return "unknown";
      try {
        const cname = await resolveCname(`selector1._domainkey.${domain}`);
        return cname.length > 0 ? "pass" : "fail";
      } catch {
        return "none";
      }
    }
    return "unknown";
  }
}
