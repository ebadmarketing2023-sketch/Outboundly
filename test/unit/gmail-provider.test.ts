import { describe, expect, it } from "vitest";
import { GmailProvider } from "../../src/adapters/providers/google/gmail-provider.js";
import { InMemoryTokenVault } from "../../src/adapters/credential-vault/in-memory-token-vault.js";
import { GMAIL_CAPABILITIES } from "../../src/ports/provider-capabilities.port.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

describe("GmailProvider (Section 12.3)", () => {
  const config = { clientId: "test-client-id", scopes: ["https://www.googleapis.com/auth/gmail.send"] };

  it("reports Gmail's provider capabilities", () => {
    const provider = new GmailProvider(config, new InMemoryTokenVault());
    expect(provider.capabilities()).toEqual(GMAIL_CAPABILITIES);
  });

  it("refuses to authenticate an account with no stored tokens, asking for reconnect rather than failing silently", async () => {
    const provider = new GmailProvider(config, new InMemoryTokenVault());
    await expect(
      provider.authenticate({ accountId: asAccountId("missing-account"), emailAddress: "me@outboundly.app" })
    ).rejects.toThrow(/reconnect required/);
  });

  it("appendToSentFolder is an intentional no-op for Gmail (Section 9.5)", async () => {
    const provider = new GmailProvider(config, new InMemoryTokenVault());
    await expect(
      provider.appendToSentFolder(
        { accountId: asAccountId("acct"), emailAddress: "me@outboundly.app" },
        Buffer.from("")
      )
    ).resolves.toBeUndefined();
  });
});
