import { describe, expect, it } from "vitest";
import { SmtpImapProvider } from "../../src/adapters/providers/smtp-imap/smtp-imap-provider.js";
import { serializeSmtpImapCredentials } from "../../src/adapters/providers/smtp-imap/credentials.js";
import { InMemoryTokenVault } from "../../src/adapters/credential-vault/in-memory-token-vault.js";
import { SMTP_IMAP_CAPABILITIES } from "../../src/ports/provider-capabilities.port.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

describe("SmtpImapProvider (Section 12.3, universal fallback)", () => {
  it("reports SMTP/IMAP's honest capability floor", () => {
    const provider = new SmtpImapProvider(new InMemoryTokenVault());
    expect(provider.capabilities()).toEqual(SMTP_IMAP_CAPABILITIES);
  });

  it("refuses to authenticate an account with no stored credentials, asking for reconnect rather than failing silently", async () => {
    const provider = new SmtpImapProvider(new InMemoryTokenVault());
    await expect(
      provider.authenticate({ accountId: asAccountId("missing-account"), emailAddress: "me@outboundly.app" })
    ).rejects.toThrow(/reconnect required/);
  });

  it("refuses to send a draft that wasn't created in this session (no server-side drafts over SMTP/IMAP)", async () => {
    const vault = new InMemoryTokenVault();
    const accountId = asAccountId("acct");
    await vault.store(
      accountId,
      serializeSmtpImapCredentials({
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpSecure: false,
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        username: "me@example.com",
        password: "app-password"
      })
    );
    const provider = new SmtpImapProvider(vault);
    await expect(
      provider.sendDraft(
        { accountId, emailAddress: "me@example.com" },
        { providerDraftId: "does-not-exist" }
      )
    ).rejects.toThrow(/no server-side drafts/);
  });

  it("round-trips a created draft's id without hitting the network until sendDraft is called", async () => {
    const provider = new SmtpImapProvider(new InMemoryTokenVault());
    const draftRef = await provider.createDraft(
      { accountId: asAccountId("acct"), emailAddress: "me@example.com" },
      { headers: [], root: { contentType: "text/plain", headers: [], encoding: "7bit" }, raw: "raw mime content" }
    );
    expect(draftRef.providerDraftId).toBeTruthy();
  });

  it("fetchThread degenerates to a single-message thread (no native thread expansion over IMAP)", async () => {
    const provider = new SmtpImapProvider(new InMemoryTokenVault());
    const thread = await provider.fetchThread(
      { accountId: asAccountId("acct"), emailAddress: "me@example.com" },
      "some-ref"
    );
    expect(thread).toEqual({ providerThreadId: "some-ref", messageRefs: ["some-ref"] });
  });
});
