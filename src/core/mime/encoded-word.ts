import { sanitizeHeaderValue } from "./canonicalizer.js";
import type { NamedEmailAddress } from "../shared-kernel/email-address.js";

/**
 * RFC 2047 encoded-word encoding for header field bodies.
 *
 * RFC 5322 §2.2 restricts header field bodies to US-ASCII. Anything else -- an accented lead name
 * ("José"), a curly apostrophe pasted in from Word/Docs ("Let's chat"), an em-dash, an emoji --
 * has to be encoded, and a real mail client does exactly that. Emitting raw UTF-8 octets in a
 * header instead is both non-compliant and a visible tell: it can be rejected or mangled into
 * mojibake by an MTA that hasn't negotiated 8-bit header transport, and it is not what Gmail
 * itself puts on the wire.
 *
 * Base64 ("B") rather than quoted-printable ("Q") is deliberate:
 *   - Q-encoding's permitted character set differs between an unstructured field (Subject) and a
 *     phrase (an address display-name) -- RFC 2047 §5 -- so a single Q encoder is quietly wrong in
 *     one of the two contexts unless it takes the context as a parameter. Base64's output alphabet
 *     (A-Za-z0-9+/=) is valid in both, so there is no context-sensitive escaping to get wrong.
 *   - It matches what Gmail emits for non-ASCII subjects, which is the structure this app is
 *     deliberately mirroring.
 * The cost is that a mostly-ASCII string encodes less compactly than Q would. That cost is only
 * ever paid when the text actually contains non-ASCII: pure-ASCII text is returned untouched, so
 * the overwhelmingly common case stays byte-identical to before and human-readable on the wire.
 */

/** Anything outside printable US-ASCII. Deliberately also catches control characters, which have
 * no business appearing literally in a header field body either. */
const NEEDS_ENCODING = /[^\x20-\x7E]/;

/**
 * RFC 2047 §2 caps a single encoded-word at 75 characters, and longer text must be split across
 * several of them. 36 UTF-8 bytes base64-encodes to 48 characters, which with the 12 characters of
 * `=?UTF-8?B?` + `?=` overhead yields a 60-character encoded-word: comfortably inside the 75-char
 * limit, and short enough that even the first line ("Subject: " + word = 69) stays within RFC
 * 5322's 78-character recommended line length once folded.
 */
const MAX_UTF8_BYTES_PER_WORD = 36;

export function headerTextNeedsEncoding(text: string): boolean {
  return NEEDS_ENCODING.test(text);
}

/**
 * Splits on code-point boundaries, never mid-character. Each encoded-word has to decode to valid
 * UTF-8 independently (RFC 2047 §2), so a chunk that ended halfway through a multi-byte character
 * would produce a word that decodes to a replacement character in the recipient's client. Iterating
 * with for..of yields whole code points, so astral characters (emoji, which are surrogate pairs in
 * JS) are kept intact rather than split between their halves.
 */
function chunkByUtf8Bytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (currentBytes > 0 && currentBytes + charBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

/**
 * Encodes an unstructured header value (e.g. Subject). Pure-ASCII text is returned verbatim.
 * Multiple encoded-words are joined by a single space, which a receiving parser removes when it
 * concatenates adjacent encoded-words (RFC 2047 §6.2) -- and which also gives the header folder a
 * legal place to break the line.
 */
export function encodeHeaderText(rawText: string): string {
  // Sanitize before encoding, not only at serialization: canonicalizer's own pass is what makes
  // injection structurally impossible, but a CR/LF left in place here would survive *inside* the
  // encoded-word and decode back to a literal newline in the recipient's client -- visible
  // garbage in a display name rather than a forged header, but garbage all the same.
  const text = sanitizeHeaderValue(rawText);
  if (!NEEDS_ENCODING.test(text)) return text;
  return chunkByUtf8Bytes(text, MAX_UTF8_BYTES_PER_WORD)
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`)
    .join(" ");
}

/**
 * Formats an address for a header field, encoding the display name when it isn't pure ASCII.
 *
 * Distinct from formatNamedAddress (shared-kernel/email-address.ts), which produces the plain,
 * human-readable form used for database storage and UI display -- encoding there would mean a
 * draft reloaded from disk showed `=?UTF-8?B?...?=` as its recipient's name. Encoding belongs at
 * the wire boundary only, which is here.
 */
export function formatAddressForHeader(named: NamedEmailAddress): string {
  const address = named.address.toString();
  if (!named.displayName) return address;

  const displayName = sanitizeHeaderValue(named.displayName);
  if (!displayName) return address; // nothing left once control characters were stripped

  if (NEEDS_ENCODING.test(displayName)) {
    // RFC 2047 §5: an encoded-word MUST NOT appear inside a quoted-string -- a parser treats the
    // quoted content as literal text and would show the raw `=?UTF-8?B?...?=` to the recipient.
    return `${encodeHeaderText(named.displayName)} <${address}>`;
  }

  // Backslash first, then quote: escaping quotes first would leave the backslashes introduced by
  // that pass to be escaped again by this one, doubling them.
  const escaped = named.displayName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}
