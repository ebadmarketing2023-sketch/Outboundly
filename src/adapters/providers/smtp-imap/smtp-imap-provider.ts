import { createTransport } from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { generateId } from "../../../core/shared-kernel/ids.js";
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
import { SMTP_IMAP_CAPABILITIES, type ProviderCapabilities } from "../../../ports/provider-capabilities.port.js";
import type { TokenVault } from "../../../ports/token-vault.port.js";
import { deserializeSmtpImapCredentials, type SmtpImapCredentials } from "./credentials.js";

interface ImapMessageRef {
  mailbox: string;
  uid: number;
  /** Mailbox UIDVALIDITY (RFC 3501 2.3.1.1) at fetch time — a mismatch on lookup means the
   * mailbox was recreated and this UID no longer refers to the same message. */
  uidValidity: string;
}

function encodeMessageRef(ref: ImapMessageRef): string {
  return JSON.stringify(ref);
}

function decodeMessageRef(raw: string): ImapMessageRef {
  return JSON.parse(raw) as ImapMessageRef;
}

/** IMAP's sync cursor (Section 11.2, SMTP/IMAP variant): the highest UID seen in INBOX, scoped
 * to the UIDVALIDITY epoch it was observed under (RFC 3501 — UIDs are only guaranteed
 * monotonically non-decreasing within one UIDVALIDITY; a changed UIDVALIDITY invalidates any
 * previously stored UID). */
interface ImapSyncCursorPayload {
  uidValidity: string;
  lastUid: number;
}

function formatEmailAddress(addr: { address?: string; name: string }): string {
  if (!addr.address) return addr.name;
  if (!addr.name) return addr.address;
  const escaped = addr.name.replace(/"/g, '\\"');
  return `"${escaped}" <${addr.address}>`;
}

function flattenAddresses(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap((o) => o.value.map(formatEmailAddress));
}

const INITIAL_BACKFILL_COUNT = 25;
const SENT_MAILBOX_NAME_FALLBACKS = ["Sent", "Sent Items", "Sent Mail", "INBOX.Sent", "INBOX/Sent"];

/**
 * SMTP/IMAP adapter (Section 12.3): the universal-fallback MailProvider for any mailbox that
 * isn't Gmail or Microsoft 365/Outlook.com. Unlike those two, there is no shared app-wide OAuth
 * client here — host/port/username/password *is* the account's secret material, stored whole in
 * the TokenVault (see credentials.ts). Every method opens its own short-lived SMTP/IMAP
 * connection and closes it before returning, mirroring the "fresh client per call" granularity
 * GmailProvider/MicrosoftProvider already use.
 */
export class SmtpImapProvider implements MailProvider {
  private readonly pendingDrafts = new Map<string, string>();

  constructor(private readonly tokenVault: TokenVault) {}

  private async credentialsFor(account: AccountRef): Promise<SmtpImapCredentials> {
    const payload = await this.tokenVault.retrieve(account.accountId);
    if (!payload) {
      throw new Error(`No stored SMTP/IMAP credentials for account ${account.accountId} — reconnect required`);
    }
    return deserializeSmtpImapCredentials(payload);
  }

  private async connectImap(credentials: SmtpImapCredentials): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: credentials.imapHost,
      port: credentials.imapPort,
      secure: credentials.imapSecure,
      auth: { user: credentials.username, pass: credentials.password }
    });
    await client.connect();
    return client;
  }

  private transporterFor(credentials: SmtpImapCredentials) {
    return createTransport({
      host: credentials.smtpHost,
      port: credentials.smtpPort,
      secure: credentials.smtpSecure,
      auth: { user: credentials.username, pass: credentials.password }
    });
  }

  async authenticate(account: AccountRef): Promise<void> {
    const credentials = await this.credentialsFor(account);
    const client = await this.connectImap(credentials);
    await client.logout();
  }

  private async sendRaw(account: AccountRef, raw: string): Promise<ProviderSendResult> {
    const credentials = await this.credentialsFor(account);
    const transporter = this.transporterFor(credentials);
    try {
      const info = await transporter.sendMail({ raw });
      // SMTP has no server-assigned message id the way Gmail/Graph do, and no server in the
      // middle to rewrite it either -- nodemailer reports back the same Message-ID header value
      // it actually sent (the one this app's MIME builder generated), so unlike Gmail/Graph this
      // is already the confirmed, delivered value.
      return { providerMessageId: info.messageId, messageIdHeader: info.messageId };
    } finally {
      transporter.close();
    }
  }

  async sendMessage(account: AccountRef, message: BuiltMimeMessage): Promise<ProviderSendResult> {
    return this.sendRaw(account, message.raw);
  }

  async createDraft(_account: AccountRef, message: BuiltMimeMessage): Promise<ProviderDraftRef> {
    // No server-side drafts over plain SMTP/IMAP (SMTP_IMAP_CAPABILITIES.supportsDrafts is
    // false) — this holds the built MIME content in memory only, for the same process's
    // subsequent sendDraft() call. It does not survive an app restart between the two steps.
    const draftId = generateId();
    this.pendingDrafts.set(draftId, message.raw);
    return { providerDraftId: draftId };
  }

  async sendDraft(account: AccountRef, draftRef: ProviderDraftRef): Promise<ProviderSendResult> {
    const raw = this.pendingDrafts.get(draftRef.providerDraftId);
    if (!raw) {
      throw new Error(
        "No pending SMTP/IMAP draft found in this session — this provider has no server-side drafts, " +
          "so sendDraft() only works when called in the same app session as the matching createDraft()"
      );
    }
    const result = await this.sendRaw(account, raw);
    this.pendingDrafts.delete(draftRef.providerDraftId);
    return result;
  }

  async listChangesSince(account: AccountRef, cursor: SyncCursor): Promise<ChangeSet> {
    const credentials = await this.credentialsFor(account);
    const client = await this.connectImap(credentials);
    try {
      const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
      const parsedCursor = cursor.cursor ? (JSON.parse(cursor.cursor) as ImapSyncCursorPayload) : undefined;
      const uidValidityChanged = parsedCursor !== undefined && parsedCursor.uidValidity !== mailbox.uidValidity.toString();
      const isFreshBackfill = !parsedCursor || uidValidityChanged;

      const searchRange = isFreshBackfill ? "1:*" : `${parsedCursor.lastUid + 1}:*`;
      const found = await client.search({ uid: searchRange }, { uid: true });
      const uids = found === false ? [] : found;
      const limitedUids = isFreshBackfill ? uids.slice(-INITIAL_BACKFILL_COUNT) : uids;

      const refs = limitedUids.map((uid) =>
        encodeMessageRef({ mailbox: "INBOX", uid, uidValidity: mailbox.uidValidity.toString() })
      );

      const previousLastUid = isFreshBackfill ? 0 : parsedCursor.lastUid;
      const highestSeenUid = uids.length > 0 ? Math.max(...uids) : previousLastUid;
      const newCursor: ImapSyncCursorPayload = {
        uidValidity: mailbox.uidValidity.toString(),
        lastUid: Math.max(previousLastUid, highestSeenUid, mailbox.uidNext - 1)
      };

      return { cursor: JSON.stringify(newCursor), newOrChangedMessageRefs: refs };
    } finally {
      await client.logout();
    }
  }

  async fetchMessage(account: AccountRef, providerMessageId: string): Promise<NormalizedMessage> {
    const ref = decodeMessageRef(providerMessageId);
    const credentials = await this.credentialsFor(account);
    const client = await this.connectImap(credentials);
    try {
      const mailbox = await client.mailboxOpen(ref.mailbox, { readOnly: true });
      if (mailbox.uidValidity.toString() !== ref.uidValidity) {
        throw new Error(
          `Mailbox "${ref.mailbox}" UIDVALIDITY changed since this message reference was issued — the mailbox was recreated and this UID no longer refers to the same message`
        );
      }

      const fetched = await client.fetchOne(ref.uid, { source: true }, { uid: true });
      if (!fetched || !fetched.source) {
        throw new Error(`IMAP server did not return message content for UID ${ref.uid} in "${ref.mailbox}"`);
      }

      const parsed = await simpleParser(fetched.source);
      const references = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references;
      const to = flattenAddresses(parsed.to);
      const cc = flattenAddresses(parsed.cc);
      const from = flattenAddresses(parsed.from);

      return {
        providerMessageId,
        providerThreadId: undefined,
        messageIdHeader: parsed.messageId ?? "",
        inReplyToHeader: parsed.inReplyTo,
        referencesHeader: references,
        from: from[0] ?? "",
        to,
        cc: cc.length > 0 ? cc : undefined,
        subject: parsed.subject ?? "",
        date: parsed.date ?? new Date(),
        bodyHtml: typeof parsed.html === "string" ? parsed.html : undefined,
        bodyText: parsed.text,
        // No provider-supplied preview over IMAP (unlike Gmail's snippet/Graph's bodyPreview) —
        // derived locally from the parsed plaintext body as a best-effort substitute.
        snippet: parsed.text ? parsed.text.slice(0, 200) : undefined
      };
    } finally {
      await client.logout();
    }
  }

  async fetchThread(_account: AccountRef, threadRef: string): Promise<NormalizedThread> {
    // No native thread expansion over plain IMAP without non-universal extensions this adapter
    // doesn't use (SMTP_IMAP_CAPABILITIES.supportsNativeThreads is false) — the Conversation
    // Engine's own Message-ID/References header graph (Section 11) is this account's real
    // threading mechanism, so this degenerates to a single-message "thread."
    return { providerThreadId: threadRef, messageRefs: [threadRef] };
  }

  private async findSentMailboxPath(client: ImapFlow): Promise<string | undefined> {
    const mailboxes = await client.list();
    const bySpecialUse = mailboxes.find((m) => m.specialUse === "\\Sent");
    if (bySpecialUse) return bySpecialUse.path;
    const byName = mailboxes.find((m) => SENT_MAILBOX_NAME_FALLBACKS.includes(m.name));
    return byName?.path;
  }

  async appendToSentFolder(account: AccountRef, rawMessage: Buffer): Promise<void> {
    // Unlike Gmail/Graph (which auto-file sent mail server-side), plain SMTP has no concept of a
    // Sent folder at all — sending and storage are separate protocols. This is a best-effort
    // append: if no Sent mailbox can be found, it silently does nothing rather than failing the
    // send that already succeeded.
    const credentials = await this.credentialsFor(account);
    const client = await this.connectImap(credentials);
    try {
      const sentPath = await this.findSentMailboxPath(client);
      if (!sentPath) return;
      await client.append(sentPath, rawMessage);
    } finally {
      await client.logout();
    }
  }

  capabilities(): ProviderCapabilities {
    return SMTP_IMAP_CAPABILITIES;
  }
}
