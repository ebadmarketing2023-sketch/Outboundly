import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type { BuiltMimeMessage } from "../../../core/mime/types.js";
import type {
  AccountRef,
  ChangeSet,
  MailProvider,
  NormalizedThread,
  ProviderDraftRef,
  ProviderSendResult,
  SyncCursor
} from "../../../ports/mail-provider.port.js";
import { GMAIL_CAPABILITIES, type ProviderCapabilities } from "../../../ports/provider-capabilities.port.js";
import type { TokenVault } from "../../../ports/token-vault.port.js";
import type { GoogleOAuthConfig } from "./oauth-flow.js";
import { refreshGoogleAccessToken } from "./oauth-flow.js";

function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

/**
 * Gmail API adapter (Section 12.3): the MailProvider implementation for Google accounts.
 * Compose/Campaign/Deliverability/Queue code never sees a raw Gmail payload — only the
 * BuiltMimeMessage / ProviderSendResult / ProviderDraftRef domain types (Section 12.1).
 */
export class GmailProvider implements MailProvider {
  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly tokenVault: TokenVault
  ) {}

  private async clientFor(account: AccountRef): Promise<OAuth2Client> {
    const tokens = await this.tokenVault.retrieve(account.accountId);
    if (!tokens) {
      throw new Error(`No stored Google tokens for account ${account.accountId} — reconnect required`);
    }

    let { accessToken, refreshToken, expiresAt } = tokens;
    const REFRESH_SKEW_MS = 60_000;
    if (expiresAt.getTime() <= Date.now() + REFRESH_SKEW_MS) {
      const refreshed = await refreshGoogleAccessToken(this.config, refreshToken);
      await this.tokenVault.store(account.accountId, refreshed);
      ({ accessToken, refreshToken, expiresAt } = refreshed);
    }

    const client = new OAuth2Client({ clientId: this.config.clientId, clientSecret: this.config.clientSecret });
    client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: expiresAt.getTime()
    });
    return client;
  }

  async authenticate(account: AccountRef): Promise<void> {
    await this.clientFor(account);
  }

  async sendMessage(account: AccountRef, message: BuiltMimeMessage): Promise<ProviderSendResult> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: toBase64Url(message.raw) }
    });
    if (!data.id) throw new Error("Gmail API did not return a message id");
    return { providerMessageId: data.id, providerThreadId: data.threadId ?? undefined };
  }

  async createDraft(account: AccountRef, message: BuiltMimeMessage): Promise<ProviderDraftRef> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: toBase64Url(message.raw) } }
    });
    if (!data.id) throw new Error("Gmail API did not return a draft id");
    return { providerDraftId: data.id };
  }

  async sendDraft(account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.drafts.send({
      userId: "me",
      requestBody: { id: draftRef.providerDraftId }
    });
    if (!data.id) throw new Error("Gmail API did not return a message id");
    return { providerMessageId: data.id, providerThreadId: data.threadId ?? undefined };
  }

  async listChangesSince(account: AccountRef, cursor: SyncCursor): Promise<ChangeSet> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });

    if (!cursor.cursor) {
      const { data } = await gmail.users.getProfile({ userId: "me" });
      return { cursor: String(data.historyId ?? ""), newOrChangedMessageRefs: [] };
    }

    const { data } = await gmail.users.history.list({ userId: "me", startHistoryId: cursor.cursor });
    const refs = (data.history ?? []).flatMap(
      (entry) => (entry.messagesAdded ?? []).map((added) => added.message?.id).filter((id): id is string => Boolean(id))
    );
    return { cursor: data.historyId ?? cursor.cursor, newOrChangedMessageRefs: refs };
  }

  async fetchThread(account: AccountRef, threadRef: string): Promise<NormalizedThread> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.threads.get({ userId: "me", id: threadRef });
    return {
      providerThreadId: data.id ?? threadRef,
      messageRefs: (data.messages ?? []).map((m) => m.id ?? "").filter(Boolean)
    };
  }

  async appendToSentFolder(): Promise<void> {
    // Intentional no-op: Gmail auto-files sent mail into the Sent label when sent via the API
    // (Section 9.5) — appendToSentFolder only does real work in the SMTP/IMAP adapter, whose
    // provider has no equivalent server-side behavior to rely on.
  }

  capabilities(): ProviderCapabilities {
    return GMAIL_CAPABILITIES;
  }
}
