import { describe, expect, it } from "vitest";
import { MicrosoftProvider } from "../../src/adapters/providers/microsoft/microsoft-provider.js";
import { InMemoryTokenVault } from "../../src/adapters/credential-vault/in-memory-token-vault.js";
import { MICROSOFT_CAPABILITIES } from "../../src/ports/provider-capabilities.port.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

describe("MicrosoftProvider (Section 12.3, Microsoft variant)", () => {
  const config = { clientId: "test-client-id", scopes: ["Mail.Send", "Mail.ReadWrite"] };

  it("reports Microsoft's provider capabilities", () => {
    const provider = new MicrosoftProvider(config, new InMemoryTokenVault());
    expect(provider.capabilities()).toEqual(MICROSOFT_CAPABILITIES);
  });

  it("refuses to authenticate an account with no stored token cache, asking for reconnect rather than failing silently", async () => {
    const provider = new MicrosoftProvider(config, new InMemoryTokenVault());
    await expect(
      provider.authenticate({ accountId: asAccountId("missing-account"), emailAddress: "me@outboundly.app" })
    ).rejects.toThrow(/reconnect required/);
  });

  it("appendToSentFolder is an intentional no-op for Graph (mirrors Gmail's Sent-label auto-filing)", async () => {
    const provider = new MicrosoftProvider(config, new InMemoryTokenVault());
    await expect(
      provider.appendToSentFolder(
        { accountId: asAccountId("acct"), emailAddress: "me@outboundly.app" },
        Buffer.from("")
      )
    ).resolves.toBeUndefined();
  });
});
