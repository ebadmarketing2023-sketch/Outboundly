import { parseNamedAddress } from "../shared-kernel/email-address.js";
import { findHeaderValue } from "../mime/headers.js";
import type { DeliverabilityFinding, DeliverabilityRule, MessageContext } from "./types.js";

function finding(
  rule: DeliverabilityRule,
  message: string,
  explanation: string,
  recommendedFix?: string
): DeliverabilityFinding {
  return { ruleId: rule.id, category: rule.category, severity: rule.severity, message, explanation, recommendedFix };
}

/**
 * Content-quality rules (Section 17.2). Two checks from that category's example list aren't here:
 * "broken links" and "redirect-chain depth" both require a live network fetch, which doesn't fit
 * this engine's synchronous `evaluate(ctx): Finding[]` rule contract (the same contract the Gmail
 * Compatibility Layer already uses) — a real implementation would need to be async and would
 * belong to a different extension point (Section 25-style), not a fake local approximation here.
 * "Personalization tokens fully resolved" also isn't re-checked here: it's already a hard stop at
 * pipeline stage 3 (Section 9.2), before a BuiltMimeMessage exists at all, so it can't recur here.
 */

const HTML_TEXT_RATIO_THRESHOLD = 20;

const htmlTextRatio: DeliverabilityRule = {
  id: "content-html-text-ratio",
  category: "content",
  severity: "warning",
  evaluate(ctx) {
    const htmlLength = ctx.bodyHtml?.length ?? 0;
    const textLength = ctx.bodyText?.trim().length ?? 0;
    if (htmlLength === 0 || textLength === 0) return [];
    const ratio = htmlLength / textLength;
    if (ratio <= HTML_TEXT_RATIO_THRESHOLD) return [];
    return [
      finding(
        htmlTextRatio,
        "HTML body is disproportionately large relative to the plain-text alternative",
        "A plain-text part that's a token fraction of the HTML part's size is a classic spam-filter signal — real client-authored mail keeps the two roughly proportional because they're rendering the same content.",
        "Check whether the plain-text renderer is producing a genuine equivalent of the HTML content, not a stub."
      )
    ];
  }
};

const plainTextMeaningful: DeliverabilityRule = {
  id: "content-plain-text-meaningful",
  category: "content",
  severity: "blocking",
  evaluate(ctx) {
    if (ctx.bodyText && ctx.bodyText.trim().length > 0) return [];
    return [
      finding(
        plainTextMeaningful,
        "Plain-text part is empty or whitespace-only",
        "An empty text/plain alternative is both a real deliverability signal spam filters look for and incorrect MIME practice for a multipart/alternative message (Section 9.2 stage 6) — Gmail never sends one.",
        "Ensure the Rendering Engine produces a genuine plain-text equivalent, not a stub, for every message."
      )
    ];
  }
};

const IMAGE_TAG_PATTERN = /<img\b/gi;
const MAX_IMAGES_PER_KILOBYTE_OF_TEXT = 1;

const imageToTextRatio: DeliverabilityRule = {
  id: "content-image-text-ratio",
  category: "content",
  severity: "warning",
  evaluate(ctx) {
    if (!ctx.bodyHtml) return [];
    const imageCount = ctx.bodyHtml.match(IMAGE_TAG_PATTERN)?.length ?? 0;
    if (imageCount === 0) return [];
    const textKilobytes = Math.max((ctx.bodyText?.trim().length ?? 0) / 1024, 0.1);
    if (imageCount / textKilobytes <= MAX_IMAGES_PER_KILOBYTE_OF_TEXT) return [];
    return [
      finding(
        imageToTextRatio,
        "Message is heavy on images relative to its text content",
        "An image-heavy, text-light message is a well-known spam-filter heuristic (historically used to evade text-based content scanning) — the more images relative to real text, the more a message resembles that pattern.",
        "Reduce the number of images, or add more substantive text content."
      )
    ];
  }
};

const HREF_PATTERN = /href\s*=\s*["']([^"']+)["']/gi;

const malformedLinks: DeliverabilityRule = {
  id: "content-malformed-links",
  category: "content",
  severity: "warning",
  evaluate(ctx) {
    if (!ctx.bodyHtml) return [];
    const offenders: string[] = [];
    for (const match of ctx.bodyHtml.matchAll(HREF_PATTERN)) {
      const href = match[1] ?? "";
      if (href.startsWith("mailto:") || href.startsWith("#")) continue;
      try {
        new URL(href);
      } catch {
        offenders.push(href);
      }
    }
    if (offenders.length === 0) return [];
    return offenders.map((href) =>
      finding(
        malformedLinks,
        `Link "${href}" is not a well-formed URL`,
        "A structurally malformed link is either a broken link for the recipient or a sign the message wasn't assembled correctly — this only checks the URL is well-formed, not that it's reachable, since that would require a live network fetch this rule doesn't perform.",
        "Fix the link's URL syntax before sending."
      )
    );
  }
};

/** Sender-consistency rules (Section 17.2). */

const fromMatchesAuthenticatedAccount: DeliverabilityRule = {
  id: "sender-from-matches-account",
  category: "sender-consistency",
  severity: "blocking",
  evaluate(ctx) {
    const fromHeader = findHeaderValue(ctx.message.headers, "From");
    if (!fromHeader) return [];
    const parsed = parseNamedAddress(fromHeader);
    if (parsed.address.toString().toLowerCase() === ctx.authenticatedAccountEmail.toLowerCase()) return [];
    return [
      finding(
        fromMatchesAuthenticatedAccount,
        `From header ("${parsed.address.toString()}") does not match the authenticated sending account ("${ctx.authenticatedAccountEmail}")`,
        "A From address that doesn't match the account actually authenticated to send cannot be validated by SPF/DKIM alignment and will look like spoofing to receiving mail systems.",
        "Set the From header to the authenticated account's own address, or configure a verified Send As alias."
      )
    ];
  }
};

const DISPLAY_NAME_LOOKS_LIKE_ADDRESS = /@/;

const noDisplayNameAddressMismatch: DeliverabilityRule = {
  id: "sender-no-display-name-mismatch",
  category: "sender-consistency",
  severity: "warning",
  evaluate(ctx) {
    const fromHeader = findHeaderValue(ctx.message.headers, "From");
    if (!fromHeader) return [];
    const parsed = parseNamedAddress(fromHeader);
    if (!parsed.displayName || !DISPLAY_NAME_LOOKS_LIKE_ADDRESS.test(parsed.displayName)) return [];
    return [
      finding(
        noDisplayNameAddressMismatch,
        `From display name ("${parsed.displayName}") itself looks like an email address, different from the actual From address ("${parsed.address.toString()}")`,
        "A display name containing a different-looking email address is a well-known spoofing/phishing trick — legitimate clients don't construct From headers this way.",
        "Use a plain display name (e.g. a person's or company's name), not one containing an email address."
      )
    ];
  }
};

const replyToWellFormed: DeliverabilityRule = {
  id: "sender-reply-to-well-formed",
  category: "sender-consistency",
  severity: "warning",
  evaluate(ctx) {
    const replyTo = findHeaderValue(ctx.message.headers, "Reply-To");
    if (!replyTo) return [];
    try {
      parseNamedAddress(replyTo);
      return [];
    } catch {
      return [
        finding(
          replyToWellFormed,
          `Reply-To header ("${replyTo}") is not a well-formed address`,
          "A malformed Reply-To header means replies may simply fail to route back anywhere useful.",
          "Set Reply-To to a valid email address, or omit the header entirely."
        )
      ];
    }
  }
};

/**
 * Auth-readiness rules (Section 17.2) — delegate the actual DNS lookups to the Account Health
 * Engine (Section 19.2); these rules only interpret whatever `ctx.authStatus` the caller supplies.
 * `authStatus` is optional (e.g. the Deliverability Lab may run without it), so these rules are
 * simply silent when it's absent rather than treating "unknown" as a finding.
 */

const spfConfigured: DeliverabilityRule = {
  id: "auth-spf-configured",
  category: "auth",
  severity: "warning",
  evaluate(ctx) {
    if (!ctx.authStatus || ctx.authStatus.spf === "pass") return [];
    return [
      finding(
        spfConfigured,
        `SPF is not passing for this sending domain (status: ${ctx.authStatus.spf})`,
        "Without a passing SPF record, receiving mail systems have a weaker basis for trusting mail claiming to come from this domain, which increases spam-folder placement risk.",
        "Publish or fix an SPF TXT record authorizing this provider to send on the domain's behalf."
      )
    ];
  }
};

const dkimConfigured: DeliverabilityRule = {
  id: "auth-dkim-configured",
  category: "auth",
  severity: "warning",
  evaluate(ctx) {
    if (!ctx.authStatus || ctx.authStatus.dkim === "pass") return [];
    return [
      finding(
        dkimConfigured,
        `DKIM is not passing for this sending domain (status: ${ctx.authStatus.dkim})`,
        "Without DKIM, a message's integrity and origin can't be cryptographically verified by the recipient's mail system, which is a significant deliverability disadvantage.",
        "Enable DKIM signing with your provider and publish the corresponding DNS record."
      )
    ];
  }
};

const dmarcConfigured: DeliverabilityRule = {
  id: "auth-dmarc-configured",
  category: "auth",
  severity: "info",
  evaluate(ctx) {
    if (!ctx.authStatus || ctx.authStatus.dmarc !== "none") return [];
    return [
      finding(
        dmarcConfigured,
        "No DMARC record found for this sending domain",
        "DMARC ties SPF/DKIM together and tells receiving systems what to do with mail that fails alignment; without it, spoofed mail impersonating this domain isn't reported back to the domain owner.",
        "Publish a DMARC TXT record, starting with a monitor-only policy (p=none) if unsure."
      )
    ];
  }
};

export const DELIVERABILITY_RULES: DeliverabilityRule[] = [
  htmlTextRatio,
  plainTextMeaningful,
  imageToTextRatio,
  malformedLinks,
  fromMatchesAuthenticatedAccount,
  noDisplayNameAddressMismatch,
  replyToWellFormed,
  spfConfigured,
  dkimConfigured,
  dmarcConfigured
];
