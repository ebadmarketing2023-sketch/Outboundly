import { describe, expect, it } from "vitest";
import { buildAttribution, withQuotedReply } from "../../src/core/campaigns/reply-quoting.js";
import { renderHtml } from "../../src/core/rendering/html-renderer.js";
import { renderPlainText } from "../../src/core/rendering/text-renderer.js";
import { parsePlainTextToDocument } from "../../src/core/rendering/plain-text-parser.js";

/**
 * A follow-up used to go out as a bare "Re: ..." with threading headers and nothing else. Gmail
 * groups that correctly, but only in Conversation view -- with that off, or in a client that
 * threads differently, it reads as an unrelated second email sharing a subject line.
 */
describe("quoting the previous message under a follow-up", () => {
  const quoted = {
    bodyText: "Hi Ada,\n\nSaw you're at Acme.\n\nBest,\nEbad",
    fromAddress: '"Ebad" <ebad@outboundly.app>',
    sentAt: new Date(Date.UTC(2026, 7, 5, 14, 30, 0))
  };

  it("writes Gmail's own attribution wording and ordering", () => {
    expect(buildAttribution(quoted, "UTC")).toBe('On Wed, Aug 5, 2026 at 2:30 PM "Ebad" <ebad@outboundly.app> wrote:');
  });

  it("renders the quote in Gmail's markup, so a client collapses it behind the '...' control", () => {
    const followUp = withQuotedReply(parsePlainTextToDocument("Just floating this back up."), quoted, "UTC");
    const html = renderHtml(followUp);

    expect(html).toContain('<div class="gmail_quote">');
    expect(html).toContain('<div dir="ltr" class="gmail_attr">');
    expect(html).toContain('<blockquote class="gmail_quote"');
    // The follow-up's own copy comes first, the quoted history underneath.
    expect(html.indexOf("Just floating this back up.")).toBeLessThan(html.indexOf("gmail_quote"));
    expect(html).toContain("Saw you're at Acme.");
  });

  it("quotes with > prefixes in the plain-text alternative, the way every mail client does", () => {
    const followUp = withQuotedReply(parsePlainTextToDocument("Just floating this back up."), quoted, "UTC");
    const text = renderPlainText(followUp);

    expect(text).toContain("Just floating this back up.");
    expect(text).toContain("wrote:");
    expect(text).toContain("> Hi Ada,");
    expect(text).toContain("> Best,");
  });

  it("leaves the first email of a sequence completely untouched", () => {
    // Nothing to quote yet -- and a first touch must never carry a quote block.
    const first = parsePlainTextToDocument("Hi Ada,\n\nQuick question.");
    expect(withQuotedReply(first, undefined)).toEqual(first);
    expect(renderHtml(withQuotedReply(first, undefined))).not.toContain("gmail_quote");
  });

  it("skips the quote when the previous body is empty rather than emitting an empty blockquote", () => {
    const followUp = parsePlainTextToDocument("Following up.");
    expect(withQuotedReply(followUp, { ...quoted, bodyText: "   " })).toEqual(followUp);
  });

  it("preserves the quoted message's own line structure", () => {
    const followUp = withQuotedReply(parsePlainTextToDocument("Bump."), quoted, "UTC");
    const text = renderPlainText(followUp);
    // Blank line between "Hi Ada," and "Saw you're at Acme." survives as a quoted blank line.
    // One quoted blank line between them -- not two, which is what a mismatched join produced.
    expect(text).toMatch(/> Hi Ada,\n> ?\n> Saw you're at Acme\./);
  });
});
