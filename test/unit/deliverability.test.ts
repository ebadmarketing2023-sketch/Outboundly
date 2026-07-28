import { describe, expect, it } from "vitest";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import { buildRfc5322Headers, generateMessageId } from "../../src/core/mime/rfc5322-builder.js";
import { generateMimeTree } from "../../src/core/mime/mime-generator.js";
import { canonicalize } from "../../src/core/mime/canonicalizer.js";
import { evaluateGmailCompatibility } from "../../src/core/gmail-compatibility/engine.js";
import { evaluateDeliverability, hasBlockingFindings } from "../../src/core/deliverability/engine.js";
import type { MessageContext } from "../../src/core/deliverability/types.js";
import type { BuiltMimeMessage } from "../../src/core/mime/types.js";

const FROM_EMAIL = "me@outboundly.app";

function buildMessage(fromHeaderOverride?: string): BuiltMimeMessage {
  const headers = buildRfc5322Headers({
    from: { address: EmailAddress.parse(FROM_EMAIL) },
    to: [{ address: EmailAddress.parse("them@example.com") }],
    subject: "Hello",
    date: new Date(),
    messageId: generateMessageId("outboundly.app", "draft-clean")
  });
  const tree = generateMimeTree({ html: "<div>Hi there, a real message.</div>", text: "Hi there, a real message." });
  const built = canonicalize(headers, tree);
  if (!fromHeaderOverride) return built;
  return {
    ...built,
    headers: built.headers.map((h) => (h.name === "From" ? { ...h, value: fromHeaderOverride } : h)),
    raw: built.raw.replace(/^From:.*\r\n/m, `From: ${fromHeaderOverride}\r\n`)
  };
}

function contextFor(message: BuiltMimeMessage, overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    message,
    compatibilityReport: evaluateGmailCompatibility(message),
    authenticatedAccountEmail: FROM_EMAIL,
    bodyHtml: "<div>Hi there, a real message.</div>",
    bodyText: "Hi there, a real message.",
    ...overrides
  };
}

describe("Deliverability Engine (Section 17)", () => {
  it("scores a clean, consistent message at 100 with no findings", () => {
    const report = evaluateDeliverability(contextFor(buildMessage()));
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(100);
    expect(hasBlockingFindings(report)).toBe(false);
  });

  it("delegates rfc/mime findings from the Gmail Compatibility Layer rather than re-deriving them", () => {
    const clean = buildMessage();
    const broken: BuiltMimeMessage = {
      ...clean,
      headers: clean.headers.filter((h) => h.name !== "Message-ID"),
      raw: clean.raw.replace(/^Message-ID:.*\r\n/m, "")
    };
    const report = evaluateDeliverability(contextFor(broken));
    const delegated = report.findings.find((f) => f.ruleId === "header-message-id-present");
    expect(delegated?.category).toBe("rfc");
    expect(delegated?.severity).toBe("blocking");
    expect(hasBlockingFindings(report)).toBe(true);
  });

  it("flags a From header that doesn't match the authenticated account as blocking", () => {
    const message = buildMessage("spoofed@evil.example");
    const report = evaluateDeliverability(contextFor(message));
    const finding = report.findings.find((f) => f.ruleId === "sender-from-matches-account");
    expect(finding?.severity).toBe("blocking");
    expect(hasBlockingFindings(report)).toBe(true);
  });

  it("flags a display name that itself looks like a different email address", () => {
    const message = buildMessage('"billing@realbank.com" <me@outboundly.app>');
    const report = evaluateDeliverability(contextFor(message));
    expect(report.findings.some((f) => f.ruleId === "sender-no-display-name-mismatch")).toBe(true);
  });

  it("flags an empty plain-text part as blocking", () => {
    const message = buildMessage();
    const report = evaluateDeliverability(contextFor(message, { bodyText: "   " }));
    const finding = report.findings.find((f) => f.ruleId === "content-plain-text-meaningful");
    expect(finding?.severity).toBe("blocking");
  });

  it("flags a wildly HTML-heavy message relative to its plain text", () => {
    const message = buildMessage();
    const report = evaluateDeliverability(
      contextFor(message, { bodyHtml: "<div>" + "x".repeat(5000) + "</div>", bodyText: "hi" })
    );
    expect(report.findings.some((f) => f.ruleId === "content-html-text-ratio")).toBe(true);
  });

  it("flags an image-heavy message relative to its text content", () => {
    const message = buildMessage();
    const heavyHtml = Array.from({ length: 10 }, (_, i) => `<img src="https://example.com/${i}.png">`).join("");
    const report = evaluateDeliverability(contextFor(message, { bodyHtml: heavyHtml, bodyText: "hi" }));
    expect(report.findings.some((f) => f.ruleId === "content-image-text-ratio")).toBe(true);
  });

  it("flags a structurally malformed link", () => {
    const message = buildMessage();
    const report = evaluateDeliverability(
      contextFor(message, { bodyHtml: '<a href="not a url">click</a>', bodyText: "click here" })
    );
    expect(report.findings.some((f) => f.ruleId === "content-malformed-links")).toBe(true);
  });

  it("interprets auth status when supplied, staying silent when it isn't", () => {
    const message = buildMessage();
    const withoutAuth = evaluateDeliverability(contextFor(message));
    expect(withoutAuth.findings.some((f) => f.category === "auth")).toBe(false);

    const withFailingAuth = evaluateDeliverability(
      contextFor(message, { authStatus: { spf: "fail", dkim: "fail", dmarc: "none" } })
    );
    expect(withFailingAuth.findings.some((f) => f.ruleId === "auth-spf-configured")).toBe(true);
    expect(withFailingAuth.findings.some((f) => f.ruleId === "auth-dkim-configured")).toBe(true);
    expect(withFailingAuth.findings.some((f) => f.ruleId === "auth-dmarc-configured")).toBe(true);
  });

  it("treats 'unknown' auth status as silent, distinct from 'none'/'fail' (e.g. DKIM on a consumer @gmail.com address)", () => {
    const message = buildMessage();
    const report = evaluateDeliverability(
      contextFor(message, { authStatus: { spf: "pass", dkim: "unknown", dmarc: "pass" } })
    );
    expect(report.findings.some((f) => f.category === "auth")).toBe(false);
  });
});
