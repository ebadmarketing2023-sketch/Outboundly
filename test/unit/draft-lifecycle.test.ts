import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/ports/clock.port.js";
import type { Repository } from "../../src/ports/repository.port.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import type { Draft } from "../../src/core/drafts/draft.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import { asAccountId, type DraftId } from "../../src/core/shared-kernel/ids.js";

class InMemoryDraftRepository implements Repository<Draft, DraftId> {
  private readonly store = new Map<DraftId, Draft>();

  async findById(id: DraftId): Promise<Draft | undefined> {
    return this.store.get(id);
  }
  async save(entity: Draft): Promise<void> {
    this.store.set(entity.id, entity);
  }
  async delete(id: DraftId): Promise<void> {
    this.store.delete(id);
  }
}

class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe("Draft Lifecycle service (Section 7)", () => {
  const accountId = asAccountId("account-1");

  it("creates a draft at autosave version 1", async () => {
    const { service } = makeTestService();
    const draft = await service.createDraft({
      accountId,
      subject: "Hello",
      document: { blocks: [paragraph(textRun("Hi there"))] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });
    expect(draft.autosaveVersion).toBe(1);
    expect(draft.subject).toBe("Hello");
  });

  it("bumps autosave version and timestamp on every autosave", async () => {
    const { service, clock } = makeTestService();
    const draft = await service.createDraft({
      accountId,
      subject: "Hello",
      document: { blocks: [] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });
    clock.advance(5000);
    const resaved = await service.autosave(draft.id, { subject: "Hello, updated" });
    expect(resaved.autosaveVersion).toBe(2);
    expect(resaved.subject).toBe("Hello, updated");
    expect(resaved.lastSavedAt.getTime()).toBeGreaterThan(draft.lastSavedAt.getTime());
  });

  it("builds a fully canonicalized MIME message from a draft, with a Message-ID that actually uses the given sending domain", async () => {
    const { service } = makeTestService();
    const draft = await service.createDraft({
      accountId,
      subject: "Hello",
      document: { blocks: [paragraph(textRun("Hi there"))] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });

    const built1 = service.buildMimeMessage(draft, {
      from: { address: EmailAddress.parse("me@outboundly.app") },
      sendingDomain: "outboundly.app"
    });
    const built2 = service.buildMimeMessage(draft, {
      from: { address: EmailAddress.parse("me@outboundly.app") },
      sendingDomain: "outboundly.app"
    });

    const messageId1 = built1.headers.find((h) => h.name === "Message-ID")?.value;
    const messageId2 = built2.headers.find((h) => h.name === "Message-ID")?.value;
    // Stable across rebuilds of the same draft *given the same sendingDomain* (Section 9.2, stage
    // 7) -- callers are responsible for supplying that consistently across the enqueue-time and
    // dispatch-time builds of the same campaign message (see fire-enrollment-step.ts /
    // send-worker-tick.ts, and the multi-account-rotation integration test in
    // send-worker-tick.test.ts, which is what actually exercises that cross-call consistency).
    expect(messageId1).toBe(messageId2);
    expect(messageId1).toContain("@outboundly.app>");
    expect(built1.raw).toContain("Hi there");

    // A real, non-hardcoded domain: a different sendingDomain for the same draft mints a
    // different Message-ID, proving the domain isn't silently ignored (a real reported bug --
    // this app previously hardcoded a single fixed domain across every account, which is itself a
    // cross-user fingerprint reputation systems use to spot mass-mailing-tool traffic).
    const builtOtherDomain = service.buildMimeMessage(draft, {
      from: { address: EmailAddress.parse("me@outboundly.app") },
      sendingDomain: "customer-domain.com"
    });
    const messageIdOtherDomain = builtOtherDomain.headers.find((h) => h.name === "Message-ID")?.value;
    expect(messageIdOtherDomain).toContain("@customer-domain.com>");
    expect(messageIdOtherDomain).not.toBe(messageId1);
  });

  it("resolves personalization variables when building the MIME message, and fails clearly when unresolved", async () => {
    const { service } = makeTestService();
    const draft = await service.createDraft({
      accountId,
      subject: "Hello {{first_name}}",
      document: { blocks: [paragraph(textRun("Hi "), { type: "variable", name: "first_name" })] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });

    expect(() =>
      service.buildMimeMessage(draft, {
        from: { address: EmailAddress.parse("me@outboundly.app") },
        sendingDomain: "outboundly.app"
      })
    ).toThrow(/first_name/);

    const built = service.buildMimeMessage(draft, {
      from: { address: EmailAddress.parse("me@outboundly.app") },
      sendingDomain: "outboundly.app",
      personalizationValues: { first_name: "Jordan" }
    });
    expect(built.raw).toContain("Hi Jordan");
  });

  it("personalizes the subject line too, not only the body", async () => {
    // "Quick question, {{first_name}}" is the single most common outreach subject, and the campaign
    // wizard invites you to write one -- but the subject is a plain string, not a Document, so it
    // used to skip the personalization pass entirely and ship with the literal token in it.
    const { service } = makeTestService();
    const draft = await service.createDraft({
      accountId,
      subject: "Quick question, {{first_name}}",
      document: { blocks: [paragraph(textRun("No tokens here."))] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });

    const built = service.buildMimeMessage(draft, {
      from: { address: EmailAddress.parse("me@outboundly.app") },
      sendingDomain: "outboundly.app",
      personalizationValues: { first_name: "Jordan" }
    });

    expect(built.headers.find((h) => h.name === "Subject")?.value).toBe("Quick question, Jordan");
    expect(built.raw).not.toContain("{{first_name}}");
  });

  it("applies a subject fallback, and hard-stops on a required subject token with no value", async () => {
    const { service } = makeTestService();
    const withFallback = await service.createDraft({
      accountId,
      subject: "Quick question, {{first_name|there}}",
      document: { blocks: [paragraph(textRun("Body."))] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });
    const built = service.buildMimeMessage(withFallback, {
      from: { address: EmailAddress.parse("me@outboundly.app") },
      sendingDomain: "outboundly.app",
      personalizationValues: { email: "them@example.com" }
    });
    expect(built.headers.find((h) => h.name === "Subject")?.value).toBe("Quick question, there");

    const required = await service.createDraft({
      accountId,
      subject: "Quick question, {{first_name}}",
      document: { blocks: [paragraph(textRun("Body."))] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });
    expect(() =>
      service.buildMimeMessage(required, {
        from: { address: EmailAddress.parse("me@outboundly.app") },
        sendingDomain: "outboundly.app",
        personalizationValues: { email: "them@example.com" }
      })
    ).toThrow(/first_name/);
  });
});

// Helper to avoid name collision with the `service` variable inside each `it` block.
function makeTestService() {
  const repo = new InMemoryDraftRepository();
  const clock = new FixedClock(new Date(Date.UTC(2026, 0, 15, 9, 0, 0)));
  return { service: new DraftLifecycleService(repo, clock), repo, clock };
}
