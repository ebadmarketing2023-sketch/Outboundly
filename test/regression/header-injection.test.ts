import { describe, expect, it } from "vitest";
import { canonicalize, foldHeaderLine, sanitizeHeaderValue } from "../../src/core/mime/canonicalizer.js";
import { generateMimeTree } from "../../src/core/mime/mime-generator.js";
import { buildRfc5322Headers, generateMessageId } from "../../src/core/mime/rfc5322-builder.js";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import type { Rfc5322BuilderInput } from "../../src/core/mime/rfc5322-builder.js";

/**
 * Header injection regression suite.
 *
 * A contact's name comes from an imported CSV -- a purchased or scraped lead list is normal in
 * this domain and is not trusted input. A raw CRLF in any header value terminates the field, so
 * whatever follows is parsed by the receiving system as additional headers: a forged Bcc silently
 * copying outbound mail to a third party, or a forged Reply-To hijacking replies.
 *
 * These assert against the fully serialized wire bytes, not the structured header array, because
 * the structured array is exactly what a forged header does NOT appear in.
 */

const address = (raw: string, displayName?: string) => ({ address: EmailAddress.parse(raw), displayName });

function wireHeaderBlock(overrides: Partial<Rfc5322BuilderInput>): string {
  const headers = buildRfc5322Headers({
    from: address("me@acme.com", "Me"),
    to: [address("lead@example.com", "Lead")],
    subject: "Normal subject",
    date: new Date("2026-08-04T12:00:00Z"),
    messageId: generateMessageId("acme.com", "draft-1"),
    ...overrides
  });
  const built = canonicalize(headers, generateMimeTree({ html: "<div>hi</div>", text: "hi" }));
  return built.raw.split("\r\n\r\n")[0]!;
}

/** A forged header is one that starts at column 0 on its own line -- i.e. not folded continuation
 * text, which always begins with whitespace. */
function hasForgedHeader(block: string, name: string): boolean {
  return new RegExp(`^${name}:`, "im").test(block);
}

const CRLF_PAYLOAD = "\r\nBcc: attacker@evil.example";
const LF_PAYLOAD = "\nBcc: attacker@evil.example";

describe("header injection is impossible from any attacker-reachable header value", () => {
  it("cannot be injected through a To display name (CSV-sourced contact name)", () => {
    const block = wireHeaderBlock({ to: [address("lead@example.com", `Bob${CRLF_PAYLOAD}`)] });
    expect(hasForgedHeader(block, "Bcc")).toBe(false);
  });

  it("cannot be injected through a To display name using a bare LF", () => {
    const block = wireHeaderBlock({ to: [address("lead@example.com", `Bob${LF_PAYLOAD}`)] });
    expect(hasForgedHeader(block, "Bcc")).toBe(false);
  });

  it("cannot be injected through a From display name", () => {
    const block = wireHeaderBlock({ from: address("me@acme.com", "Me\r\nReply-To: attacker@evil.example") });
    expect(hasForgedHeader(block, "Reply-To")).toBe(false);
  });

  it("cannot be injected through the subject", () => {
    const block = wireHeaderBlock({ subject: "Hi\r\nX-Injected: yes" });
    expect(hasForgedHeader(block, "X-Injected")).toBe(false);
  });

  // In-Reply-To/References carry provider-supplied Message-IDs and never pass through the RFC 2047
  // encoder, so they were the one vector the encoding work did not incidentally close.
  it("cannot be injected through In-Reply-To", () => {
    const block = wireHeaderBlock({ inReplyTo: `<real@x.com>${CRLF_PAYLOAD}` });
    expect(hasForgedHeader(block, "Bcc")).toBe(false);
  });

  it("cannot be injected through References", () => {
    const block = wireHeaderBlock({ references: [`<real@x.com>${CRLF_PAYLOAD}`] });
    expect(hasForgedHeader(block, "Bcc")).toBe(false);
  });

  it("cannot be injected through a Cc display name", () => {
    const block = wireHeaderBlock({ cc: [address("cc@example.com", `Cc${CRLF_PAYLOAD}`)] });
    expect(hasForgedHeader(block, "Bcc")).toBe(false);
  });

  it("still produces a well-formed, parseable header block under attack", () => {
    const block = wireHeaderBlock({ to: [address("lead@example.com", `Bob${CRLF_PAYLOAD}`)] });
    // Every line is either a `Name: value` header or a folded continuation starting with whitespace.
    for (const line of block.split("\r\n")) {
      expect(line).toMatch(/^(?:[!-9;-~]+:|[ \t])/);
    }
  });
});

describe("sanitizeHeaderValue", () => {
  it("replaces CR and LF with a space rather than dropping the value entirely", () => {
    // Replacing, not rejecting: one malformed row in a lead list must not permanently fail a send.
    // Two spaces, because CR and LF are two characters and each is replaced individually -- the
    // value is deliberately left visibly mangled rather than silently tidied into something that
    // reads as though it were intended.
    expect(sanitizeHeaderValue("Bob\r\nBcc: x@y.com")).toBe("Bob  Bcc: x@y.com");
  });

  it("leaves nothing that could still terminate a header field", () => {
    const sanitized = sanitizeHeaderValue("Bob\r\nBcc: x@y.com");
    expect(sanitized).not.toMatch(/[\r\n]/);
  });

  it("strips other control characters, including NUL and DEL", () => {
    expect(sanitizeHeaderValue("a\u0000b\u007Fc")).toBe("a b c");
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeHeaderValue("Quick question about onboarding")).toBe("Quick question about onboarding");
  });

  it("trims the whitespace left behind by stripped control characters", () => {
    expect(sanitizeHeaderValue("\r\nBob\r\n")).toBe("Bob");
  });
});

describe("foldHeaderLine sanitizes before folding", () => {
  it("does not let an injected CRLF survive as a real line break", () => {
    // Collapses onto a single line: the payload is now inert text inside the Subject value, not a
    // second header. (Two spaces -- CR and LF are replaced individually.)
    const folded = foldHeaderLine("Subject", "Hi\r\nX-Injected: yes");
    expect(folded).toBe("Subject: Hi  X-Injected: yes");
    expect(folded.split("\r\n")).toHaveLength(1);
  });

  it("still folds legitimately long values, whose CRLFs it introduces itself", () => {
    const folded = foldHeaderLine("Subject", "word ".repeat(40).trim());
    expect(folded).toContain("\r\n ");
    for (const line of folded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
  });
});
