import type { BuiltMimeMessage, MimeHeader, MimePart } from "../mime/types.js";
import type { CompatibilityFinding, CompatibilityRule } from "./types.js";

function headerValue(headers: MimeHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function allLeafParts(part: MimePart): MimePart[] {
  if (!part.parts) return [part];
  return part.parts.flatMap(allLeafParts);
}

function allParts(part: MimePart): MimePart[] {
  return part.parts ? [part, ...part.parts.flatMap(allParts)] : [part];
}

function finding(rule: CompatibilityRule, message: string, explanation: string, recommendedFix: string): CompatibilityFinding {
  return { ruleId: rule.id, category: rule.category, severity: rule.severity, message, explanation, recommendedFix };
}

const messageIdPresent: CompatibilityRule = {
  id: "header-message-id-present",
  category: "headers",
  severity: "blocking",
  evaluate(message) {
    const value = headerValue(message.headers, "Message-ID");
    if (value && /^<[^<>@\s]+@[^<>@\s]+>$/.test(value)) return [];
    return [
      finding(
        messageIdPresent,
        "Message-ID header is missing or malformed",
        "Every legitimate mail client, including Gmail, assigns a unique Message-ID to every outbound message; its absence or malformed form is one of the strongest signals a receiving filter uses to distinguish hand-crafted or scripted mail from a real client.",
        'Generate a Message-ID in the form "<unique-string@sending-domain>" before this message reaches the queue.'
      )
    ];
  }
};

const datePresent: CompatibilityRule = {
  id: "header-date-present",
  category: "headers",
  severity: "blocking",
  evaluate(message) {
    const value = headerValue(message.headers, "Date");
    if (value && !Number.isNaN(Date.parse(value))) return [];
    return [
      finding(
        datePresent,
        "Date header is missing or unparsable",
        "RFC 5322 requires a Date header, and receiving systems use it for both threading and spam heuristics.",
        "Populate the Date header with a valid RFC 5322 date-time before sending."
      )
    ];
  }
};

const fromPresent: CompatibilityRule = {
  id: "header-from-present",
  category: "headers",
  severity: "blocking",
  evaluate(message) {
    const value = headerValue(message.headers, "From");
    if (value && /@/.test(value)) return [];
    return [
      finding(
        fromPresent,
        "From header is missing or does not contain an address",
        "A message without a valid From address cannot be authenticated by the receiving system and will not resemble anything a real mail client would send.",
        "Ensure the authenticated sending account's address is set as the From header."
      )
    ];
  }
};

const mimeVersionPresent: CompatibilityRule = {
  id: "header-mime-version-present",
  category: "headers",
  severity: "blocking",
  evaluate(message) {
    const value = headerValue(message.headers, "MIME-Version");
    if (value?.trim() === "1.0") return [];
    return [
      finding(
        mimeVersionPresent,
        "MIME-Version: 1.0 header is missing",
        "Every MIME-formatted message a real client produces declares MIME-Version: 1.0; its absence is a structural tell that a message was assembled by a non-standard tool.",
        "Add a MIME-Version: 1.0 header during canonicalization."
      )
    ];
  }
};

const referenceConsistency: CompatibilityRule = {
  id: "header-references-in-reply-to-consistency",
  category: "headers",
  severity: "warning",
  evaluate(message) {
    const inReplyTo = headerValue(message.headers, "In-Reply-To");
    if (!inReplyTo) return [];
    const references = headerValue(message.headers, "References") ?? "";
    if (references.includes(inReplyTo)) return [];
    return [
      finding(
        referenceConsistency,
        "In-Reply-To is set but References does not include it",
        "Gmail and every other client that threads correctly always includes the immediate parent's Message-ID in References; omitting it breaks threading in the recipient's client, which is exactly the failure mode the Conversation Engine (Section 11) is designed to avoid producing.",
        "Append the In-Reply-To value to the end of the References header."
      )
    ];
  }
};

const noDuplicateHeaders: CompatibilityRule = {
  id: "header-no-duplicates",
  category: "headers",
  severity: "blocking",
  evaluate(message) {
    const seen = new Set<string>();
    for (const header of message.headers) {
      const key = header.name.toLowerCase();
      if (seen.has(key)) {
        return [
          finding(
            noDuplicateHeaders,
            `Duplicate "${header.name}" header`,
            "Duplicate headers are undefined or exploitable behavior for many mail parsers and never appear in client-generated mail.",
            "Deduplicate headers before this message reaches the queue — this should already be guaranteed by MIME Canonicalization (Section 9.4), so seeing this finding indicates a regression there."
          )
        ];
      }
      seen.add(key);
    }
    return [];
  }
};

const charsetUtf8: CompatibilityRule = {
  id: "mime-content-type-charset-utf8",
  category: "mime",
  severity: "warning",
  evaluate(message) {
    const offenders = allLeafParts(message.root).filter(
      (part) => part.contentType.startsWith("text/") && !/charset="?UTF-8"?/i.test(part.contentType)
    );
    if (offenders.length === 0) return [];
    return offenders.map((part) =>
      finding(
        charsetUtf8,
        `Text part "${part.contentType}" does not declare UTF-8`,
        "An undeclared or non-UTF-8 charset risks garbled rendering in the recipient's client — Gmail always declares UTF-8 on its text parts.",
        'Set charset="UTF-8" on every text/plain and text/html part.'
      )
    );
  }
};

const multipartBoundaryPresent: CompatibilityRule = {
  id: "mime-multipart-boundary-present",
  category: "mime",
  severity: "blocking",
  evaluate(message) {
    const offenders = allParts(message.root).filter((part) => part.parts && !part.boundary);
    if (offenders.length === 0) return [];
    return offenders.map((part) =>
      finding(
        multipartBoundaryPresent,
        `Multipart part "${part.contentType}" has no boundary assigned`,
        "A multipart body with no boundary is not parseable MIME at all — no real client would ever produce this.",
        "Ensure MIME Canonicalization assigns a boundary to every multipart node before serialization."
      )
    );
  }
};

const transferEncodingDeclared: CompatibilityRule = {
  id: "mime-transfer-encoding-declared",
  category: "mime",
  severity: "warning",
  evaluate(message) {
    const validEncodings = new Set(["7bit", "quoted-printable", "base64"]);
    const offenders = allLeafParts(message.root).filter((part) => !validEncodings.has(part.encoding));
    if (offenders.length === 0) return [];
    return offenders.map((part) =>
      finding(
        transferEncodingDeclared,
        `Leaf part "${part.contentType}" has an unrecognized Content-Transfer-Encoding`,
        "Receiving clients rely on a correct, standard Content-Transfer-Encoding to decode the body at all.",
        "Use one of 7bit, quoted-printable, or base64."
      )
    );
  }
};

const HARD_LINE_LIMIT = 998;

const lineLength: CompatibilityRule = {
  id: "rfc-line-length",
  category: "rfc",
  severity: "blocking",
  evaluate(message) {
    const offendingLine = message.raw.split("\r\n").find((line) => line.length > HARD_LINE_LIMIT);
    if (!offendingLine) return [];
    return [
      finding(
        lineLength,
        "A line exceeds the RFC 5322 998-octet hard limit",
        "Lines this long risk truncation or rejection by intermediate mail transfer agents.",
        "Ensure header folding and body line-wrapping run before this message is queued."
      )
    ];
  }
};

const crlfLineEndings: CompatibilityRule = {
  id: "rfc-crlf-line-endings",
  category: "rfc",
  severity: "blocking",
  evaluate(message) {
    if (!/[^\r]\n/.test(message.raw) && !message.raw.startsWith("\n")) return [];
    return [
      finding(
        crlfLineEndings,
        "Message contains a bare LF line ending",
        "RFC 5322 requires CRLF line endings; a bare LF is a strong signal the message was assembled by a non-standard tool rather than a real MTA-facing client.",
        "Normalize all line endings to CRLF during MIME Canonicalization."
      )
    ];
  }
};

export const GMAIL_COMPATIBILITY_RULES: CompatibilityRule[] = [
  messageIdPresent,
  datePresent,
  fromPresent,
  mimeVersionPresent,
  referenceConsistency,
  noDuplicateHeaders,
  charsetUtf8,
  multipartBoundaryPresent,
  transferEncodingDeclared,
  lineLength,
  crlfLineEndings
];
