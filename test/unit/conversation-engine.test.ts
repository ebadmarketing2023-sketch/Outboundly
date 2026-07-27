import { describe, expect, it } from "vitest";
import { normalizeSubject } from "../../src/core/conversation/subject-normalizer.js";
import { parseReferenceChain } from "../../src/core/conversation/reference-graph.js";
import { deriveParticipants } from "../../src/core/conversation/participants.js";
import {
  decideConversationPlacement,
  nextConversationState
} from "../../src/core/conversation/conversation-engine.js";

describe("Subject normalization (Section 11.2)", () => {
  it("strips a single Re:/Fwd: prefix", () => {
    expect(normalizeSubject("Re: Hello")).toBe("Hello");
    expect(normalizeSubject("Fwd: Hello")).toBe("Hello");
    expect(normalizeSubject("FW: Hello")).toBe("Hello");
  });

  it("strips repeated prefixes from a long back-and-forth", () => {
    expect(normalizeSubject("Re: Re: Fwd: Re: Hello")).toBe("Hello");
  });

  it("collapses internal whitespace and trims", () => {
    expect(normalizeSubject("  Hello    there  ")).toBe("Hello there");
  });

  it("leaves a subject with no prefix untouched (aside from whitespace)", () => {
    expect(normalizeSubject("Project update")).toBe("Project update");
  });
});

describe("Reference chain reconstruction (Section 11.2, 11.3)", () => {
  it("parses whitespace-separated Message-IDs from References", () => {
    const chain = parseReferenceChain({ referencesHeader: "<a@x> <b@x> <c@x>" });
    expect(chain).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("appends In-Reply-To when it's missing from References", () => {
    const chain = parseReferenceChain({ referencesHeader: "<a@x>", inReplyToHeader: "<b@x>" });
    expect(chain).toEqual(["<a@x>", "<b@x>"]);
  });

  it("does not duplicate In-Reply-To when it's already the last References entry", () => {
    const chain = parseReferenceChain({ referencesHeader: "<a@x> <b@x>", inReplyToHeader: "<b@x>" });
    expect(chain).toEqual(["<a@x>", "<b@x>"]);
  });

  it("returns an empty chain for a message with no threading headers (start of a new conversation)", () => {
    expect(parseReferenceChain({})).toEqual([]);
  });
});

describe("Participant derivation (Section 11.2)", () => {
  it("derives sender/to/cc roles from address headers", () => {
    const participants = deriveParticipants({
      from: '"Alex Doe" <alex@example.com>',
      to: ["them@example.com"],
      cc: ["cc-person@example.com"]
    });
    expect(participants).toEqual([
      { emailAddress: "alex@example.com", displayName: "Alex Doe", role: "sender" },
      { emailAddress: "them@example.com", displayName: undefined, role: "to" },
      { emailAddress: "cc-person@example.com", displayName: undefined, role: "cc" }
    ]);
  });

  it("skips a malformed address instead of throwing, since inbound headers are untrusted input", () => {
    const participants = deriveParticipants({
      from: "not-an-email-at-all",
      to: ["valid@example.com"]
    });
    expect(participants).toEqual([{ emailAddress: "valid@example.com", displayName: undefined, role: "to" }]);
  });
});

describe("Conversation placement decisions (Section 11.2, 11.3)", () => {
  it("recognizes an already-ingested Message-ID as a duplicate", () => {
    const placement = decideConversationPlacement(
      { messageIdHeader: "<a@x>" },
      {
        knownMessageIdToThreadId: new Map([["<a@x>", "thread-1"]]),
        knownProviderThreadIdToThreadId: new Map()
      }
    );
    expect(placement).toEqual({ kind: "duplicate", threadId: "thread-1" });
  });

  it("starts a new thread when there is no known ancestor and no provider thread match", () => {
    const placement = decideConversationPlacement(
      { messageIdHeader: "<new@x>" },
      { knownMessageIdToThreadId: new Map(), knownProviderThreadIdToThreadId: new Map() }
    );
    expect(placement).toEqual({ kind: "new-thread" });
  });

  it("attaches to the thread of a known ancestor via the reference graph", () => {
    const placement = decideConversationPlacement(
      { messageIdHeader: "<reply@x>", inReplyToHeader: "<parent@x>", referencesHeader: "<parent@x>" },
      {
        knownMessageIdToThreadId: new Map([["<parent@x>", "thread-1"]]),
        knownProviderThreadIdToThreadId: new Map()
      }
    );
    expect(placement).toEqual({ kind: "attach", threadId: "thread-1", absorbThreadIds: [] });
  });

  it("attaches via provider thread id fast path even with no header match", () => {
    const placement = decideConversationPlacement(
      { messageIdHeader: "<reply@x>", providerThreadId: "gmail-thread-9" },
      {
        knownMessageIdToThreadId: new Map(),
        knownProviderThreadIdToThreadId: new Map([["gmail-thread-9", "thread-2"]])
      }
    );
    expect(placement).toEqual({ kind: "attach", threadId: "thread-2", absorbThreadIds: [] });
  });

  it("merges two previously-distinct threads when the header graph proves they're the same conversation", () => {
    // An SMTP-only reply lands with no native provider thread id, but its References header
    // points at a message that ended up in a different internal thread than this message's own
    // provider-thread-id match — exactly the case Section 11.2 calls out for SMTP/IMAP accounts.
    const placement = decideConversationPlacement(
      {
        messageIdHeader: "<reply@x>",
        referencesHeader: "<parent@x>",
        providerThreadId: "gmail-thread-9"
      },
      {
        knownMessageIdToThreadId: new Map([["<parent@x>", "thread-1"]]),
        knownProviderThreadIdToThreadId: new Map([["gmail-thread-9", "thread-2"]])
      }
    );
    expect(placement.kind).toBe("attach");
    if (placement.kind === "attach") {
      expect([placement.threadId, ...placement.absorbThreadIds].sort()).toEqual(["thread-1", "thread-2"]);
      expect(placement.absorbThreadIds).not.toContain(placement.threadId);
    }
  });
});

describe("Conversation state transitions (Section 11.2)", () => {
  it("moves to active when the incoming message is inbound (they replied)", () => {
    expect(nextConversationState("awaiting_reply", "inbound")).toBe("active");
  });

  it("moves to awaiting_reply when the incoming message is outbound (we sent it)", () => {
    expect(nextConversationState("active", "outbound")).toBe("awaiting_reply");
  });
});
