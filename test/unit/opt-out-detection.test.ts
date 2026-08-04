import { describe, expect, it } from "vitest";
import { looksLikeOptOutRequest, stripQuotedReplyText } from "../../src/core/campaigns/opt-out-detection.js";

describe("opt-out detection", () => {
  describe("explicit removal requests are detected", () => {
    const optOuts: Array<[string, string]> = [
      ["one-word subject, empty body", "Unsubscribe"],
      ["please remove me", "Please remove me from your list."],
      ["take me off", "Hi -- please take me off your mailing list. Thanks."],
      ["stop emailing", "Stop emailing me."],
      ["do not contact", "Do not contact me again."],
      ["dont contact (no apostrophe)", "dont contact me please"],
      ["opt out", "I'd like to opt out."],
      ["opt-out hyphenated", "How do I opt-out of these?"],
      ["no further emails", "No further emails please."],
      ["delete my details", "Please delete my details from your database."],
      ["remove us (plural)", "Please remove us from all future mailings."]
    ];

    for (const [label, body] of optOuts) {
      it(label, () => {
        expect(looksLikeOptOutRequest("Re: Quick question", body)).toBe(true);
      });
    }

    it("matches on the subject line alone, since a bare 'Unsubscribe' subject is a real form of this", () => {
      expect(looksLikeOptOutRequest("Unsubscribe", "")).toBe(true);
    });
  });

  describe("does NOT fire on ordinary replies (false positives permanently lose a live lead)", () => {
    const notOptOuts: Array<[string, string]> = [
      // A soft no is not a removal request -- the ordinary reply path already stops the sequence.
      ["not interested", "Not interested, thanks."],
      ["no thanks", "No thanks."],
      ["wrong person", "You've got the wrong person, I don't handle this."],
      ["genuine interest", "Sounds interesting -- can you send over pricing?"],
      ["a polite decline", "We're all set for now, but appreciate you reaching out."],
      ["out of office", "I'm out of the office until Monday with limited access to email."],
      // "stop" as an ordinary word must not trigger -- patterns require stop+<contact verb>.
      ["stop used innocuously", "Do stop by our booth at the conference next week."],
      ["remove used about something else", "Can you remove the attachment and resend? It won't open."]
    ];

    for (const [label, body] of notOptOuts) {
      it(label, () => {
        expect(looksLikeOptOutRequest("Re: Quick question", body)).toBe(false);
      });
    }

    it("ignores opt-out wording that appears only inside the quoted original message", () => {
      // Our own outreach copy invites a reply to opt out. Quoted back inside an otherwise ordinary
      // reply, that must not suppress the person who merely answered the question.
      const body = [
        "Yes, happy to chat -- how about Thursday?",
        "",
        "On Mon, Aug 3, 2026 at 9:15 AM Sales <me@example.com> wrote:",
        "> Hi Dana, quick question about your onboarding.",
        "> Not a fit? Just reply and I'll close your file, or unsubscribe here.",
        "> Thanks!"
      ].join("\n");
      expect(looksLikeOptOutRequest("Re: Quick question", body)).toBe(false);
    });

    it("ignores an Outlook-style quoted block", () => {
      const body = [
        "Thanks, forwarding this to our ops lead.",
        "",
        "-----Original Message-----",
        "From: Sales <me@example.com>",
        "Reply to unsubscribe from future emails."
      ].join("\n");
      expect(looksLikeOptOutRequest("RE: Quick question", body)).toBe(false);
    });

    it("ignores a newsletter footer buried far below the reply text", () => {
      const body = `Sure, let's talk next week.\n\n${"filler line\n".repeat(80)}\nTo unsubscribe click here.`;
      expect(looksLikeOptOutRequest("Re: Quick question", body)).toBe(false);
    });

    it("treats an absent body as no request rather than throwing", () => {
      expect(looksLikeOptOutRequest(undefined, undefined)).toBe(false);
    });
  });

  describe("stripQuotedReplyText", () => {
    it("drops '>' quoted lines but keeps the reply itself", () => {
      expect(stripQuotedReplyText("My answer\n> quoted bit\n> more quoted").trim()).toBe("My answer");
    });

    it("cuts everything after a Gmail-style attribution line", () => {
      expect(stripQuotedReplyText("My answer\nOn Mon, Aug 3, 2026 at 9:15 AM Bob <b@x.com> wrote:\nunsubscribe").trim()).toBe(
        "My answer"
      );
    });

    it("leaves an unquoted body untouched", () => {
      expect(stripQuotedReplyText("Just a normal reply.")).toBe("Just a normal reply.");
    });
  });
});
