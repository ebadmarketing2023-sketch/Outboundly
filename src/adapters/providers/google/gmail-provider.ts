import { OAuth2Client } from "google-auth-library";
import { google, type gmail_v1 } from "googleapis";
import type { BuiltMimeMessage } from "../../../core/mime/types.js";
import type {
  AccountRef,
  ChangeSet,
  MailProvider,
  NormalizedMessage,
  NormalizedThread,
  ProviderDraftRef,
  ProviderSendResult,
  SyncCursor
} from "../../../ports/mail-provider.port.js";
import { GMAIL_CAPABILITIES, type ProviderCapabilities } from "../../../ports/provider-capabilities.port.js";
import type { StoredTokens, TokenVault } from "../../../ports/token-vault.port.js";
import type { GoogleOAuthConfig } from "./oauth-flow.js";
import { refreshGoogleAccessToken } from "./oauth-flow.js";

/**
 * Google's token shape, JSON-encoded before being handed to the now-provider-agnostic
 * TokenVault port (Section 13.3) — see token-vault.port.ts for why the port itself no longer
 * assumes this shape (Microsoft's MSAL library needs a completely different payload).
 */
export function serializeStoredTokens(tokens: StoredTokens): string {
  return JSON.stringify({ ...tokens, expiresAt: tokens.expiresAt.toISOString() });
}

export function deserializeStoredTokens(payload: string): StoredTokens {
  const parsed = JSON.parse(payload) as StoredTokens & { expiresAt: string };
  return { ...parsed, expiresAt: new Date(parsed.expiresAt) };
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

export function splitAddressList(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
}

/** Walks a (possibly nested multipart) message part tree collecting the first text/plain and text/html bodies found. */
export function extractBodies(part: gmail_v1.Schema$MessagePart): { html?: string; text?: string } {
  let html: string | undefined;
  let text: string | undefined;

  if (part.mimeType === "text/html" && part.body?.data) {
    html = Buffer.from(part.body.data, "base64url").toString("utf8");
  } else if (part.mimeType === "text/plain" && part.body?.data) {
    text = Buffer.from(part.body.data, "base64url").toString("utf8");
  }

  for (const child of part.parts ?? []) {
    const nested = extractBodies(child);
    html = html ?? nested.html;
    text = text ?? nested.text;
  }

  return { html, text };
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
    const payload = await this.tokenVault.retrieve(account.accountId);
    if (!payload) {
      throw new Error(`No stored Google tokens for account ${account.accountId} — reconnect required`);
    }

    let { accessToken, refreshToken, expiresAt } = deserializeStoredTokens(payload);
    const REFRESH_SKEW_MS = 60_000;
    if (expiresAt.getTime() <= Date.now() + REFRESH_SKEW_MS) {
      const refreshed = await refreshGoogleAccessToken(this.config, refreshToken);
      await this.tokenVault.store(account.accountId, serializeStoredTokens(refreshed));
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

  async sendMessage(account: AccountRef, message: BuiltMimeMessage, providerThreadId?: string): Promise<ProviderSendResult> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: toBase64Url(message.raw), threadId: providerThreadId }
    });
    if (!data.id) throw new Error("Gmail API did not return a message id");
    return { providerMessageId: data.id, providerThreadId: data.threadId ?? undefined };
  }

  async createDraft(account: AccountRef, message: BuiltMimeMessage, providerThreadId?: string): Promise<ProviderDraftRef> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: toBase64Url(message.raw), threadId: providerThreadId } }
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

    if (cursor.cursor) {
      try {
        const { data } = await gmail.users.history.list({ userId: "me", startHistoryId: cursor.cursor });
        const refs = (data.history ?? []).flatMap(
          (entry) => (entry.messagesAdded ?? []).map((added) => added.message?.id).filter((id): id is string => Boolean(id))
        );
        return { cursor: data.historyId ?? cursor.cursor, newOrChangedMessageRefs: refs };
      } catch (err) {
        // GaxiosError (verified against node_modules/gaxios/build/src/common.d.ts) carries the
        // HTTP status at both `.status` and `.response.status` — never at `.code`, which is a
        // Node error-code string (e.g. "ECONNRESET"), not an HTTP status number.
        const status = (err as { status?: number; response?: { status?: number } })?.status ?? (err as { response?: { status?: number } })?.response?.status;
        if (status !== 404) throw err;
        // Gmail's History API documents that a historyId can expire/become invalid, returning
        // 404 ("Requested entity was not found") — and explicitly recommends falling back to a
        // full resync rather than treating it as fatal. Duplicate detection (Section 11.2) makes
        // re-fetching already-known messages harmless; we fall through to the same backfill path
        // first sync uses.
      }
    }

    // First sync for this account, or recovering from an expired/invalid history cursor above:
    // pull a small set of recent messages as a fresh baseline alongside a new cursor, since
    // establishing a bare cursor with zero backfill would leave the Unified Inbox looking empty.
    const INITIAL_BACKFILL_COUNT = 25;
    const [{ data: profile }, { data: list }] = await Promise.all([
      gmail.users.getProfile({ userId: "me" }),
      gmail.users.messages.list({ userId: "me", maxResults: INITIAL_BACKFILL_COUNT })
    ]);
    const refs = (list.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return { cursor: String(profile.historyId ?? ""), newOrChangedMessageRefs: refs };
  }

  async fetchMessage(account: AccountRef, providerMessageId: string): Promise<NormalizedMessage> {
    const auth = await this.clientFor(account);
    const gmail = google.gmail({ version: "v1", auth });
    // format=full: Gmail returns already-parsed headers + a nested MIME part tree, so this reads
    // through the provider's own structured API rather than us hand-parsing raw RFC 2822 text.
    const { data } = await gmail.users.messages.get({ userId: "me", id: providerMessageId, format: "full" });

    const headers = data.payload?.headers;
    const dateHeader = headerValue(headers, "Date");
    const bodies = data.payload ? extractBodies(data.payload) : {};

    return {
      providerMessageId: data.id ?? providerMessageId,
      providerThreadId: data.threadId ?? undefined,
      messageIdHeader: headerValue(headers, "Message-ID") ?? "",
      inReplyToHeader: headerValue(headers, "In-Reply-To"),
      referencesHeader: headerValue(headers, "References"),
      from: headerValue(headers, "From") ?? "",
      to: splitAddressList(headerValue(headers, "To")),
      cc: headerValue(headers, "Cc") ? splitAddressList(headerValue(headers, "Cc")) : undefined,
      subject: headerValue(headers, "Subject") ?? "",
      date: dateHeader ? new Date(dateHeader) : new Date(Number(data.internalDate ?? Date.now())),
      bodyHtml: bodies.html,
      bodyText: bodies.text,
      snippet: data.snippet ?? undefined
    };
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
