import { describe, expect, it } from "vitest";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import {
  buildRfc5322Headers,
  formatRfc5322Date,
  generateMessageId
} from "../../src/core/mime/rfc5322-builder.js";
import { generateMimeTree } from "../../src/core/mime/mime-generator.js";
import {
  canonicalize,
  dedupeAndOrderHeaders,
  foldHeaderLine,
  quotedPrintableEncode
} from "../../src/core/mime/canonicalizer.js";

describe("RFC 5322 builder", () => {
  it("produces a deterministic Message-ID for the same seed", () => {
    const id1 = generateMessageId("outboundly.app", "draft-123");
    const id2 = generateMessageId("outboundly.app", "draft-123");
    const id3 = generateMessageId("outboundly.app", "draft-456");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^<[a-f0-9]+@outboundly\.app>$/);
  });

  it("formats dates with a numeric zone offset, not the deprecated alphabetic form", () => {
    const formatted = formatRfc5322Date(new Date(Date.UTC(2026, 0, 15, 9, 30, 0)));
    expect(formatted).toBe("Thu, 15 Jan 2026 09:30:00 +0000");
  });

  it("builds required headers and omits optional ones when absent", () => {
    const headers = buildRfc5322Headers({
      from: { address: EmailAddress.parse("me@outboundly.app") },
      to: [{ address: EmailAddress.parse("them@example.com") }],
      subject: "Hello",
      date: new Date(),
      messageId: "<abc@outboundly.app>"
    });
    const names = headers.map((h) => h.name);
    expect(names).toEqual(expect.arrayContaining(["Message-ID", "Date", "From", "To", "Subject"]));
    expect(names).not.toContain("Cc");
    expect(names).not.toContain("In-Reply-To");
  });

  it("includes In-Reply-To and References for threaded replies", () => {
    const headers = buildRfc5322Headers({
      from: { address: EmailAddress.parse("me@outboundly.app") },
      to: [{ address: EmailAddress.parse("them@example.com") }],
      subject: "Re: Hello",
      date: new Date(),
      messageId: "<def@outboundly.app>",
      inReplyTo: "<abc@outboundly.app>",
      references: ["<abc@outboundly.app>"]
    });
    expect(headers.find((h) => h.name === "In-Reply-To")?.value).toBe("<abc@outboundly.app>");
    expect(headers.find((h) => h.name === "References")?.value).toBe("<abc@outboundly.app>");
  });
});

describe("MIME Generation (structure only)", () => {
  it("produces multipart/alternative with text and html for a plain message", () => {
    const tree = generateMimeTree({ html: "<div>hi</div>", text: "hi" });
    expect(tree.contentType).toBe("multipart/alternative");
    expect(tree.parts).toHaveLength(2);
    expect(tree.parts?.[0]?.contentType).toContain("text/plain");
    expect(tree.parts?.[1]?.contentType).toContain("text/html");
  });

  it("wraps in multipart/related when inline images are present", () => {
    const tree = generateMimeTree({
      html: "<img src=\"cid:img1\">",
      text: "[image]",
      inlineImages: [{ contentId: "img1", contentType: "image/png", dataBase64: "AAAA" }]
    });
    expect(tree.contentType).toBe("multipart/related");
    expect(tree.parts?.[0]?.contentType).toBe("multipart/alternative");
    expect(tree.parts?.[1]?.contentType).toBe("image/png");
  });

  it("wraps in multipart/mixed when attachments are present, outermost", () => {
    const tree = generateMimeTree({
      html: "<div>hi</div>",
      text: "hi",
      inlineImages: [{ contentId: "img1", contentType: "image/png", dataBase64: "AAAA" }],
      attachments: [{ filename: "doc.pdf", contentType: "application/pdf", dataBase64: "BBBB" }]
    });
    expect(tree.contentType).toBe("multipart/mixed");
    expect(tree.parts?.[0]?.contentType).toBe("multipart/related");
    expect(tree.parts?.[1]?.contentType).toBe("application/pdf");
  });
});

describe("MIME Canonicalization", () => {
  it("dedupes headers keeping the first occurrence and orders known headers first", () => {
    const ordered = dedupeAndOrderHeaders([
      { name: "Subject", value: "first" },
      { name: "X-Custom", value: "custom" },
      { name: "Message-ID", value: "<1@x>" },
      { name: "Subject", value: "duplicate-should-be-dropped" }
    ]);
    expect(ordered.map((h) => h.name)).toEqual(["Message-ID", "Subject", "X-Custom"]);
    expect(ordered.find((h) => h.name === "Subject")?.value).toBe("first");
  });

  it("folds header lines that exceed the recommended length at word boundaries", () => {
    const longValue = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const folded = foldHeaderLine("Subject", longValue);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
    expect(lines.slice(1).every((line) => line.startsWith(" "))).toBe(true);
  });

  it("quoted-printable encodes non-ASCII content and preserves round-trippable structure", () => {
    const encoded = quotedPrintableEncode("café");
    expect(encoded).toBe("caf=C3=A9");
  });

  it("wraps quoted-printable output at 76 columns with soft line breaks", () => {
    const longLine = "a".repeat(200);
    const encoded = quotedPrintableEncode(longLine);
    const lines = encoded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.replace(/=$/, "").length).toBeLessThanOrEqual(75);
  });

  it("produces a fully canonicalized message with matching boundaries and CRLF line endings", () => {
    const headers = buildRfc5322Headers({
      from: { address: EmailAddress.parse("me@outboundly.app"), displayName: "Me" },
      to: [{ address: EmailAddress.parse("them@example.com") }],
      subject: "Hello there",
      date: new Date(Date.UTC(2026, 0, 15, 9, 0, 0)),
      messageId: generateMessageId("outboundly.app", "draft-1")
    });
    const tree = generateMimeTree({ html: "<div>Hi there</div>", text: "Hi there" });
    const built = canonicalize(headers, tree);

    expect(built.raw).not.toMatch(/[^\r]\n/); // no bare LF anywhere
    expect(built.raw).toContain("MIME-Version: 1.0");
    expect(built.raw).toContain("Content-Type: multipart/alternative;");

    // The Content-Type/boundary line legitimately folds across CRLF per RFC 5322 (Section 9.4),
    // so match the boundary value across the folded line rather than assuming a single line.
    const boundaryMatch = built.raw.replace(/\r\n /g, " ").match(/boundary="([^"]+)"/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1];
    expect(built.raw).toContain(`--${boundary}`);
    expect(built.raw).toContain(`--${boundary}--`);
  });

  it("never duplicates a header even if the same one appears in both RFC headers and part headers", () => {
    const headers = buildRfc5322Headers({
      from: { address: EmailAddress.parse("me@outboundly.app") },
      to: [{ address: EmailAddress.parse("them@example.com") }],
      subject: "Test",
      date: new Date(),
      messageId: generateMessageId("outboundly.app", "draft-2")
    });
    const tree = generateMimeTree({ html: "<div>x</div>", text: "x" });
    const built = canonicalize(headers, tree);
    const messageIdCount = (built.raw.match(/^Message-ID:/gm) ?? []).length;
    expect(messageIdCount).toBe(1);
  });
});
