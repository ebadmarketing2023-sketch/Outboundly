import { describe, expect, it } from "vitest";
import { DnsDomainAuthChecker } from "../../src/adapters/dns/dns-domain-auth-checker.js";

/**
 * Real DNS lookups against real domains — verifies the checker's parsing against actual records
 * rather than a mocked resolver, matching this project's "verify against reality" testing
 * convention (Section 24). Requires network access; skipped automatically has no special-casing
 * here since this sandbox's outbound DNS is confirmed working (Section 19.2's implementation
 * notes).
 */
describe("DnsDomainAuthChecker (Section 19.2, real DNS)", () => {
  it("finds gmail.com's real SPF record", async () => {
    const checker = new DnsDomainAuthChecker();
    const status = await checker.check("gmail.com", "google");
    expect(status.spf).toBe("pass");
  }, 20_000);

  it("finds google.com's real DMARC record", async () => {
    const checker = new DnsDomainAuthChecker();
    const status = await checker.check("google.com", "google");
    expect(status.dmarc).toBe("pass");
  }, 20_000);

  it("reports 'none' for a domain with no records at all", async () => {
    const checker = new DnsDomainAuthChecker();
    const status = await checker.check("this-domain-should-not-exist-outboundly-test.example", "google");
    expect(status).toEqual({ spf: "none", dkim: "none", dmarc: "none" });
  }, 20_000);

  it("reports DKIM as 'none' for a generic smtp_imap provider (selector unknown, not guessed)", async () => {
    const checker = new DnsDomainAuthChecker();
    const status = await checker.check("gmail.com", "smtp_imap");
    expect(status.dkim).toBe("none");
  }, 20_000);
});
