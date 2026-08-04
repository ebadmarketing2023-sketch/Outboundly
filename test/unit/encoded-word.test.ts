import { describe, expect, it } from "vitest";
import { encodeHeaderText, formatAddressForHeader, headerTextNeedsEncoding } from "../../src/core/mime/encoded-word.js";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";

/** Decodes RFC 2047 encoded-words back to text, so tests assert on what a receiving client would
 * actually display rather than on the exact byte form we happened to emit. Adjacent encoded-words
 * separated by whitespace are concatenated with that whitespace removed (RFC 2047 §6.2). */
function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?UTF-8\?B\?[^?]*\?=)\s+(?==\?UTF-8\?B\?)/gi, "$1")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

const addr = (raw: string, displayName?: string) => ({ address: EmailAddress.parse(raw), displayName });

describe("RFC 2047 encoded-word encoding", () => {
  describe("pure ASCII is left completely untouched", () => {
    it("does not encode an ordinary subject", () => {
      expect(encodeHeaderText("Quick question about onboarding")).toBe("Quick question about onboarding");
    });

    it("does not flag ASCII as needing encoding", () => {
      expect(headerTextNeedsEncoding("Hello world!")).toBe(false);
    });

    it("keeps the pre-existing quoted-string form for an ASCII display name", () => {
      expect(formatAddressForHeader(addr("me@example.com", "Ada Lovelace"))).toBe('"Ada Lovelace" <me@example.com>');
    });

    it("emits a bare address when there is no display name", () => {
      expect(formatAddressForHeader(addr("me@example.com"))).toBe("me@example.com");
    });
  });

  describe("non-ASCII is encoded and round-trips back to the original text", () => {
    const cases = [
      ["accented name", "Café meeting"],
      ["curly apostrophe pasted from a word processor", "Let’s chat"],
      ["em-dash", "Following up — quick question"],
      ["emoji (astral, surrogate pair in JS)", "Great news \u{1F389}"],
      ["CJK", "こんにちは"],
      ["mixed script", "Re: Grüße from São Paulo"]
    ];

    for (const [label, text] of cases) {
      it(label, () => {
        const encoded = encodeHeaderText(text!);
        expect(encoded).not.toBe(text);
        expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
        expect(decodeEncodedWords(encoded)).toBe(text);
      });
    }

    it("encodes a non-ASCII display name and keeps the address parseable", () => {
      const formatted = formatAddressForHeader(addr("jose@example.com", "José García"));
      expect(formatted).toBe("=?UTF-8?B?Sm9zw6kgR2FyY8OtYQ==?= <jose@example.com>");
      expect(decodeEncodedWords(formatted)).toBe("José García <jose@example.com>");
    });

    it("never wraps an encoded-word in quotes (RFC 2047 §5 forbids it inside a quoted-string)", () => {
      const formatted = formatAddressForHeader(addr("jose@example.com", "José"));
      expect(formatted).not.toMatch(/"/);
    });
  });

  describe("length limits", () => {
    it("keeps every encoded-word within RFC 2047's 75-character cap, splitting long text", () => {
      const long = "Café ".repeat(60); // ~300 chars, well past a single encoded-word
      const encoded = encodeHeaderText(long);
      const words = encoded.split(" ").filter((w) => w.startsWith("=?"));
      expect(words.length).toBeGreaterThan(1);
      for (const word of words) {
        expect(word.length).toBeLessThanOrEqual(75);
      }
    });

    it("round-trips long split text back to exactly the original", () => {
      const long = `Grüße ${"a".repeat(200)} São Paulo \u{1F389}`;
      expect(decodeEncodedWords(encodeHeaderText(long))).toBe(long);
    });

    it("never splits a multi-byte character across two encoded-words", () => {
      // Every chunk must decode independently to valid UTF-8; a split mid-character would surface
      // as a U+FFFD replacement character after decoding.
      const manyMultibyte = "こ".repeat(200); // 3 bytes each, forces many chunk boundaries
      const encoded = encodeHeaderText(manyMultibyte);
      for (const word of encoded.split(" ")) {
        const b64 = word.replace(/^=\?UTF-8\?B\?/i, "").replace(/\?=$/, "");
        expect(Buffer.from(b64, "base64").toString("utf8")).not.toContain("�");
      }
      expect(decodeEncodedWords(encoded)).toBe(manyMultibyte);
    });

    it("keeps a 4-byte emoji intact across a chunk boundary", () => {
      const emoji = "\u{1F389}".repeat(40); // 4 bytes each, not a divisor of the 36-byte chunk size
      expect(decodeEncodedWords(encodeHeaderText(emoji))).toBe(emoji);
    });
  });

  describe("quoted-string escaping for ASCII display names", () => {
    it("escapes an embedded double quote", () => {
      expect(formatAddressForHeader(addr("a@b.com", 'Bob "The Closer"'))).toBe('"Bob \\"The Closer\\"" <a@b.com>');
    });

    it("escapes a trailing backslash rather than leaving the quoted-string unterminated", () => {
      expect(formatAddressForHeader(addr("a@b.com", "Acme\\"))).toBe('"Acme\\\\" <a@b.com>');
    });
  });
});
