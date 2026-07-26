import { describe, expect, it } from "vitest";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import { buildRfc5322Headers, generateMessageId } from "../../src/core/mime/rfc5322-builder.js";
import { generateMimeTree } from "../../src/core/mime/mime-generator.js";
import { canonicalize } from "../../src/core/mime/canonicalizer.js";
import { evaluateGmailCompatibility, hasBlockingFindings } from "../../src/core/gmail-compatibility/engine.js";
import type { BuiltMimeMessage } from "../../src/core/mime/types.js";

function buildCleanMessage(): BuiltMimeMessage {
  const headers = buildRfc5322Headers({
    from: { address: EmailAddress.parse("me@outboundly.app") },
    to: [{ address: EmailAddress.parse("them@example.com") }],
    subject: "Hello",
    date: new Date(),
    messageId: generateMessageId("outboundly.app", "draft-clean")
  });
  const tree = generateMimeTree({ html: "<div>Hi</div>", text: "Hi" });
  return canonicalize(headers, tree);
}

describe("Gmail Compatibility Layer", () => {
  it("scores a properly built message at 100 with no findings", () => {
    const report = evaluateGmailCompatibility(buildCleanMessage());
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(100);
    expect(hasBlockingFindings(report)).toBe(false);
  });

  it("flags a missing Message-ID as blocking", () => {
    const clean = buildCleanMessage();
    const broken: BuiltMimeMessage = {
      ...clean,
      headers: clean.headers.filter((h) => h.name !== "Message-ID"),
      raw: clean.raw.replace(/^Message-ID:.*\r\n/m, "")
    };
    const report = evaluateGmailCompatibility(broken);
    expect(report.findings.some((f) => f.ruleId === "header-message-id-present")).toBe(true);
    expect(hasBlockingFindings(report)).toBe(true);
    expect(report.score).toBeLessThan(100);
  });

  it("flags In-Reply-To without a matching References entry as a warning, not blocking", () => {
    const clean = buildCleanMessage();
    const broken: BuiltMimeMessage = {
      ...clean,
      headers: [...clean.headers, { name: "In-Reply-To", value: "<parent@outboundly.app>" }]
    };
    const report = evaluateGmailCompatibility(broken);
    const finding = report.findings.find((f) => f.ruleId === "header-references-in-reply-to-consistency");
    expect(finding?.severity).toBe("warning");
  });

  it("flags a bare LF line ending as an RFC violation", () => {
    const clean = buildCleanMessage();
    const broken: BuiltMimeMessage = { ...clean, raw: clean.raw.replace("\r\n\r\n", "\r\n\n") };
    const report = evaluateGmailCompatibility(broken);
    expect(report.findings.some((f) => f.ruleId === "rfc-crlf-line-endings")).toBe(true);
  });

  it("flags a duplicated header", () => {
    const clean = buildCleanMessage();
    const broken: BuiltMimeMessage = { ...clean, headers: [...clean.headers, clean.headers[0]!] };
    const report = evaluateGmailCompatibility(broken);
    expect(report.findings.some((f) => f.ruleId === "header-no-duplicates")).toBe(true);
  });

  it("every finding includes a plain-language explanation and a recommended fix (Section 10.3)", () => {
    const clean = buildCleanMessage();
    const broken: BuiltMimeMessage = {
      ...clean,
      headers: clean.headers.filter((h) => h.name !== "Date")
    };
    const report = evaluateGmailCompatibility(broken);
    for (const f of report.findings) {
      expect(f.explanation.length).toBeGreaterThan(10);
      expect(f.recommendedFix.length).toBeGreaterThan(10);
    }
  });
});
