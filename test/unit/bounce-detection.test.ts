import { describe, expect, it } from "vitest";
import { isPermanentSmtpRejection, looksLikeBounceNotification } from "../../src/core/campaigns/bounce-detection.js";

describe("isPermanentSmtpRejection (Section 14.2)", () => {
  it("returns true for a 5xx responseCode", () => {
    expect(isPermanentSmtpRejection({ responseCode: 550 })).toBe(true);
    expect(isPermanentSmtpRejection({ responseCode: 599 })).toBe(true);
  });

  it("returns false for a 4xx (transient) responseCode", () => {
    expect(isPermanentSmtpRejection({ responseCode: 421 })).toBe(false);
  });

  it("returns false when there is no responseCode at all", () => {
    expect(isPermanentSmtpRejection(new Error("network timeout"))).toBe(false);
    expect(isPermanentSmtpRejection(null)).toBe(false);
    expect(isPermanentSmtpRejection(undefined)).toBe(false);
  });

  it("returns false for a non-numeric responseCode", () => {
    expect(isPermanentSmtpRejection({ responseCode: "550" })).toBe(false);
  });
});

describe("looksLikeBounceNotification (Section 14.2)", () => {
  it("matches the standard mailer-daemon sender", () => {
    expect(looksLikeBounceNotification("mailer-daemon@googlemail.com", "Some subject")).toBe(true);
  });

  it("matches the postmaster mailbox", () => {
    expect(looksLikeBounceNotification("postmaster@example.com", "Some subject")).toBe(true);
  });

  it("matches Gmail's real bounce subject line", () => {
    expect(looksLikeBounceNotification("someone@example.com", "Delivery Status Notification (Failure)")).toBe(true);
  });

  it("matches a generic 'undelivered mail' subject", () => {
    expect(looksLikeBounceNotification("mail-daemon@example.com", "Undelivered Mail Returned to Sender")).toBe(true);
  });

  it("does not flag an ordinary reply", () => {
    expect(looksLikeBounceNotification("lead@example.com", "Re: Quick question")).toBe(false);
  });
});
