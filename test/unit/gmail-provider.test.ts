import { describe, expect, it } from "vitest";
import {
  GmailProvider,
  extractBodies,
  headerValue,
  splitAddressList
} from "../../src/adapters/providers/google/gmail-provider.js";
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

describe("GmailProvider.fetchMessage helpers (Section 12: reading via Gmail's structured API)", () => {
  it("finds a header case-insensitively", () => {
    const headers = [{ name: "Message-ID", value: "<abc@x>" }, { name: "Subject", value: "Hi" }];
    expect(headerValue(headers, "message-id")).toBe("<abc@x>");
    expect(headerValue(headers, "Missing")).toBeUndefined();
  });

  it("splits a comma-separated address list and trims whitespace", () => {
    expect(splitAddressList("a@x.com, b@y.com , c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(splitAddressList(undefined)).toEqual([]);
  });

  it("extracts text/plain and text/html bodies from a nested multipart/alternative tree", () => {
    const plainData = Buffer.from("Hi there").toString("base64url");
    const htmlData = Buffer.from("<div>Hi there</div>").toString("base64url");
    const part = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: plainData } },
        { mimeType: "text/html", body: { data: htmlData } }
      ]
    };
    const { html, text } = extractBodies(part);
    expect(text).toBe("Hi there");
    expect(html).toBe("<div>Hi there</div>");
  });

  it("returns undefined bodies when no matching parts exist", () => {
    expect(extractBodies({ mimeType: "application/octet-stream" })).toEqual({});
  });
});
