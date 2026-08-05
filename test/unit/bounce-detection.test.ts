import { describe, expect, it } from "vitest";
import { classifyBounceNotification, extractFailedRecipient, isPermanentSmtpRejection } from "../../src/core/campaigns/bounce-detection.js";

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

describe("classifyBounceNotification (Section 14.2)", () => {
  it("recognizes the standard automated senders", () => {
    expect(classifyBounceNotification("mailer-daemon@googlemail.com", "Some subject")).toBe("permanent");
    expect(classifyBounceNotification("postmaster@example.com", "Some subject")).toBe("permanent");
    expect(classifyBounceNotification("Mail Delivery Subsystem <x@y.com>", "Some subject")).toBe("permanent");
  });

  it("recognizes the subject lines real mail systems send", () => {
    expect(classifyBounceNotification("someone@example.com", "Delivery Status Notification (Failure)")).toBe("permanent");
    expect(classifyBounceNotification("mail-daemon@example.com", "Undelivered Mail Returned to Sender")).toBe("permanent");
  });

  it("does not flag an ordinary reply", () => {
    expect(classifyBounceNotification("lead@example.com", "Re: Quick question")).toBe("not-a-bounce");
  });

  it("classifies a delay notice as transient, not a bounce", () => {
    // The false positive this exists to stop: Gmail sends this when a message is merely deferred
    // (greylisting, receiving server briefly down). Treating it as a hard bounce stopped the
    // sequence and wrote off a lead whose mail almost certainly arrived minutes later.
    expect(classifyBounceNotification("mailer-daemon@googlemail.com", "Delivery Status Notification (Delay)")).toBe("transient");
    expect(classifyBounceNotification("mailer-daemon@example.com", "Warning: message 1a2b3c delayed 4 hours")).toBe("transient");
  });

  it("prefers the machine-readable DSN status over the subject wording", () => {
    const delayedBody = ["Reporting-MTA: dns; mx.example.com", "", "Final-Recipient: rfc822; lead@example.com", "Action: delayed", "Status: 4.4.1"].join("\n");
    // Subject says "Failure", the DSN part says 4.x.x / delayed -- the DSN part wins.
    expect(classifyBounceNotification("mailer-daemon@example.com", "Delivery Status Notification (Failure)", delayedBody)).toBe("transient");

    const failedBody = ["Final-Recipient: rfc822; lead@example.com", "Action: failed", "Status: 5.1.1"].join("\n");
    expect(classifyBounceNotification("mailer-daemon@example.com", "Delivery Status Notification (Delay)", failedBody)).toBe("permanent");
  });

  it("treats an unclassifiable notice as permanent, since mailing a dead address is the costlier mistake", () => {
    expect(classifyBounceNotification("mailer-daemon@example.com", "Undeliverable", "Something went wrong.")).toBe("permanent");
  });

  it("still classifies nothing at all when the message isn't a delivery notice", () => {
    expect(classifyBounceNotification("lead@example.com", "Thanks!", "Status: 5.1.1 appearing in a human's quoted text")).toBe("not-a-bounce");
  });
});

describe("extractFailedRecipient (RFC 3464)", () => {
  it("reads the failed address out of the DSN's delivery-status part", () => {
    const body = ["Reporting-MTA: dns; mx.example.com", "", "Final-Recipient: rfc822; lead@example.com", "Action: failed", "Status: 5.1.1"].join("\n");
    expect(extractFailedRecipient(body)).toBe("lead@example.com");
  });

  it("accepts Original-Recipient and angle-bracketed forms", () => {
    expect(extractFailedRecipient("Original-Recipient: rfc822;<lead@example.com>")).toBe("lead@example.com");
  });

  it("returns undefined when there is no delivery-status part to read", () => {
    expect(extractFailedRecipient("Sorry, your message could not be delivered.")).toBeUndefined();
    expect(extractFailedRecipient(undefined)).toBeUndefined();
  });

  it("ignores a malformed value rather than returning something that isn't an address", () => {
    expect(extractFailedRecipient("Final-Recipient: rfc822; unknown")).toBeUndefined();
  });
});
