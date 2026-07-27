import "isomorphic-fetch";
import { PublicClientApplication } from "@azure/msal-node";
import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";
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
import { MICROSOFT_CAPABILITIES, type ProviderCapabilities } from "../../../ports/provider-capabilities.port.js";
import type { TokenVault } from "../../../ports/token-vault.port.js";
import type { MicrosoftOAuthConfig } from "./oauth-flow.js";

/** Every request uses immutable ids (Section 12.3, Microsoft variant): without this header a
 * message's id changes once it's sent/moved, breaking the draftRef → sent-message id continuity
 * MailProvider.sendDraft() relies on (verified via Microsoft's "Obtain immutable identifiers for
 * Outlook resources" doc). */
const IMMUTABLE_ID_PREFER_HEADER = 'IdType="ImmutableId"';

interface GraphEmailAddress {
  address?: string;
  name?: string;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

interface GraphMessageHeader {
  name?: string;
  value?: string;
}

function formatRecipient(emailAddress: GraphEmailAddress | undefined): string {
  if (!emailAddress?.address) return "";
  if (!emailAddress.name) return emailAddress.address;
  const escaped = emailAddress.name.replace(/"/g, '\\"');
  return `"${escaped}" <${emailAddress.address}>`;
}

function headerValue(headers: GraphMessageHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

/** Graph's raw-MIME message creation expects standard base64 (not base64url) — verified against
 * the documented example payload, which contains `+`/`/` characters. */
function toStandardBase64(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64");
}

/**
 * Microsoft Graph adapter (Section 12.3): the MailProvider implementation for Microsoft 365 /
 * Outlook.com accounts. Like GmailProvider, Compose/Campaign/Deliverability/Queue code never
 * sees a raw Graph payload — only the BuiltMimeMessage / ProviderSendResult / ProviderDraftRef
 * domain types.
 */
export class MicrosoftProvider implements MailProvider {
  constructor(
    private readonly config: MicrosoftOAuthConfig,
    private readonly tokenVault: TokenVault
  ) {}

  private async clientFor(account: AccountRef): Promise<Client> {
    const payload = await this.tokenVault.retrieve(account.accountId);
    if (!payload) {
      throw new Error(`No stored Microsoft tokens for account ${account.accountId} — reconnect required`);
    }

    let latestCache = payload;
    const cachePlugin: ICachePlugin = {
      beforeCacheAccess: async (context: TokenCacheContext) => {
        context.tokenCache.deserialize(latestCache);
      },
      afterCacheAccess: async (context: TokenCacheContext) => {
        if (context.cacheHasChanged) {
          latestCache = context.tokenCache.serialize();
          await this.tokenVault.store(account.accountId, latestCache);
        }
      }
    };

    const pca = new PublicClientApplication({
      auth: {
        clientId: this.config.clientId,
        authority: this.config.authority ?? "https://login.microsoftonline.com/common"
      },
      cache: { cachePlugin }
    });

    const accounts = await pca.getAllAccounts();
    const matched = accounts.find((a) => a.username.toLowerCase() === account.emailAddress.toLowerCase());
    if (!matched) {
      throw new Error(`No cached Microsoft account matching ${account.emailAddress} — reconnect required`);
    }

    // acquireTokenSilent handles refreshing the access token from MSAL's cache internally — there
    // is no manual "is it near expiry" check to write ourselves the way GmailProvider needs one,
    // since MSAL never hands us the raw refresh token to manage.
    const result = await pca.acquireTokenSilent({ account: matched, scopes: this.config.scopes });

    return Client.init({
      authProvider: (done) => done(null, result.accessToken)
    });
  }

  async authenticate(account: AccountRef): Promise<void> {
    await this.clientFor(account);
  }

  async sendMessage(account: AccountRef, message: BuiltMimeMessage): Promise<ProviderSendResult> {
    // Graph has no direct "send raw MIME immediately" endpoint — create-then-send (below) is the
    // only path, so sendMessage is implemented in terms of the same two calls sendDraft uses.
    const draftRef = await this.createDraft(account, message);
    return this.sendDraft(account, draftRef);
  }

  async createDraft(account: AccountRef, message: BuiltMimeMessage): Promise<ProviderDraftRef> {
    const client = await this.clientFor(account);
    const data = await client
      .api("/me/messages")
      .header("Content-Type", "text/plain")
      .header("Prefer", IMMUTABLE_ID_PREFER_HEADER)
      .post(toStandardBase64(message.raw));
    if (!data.id) throw new Error("Graph API did not return a message id");
    return { providerDraftId: data.id };
  }

  async sendDraft(account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult> {
    const client = await this.clientFor(account);
    // POST .../send returns 202 Accepted with an empty body (Graph's documented contract — "don't
    // supply a request body", Content-Length: 0), so there's no response payload to read a
    // message id from. With Prefer: IdType="ImmutableId" attached to every request (including the
    // createDraft call above), the id issued at draft-creation time stays valid after send moves
    // the message into Sent Items — the immutable-id guarantee covers folder moves within the
    // same mailbox.
    await client
      .api(`/me/messages/${draftRef.providerDraftId}/send`)
      .header("Prefer", IMMUTABLE_ID_PREFER_HEADER)
      .post("");
    return { providerMessageId: draftRef.providerDraftId };
  }

  async listChangesSince(account: AccountRef, cursor: SyncCursor): Promise<ChangeSet> {
    const client = await this.clientFor(account);

    try {
      return await this.runDeltaQuery(client, cursor.cursor);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status !== 410) throw err;
      // Graph documents that a delta token can become invalid, returning 410 Gone with a
      // resyncRequired error, and that the client must restart with a full resync — there is no
      // way to resume an invalidated delta link. Duplicate detection (Section 11.2) makes
      // re-fetching already-known messages harmless.
      return await this.runDeltaQuery(client, undefined);
    }
  }

  private async runDeltaQuery(client: Client, startCursor: string | undefined): Promise<ChangeSet> {
    const refs: string[] = [];
    let nextUrl = startCursor;
    let isFirstRequest = !startCursor;
    let deltaLink: string | undefined;

    // Delta query can page across multiple rounds (@odata.nextLink) before reaching the
    // round-complete @odata.deltaLink to persist as the next sync cursor — follow every nextLink
    // page within this single sync pass rather than only reading the first page.
    for (;;) {
      const url = nextUrl ?? "/me/mailFolders/inbox/messages/delta";
      let request = client.api(url).header("Prefer", IMMUTABLE_ID_PREFER_HEADER);
      // $select must be specified explicitly on the very first request of a fresh delta chain;
      // it's baked into the @odata.nextLink/@odata.deltaLink tokens for every later round, so
      // re-adding it there would be redundant at best.
      if (isFirstRequest) {
        request = request.select(["id", "conversationId"]);
      }
      const data = await request.get();
      isFirstRequest = false;

      for (const item of (data.value ?? []) as { id?: string }[]) {
        if (item.id) refs.push(item.id);
      }

      if (data["@odata.nextLink"]) {
        nextUrl = data["@odata.nextLink"];
        continue;
      }
      deltaLink = data["@odata.deltaLink"];
      break;
    }

    if (!deltaLink) {
      throw new Error("Graph delta query did not return a deltaLink to persist as the next sync cursor");
    }
    return { cursor: deltaLink, newOrChangedMessageRefs: refs };
  }

  async fetchMessage(account: AccountRef, providerMessageId: string): Promise<NormalizedMessage> {
    const client = await this.clientFor(account);
    const data = await client
      .api(`/me/messages/${providerMessageId}`)
      .header("Prefer", IMMUTABLE_ID_PREFER_HEADER)
      .select([
        "internetMessageId",
        "internetMessageHeaders",
        "subject",
        "from",
        "toRecipients",
        "ccRecipients",
        "body",
        "bodyPreview",
        "receivedDateTime",
        "sentDateTime",
        "conversationId"
      ])
      .get();

    const headers = data.internetMessageHeaders as GraphMessageHeader[] | undefined;
    const toAddresses = ((data.toRecipients ?? []) as GraphRecipient[]).map((r) => formatRecipient(r.emailAddress));
    const ccAddresses = ((data.ccRecipients ?? []) as GraphRecipient[]).map((r) => formatRecipient(r.emailAddress));
    const dateStr: string | undefined = data.sentDateTime ?? data.receivedDateTime;

    return {
      providerMessageId: data.id ?? providerMessageId,
      providerThreadId: data.conversationId ?? undefined,
      messageIdHeader: data.internetMessageId ?? "",
      inReplyToHeader: headerValue(headers, "In-Reply-To"),
      referencesHeader: headerValue(headers, "References"),
      from: formatRecipient((data.from as GraphRecipient | undefined)?.emailAddress),
      to: toAddresses,
      cc: ccAddresses.length > 0 ? ccAddresses : undefined,
      subject: data.subject ?? "",
      date: dateStr ? new Date(dateStr) : new Date(),
      bodyHtml: data.body?.contentType === "html" ? data.body.content : undefined,
      bodyText: data.body?.contentType === "text" ? data.body.content : undefined,
      snippet: data.bodyPreview ?? undefined
    };
  }

  async fetchThread(account: AccountRef, threadRef: string): Promise<NormalizedThread> {
    const client = await this.clientFor(account);
    // Graph has no single "get thread" endpoint — conversationId is a filterable property on
    // messages, so a thread's member messages are found via a filtered list instead (Section 12.1
    // still only exposes this as a flat list of message refs to the caller).
    const data = await client
      .api("/me/messages")
      .header("Prefer", IMMUTABLE_ID_PREFER_HEADER)
      .filter(`conversationId eq '${threadRef.replace(/'/g, "''")}'`)
      .select(["id"])
      .get();

    return {
      providerThreadId: threadRef,
      messageRefs: ((data.value ?? []) as { id?: string }[]).map((m) => m.id ?? "").filter(Boolean)
    };
  }

  async appendToSentFolder(): Promise<void> {
    // Intentional no-op: Graph auto-files sent mail into Sent Items when sent via the API
    // (mirrors GmailProvider.appendToSentFolder) — this only does real work in the SMTP/IMAP
    // adapter, whose provider has no equivalent server-side behavior to rely on.
  }

  capabilities(): ProviderCapabilities {
    return MICROSOFT_CAPABILITIES;
  }
}
