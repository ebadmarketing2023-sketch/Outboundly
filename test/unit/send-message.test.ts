import { describe, expect, it } from "vitest";
import { sendDraftMessage } from "../../src/application/send-message/send-message.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import type { Draft } from "../../src/core/drafts/draft.js";
import type { Repository } from "../../src/ports/repository.port.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import type {
  AccountRef,
  ChangeSet,
  MailProvider,
  NormalizedThread,
  ProviderDraftRef,
  ProviderSendResult,
  SyncCursor
} from "../../src/ports/mail-provider.port.js";
import { GMAIL_CAPABILITIES, type ProviderCapabilities } from "../../src/ports/provider-capabilities.port.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import { asAccountId, type DraftId } from "../../src/core/shared-kernel/ids.js";
import type { BuiltMimeMessage } from "../../src/core/mime/types.js";

class InMemoryDraftRepository implements Repository<Draft, DraftId> {
  private readonly store = new Map<DraftId, Draft>();
  async findById(id: DraftId) {
    return this.store.get(id);
  }
  async save(entity: Draft) {
    this.store.set(entity.id, entity);
  }
  async delete(id: DraftId) {
    this.store.delete(id);
  }
}

class FakeMailProvider implements MailProvider {
  public sentRefs: ProviderDraftRef[] = [];
  constructor(private readonly failCompatibility = false) {}

  async authenticate(): Promise<void> {}
  async sendMessage(): Promise<ProviderSendResult> {
    return { providerMessageId: "unused" };
  }
  async createDraft(_account: AccountRef, _message: BuiltMimeMessage): Promise<ProviderDraftRef> {
    return { providerDraftId: "fake-draft-1" };
  }
  async sendDraft(_account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult> {
    this.sentRefs.push(draftRef);
    return { providerMessageId: "fake-message-1", providerThreadId: "fake-thread-1" };
  }
  async listChangesSince(): Promise<ChangeSet> {
    return { cursor: "", newOrChangedMessageRefs: [] };
  }
  async fetchThread(): Promise<NormalizedThread> {
    return { providerThreadId: "t", messageRefs: [] };
  }
  async appendToSentFolder(): Promise<void> {}
  capabilities(): ProviderCapabilities {
    return GMAIL_CAPABILITIES;
  }
}

describe("send-message use case (Phase 1 direct send path)", () => {
  it("builds, checks, and sends a clean draft through the provider's draft-then-send path", async () => {
    const repo = new InMemoryDraftRepository();
    const draftLifecycle = new DraftLifecycleService(repo, new SystemClock());
    const draft = await draftLifecycle.createDraft({
      accountId: asAccountId("account-1"),
      subject: "Hello",
      document: { blocks: [paragraph(textRun("Hi there"))] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });

    const provider = new FakeMailProvider();
    const result = await sendDraftMessage({
      draft,
      from: { address: EmailAddress.parse("me@outboundly.app") },
      sendingDomain: "outboundly.app",
      draftLifecycle,
      provider,
      accountRef: { accountId: asAccountId("account-1"), emailAddress: "me@outboundly.app" }
    });

    expect(result.sent).toBe(true);
    expect(result.providerMessageId).toBe("fake-message-1");
    expect(result.compatibilityReport.score).toBe(100);
    expect(provider.sentRefs).toEqual([{ providerDraftId: "fake-draft-1" }]);

    const reloaded = await repo.findById(draft.id);
    expect(reloaded?.providerDraftRef).toBe("fake-draft-1");
  });

  it("halts before any provider call when a personalization token is unresolved (fail-fast, Section 9.2 stage 3)", async () => {
    const repo = new InMemoryDraftRepository();
    const draftLifecycle = new DraftLifecycleService(repo, new SystemClock());
    const draft = await draftLifecycle.createDraft({
      accountId: asAccountId("account-1"),
      subject: "Hello",
      document: { blocks: [paragraph({ type: "variable", name: "first_name" })] },
      to: [{ address: EmailAddress.parse("them@example.com") }]
    });

    const provider = new FakeMailProvider();
    await expect(
      sendDraftMessage({
        draft,
        from: { address: EmailAddress.parse("me@outboundly.app") },
        sendingDomain: "outboundly.app",
        draftLifecycle,
        provider,
        accountRef: { accountId: asAccountId("account-1"), emailAddress: "me@outboundly.app" }
      })
    ).rejects.toThrow(/first_name/); // unresolved personalization token halts before Gmail Compatibility even runs
    expect(provider.sentRefs).toEqual([]);
  });
});
