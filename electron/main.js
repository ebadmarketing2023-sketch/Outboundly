import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";

import { openDatabase } from "../dist/adapters/persistence/db.js";
import { getOrCreateDatabaseEncryptionKey } from "../dist/adapters/persistence/database-key.js";
import { accounts as accountsTable } from "../dist/adapters/persistence/schema.js";
import { SqliteDraftRepository } from "../dist/adapters/persistence/repositories/draft-repository.js";
import { SqliteConversationRepository } from "../dist/adapters/persistence/repositories/conversation-repository.js";
import { InboxViewRepository } from "../dist/adapters/persistence/repositories/inbox-view-repository.js";
import { SqliteDeliverabilityReportRepository } from "../dist/adapters/persistence/repositories/deliverability-report-repository.js";
import { DraftLifecycleService } from "../dist/core/drafts/draft-lifecycle.js";
import { SystemClock } from "../dist/ports/clock.port.js";
import { parsePlainTextToDocument } from "../dist/core/rendering/plain-text-parser.js";
import { GmailProvider, serializeStoredTokens } from "../dist/adapters/providers/google/gmail-provider.js";
import { runGoogleOAuthFlow } from "../dist/adapters/providers/google/oauth-flow.js";
import { MicrosoftProvider } from "../dist/adapters/providers/microsoft/microsoft-provider.js";
import { runMicrosoftOAuthFlow } from "../dist/adapters/providers/microsoft/oauth-flow.js";
import { SmtpImapProvider } from "../dist/adapters/providers/smtp-imap/smtp-imap-provider.js";
import { serializeSmtpImapCredentials } from "../dist/adapters/providers/smtp-imap/credentials.js";
import { NativeKeychainTokenVault } from "../dist/adapters/credential-vault/native-keychain-token-vault.js";
import { sendDraftMessage } from "../dist/application/send-message/send-message.js";
import { syncInboxForAccount } from "../dist/application/sync-inbox/sync-inbox.js";
import { EmailAddress } from "../dist/core/shared-kernel/email-address.js";
import { generateId } from "../dist/core/shared-kernel/ids.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Section 13: the app owns one registered OAuth application; the user never configures this.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
  // Needed for Google's userinfo endpoint to return the account's profile `name` field at all —
  // without this, "name" is silently absent from the response no matter how the app asks for it.
  "https://www.googleapis.com/auth/userinfo.profile",
  // Phase 2: reading the inbox (Conversation Engine sync) needs read access, which
  // gmail.send/gmail.compose do not grant. This is Google's "Restricted" scope tier (Section
  // 13.5 of the architecture doc) — fine for local dev/testing with your own test-user account,
  // but a real consideration if this app is ever published publicly (it would require Google's
  // CASA security assessment, unlike the Sensitive-tier scopes above).
  "https://www.googleapis.com/auth/gmail.readonly"
];

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
// openid/profile/offline_access are appended automatically by MSAL to every auth/token request
// (verified against @azure/msal-common's ScopeSet construction, which always adds
// OIDC_DEFAULT_SCOPES) — only the Graph-specific mail scopes need to be listed here.
const MICROSOFT_SCOPES = ["Mail.Send", "Mail.ReadWrite"];

let db;
let draftRepository;
let draftLifecycle;
let tokenVault;
let gmailProvider;
let microsoftProvider;
let smtpImapProvider;
let conversationRepository;
let inboxViewRepository;
let deliverabilityReportRepository;

function initServices() {
  const dbPath = join(app.getPath("userData"), "outboundly.sqlite");
  db = openDatabase(dbPath, getOrCreateDatabaseEncryptionKey());
  draftRepository = new SqliteDraftRepository(db);
  draftLifecycle = new DraftLifecycleService(draftRepository, new SystemClock());
  tokenVault = new NativeKeychainTokenVault();
  gmailProvider = new GmailProvider(
    { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, scopes: GOOGLE_SCOPES },
    tokenVault
  );
  microsoftProvider = new MicrosoftProvider({ clientId: MICROSOFT_CLIENT_ID, scopes: MICROSOFT_SCOPES }, tokenVault);
  smtpImapProvider = new SmtpImapProvider(tokenVault);
  conversationRepository = new SqliteConversationRepository(db);
  inboxViewRepository = new InboxViewRepository(db);
  deliverabilityReportRepository = new SqliteDeliverabilityReportRepository(db);
}

/** Picks the MailProvider matching an account row's `provider` column (Section 12.1). */
function providerFor(account) {
  if (account.provider === "microsoft") return microsoftProvider;
  if (account.provider === "smtp_imap") return smtpImapProvider;
  return gmailProvider;
}

function serializeAccount(row) {
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    displayName: row.displayName ?? undefined,
    status: row.status
  };
}

function serializeDraft(draft) {
  return {
    id: draft.id,
    accountId: draft.accountId,
    subject: draft.subject,
    to: draft.to.map((a) => a.address.toString()),
    autosaveVersion: draft.autosaveVersion,
    lastSavedAt: draft.lastSavedAt.toISOString()
  };
}

function serializeThread(thread) {
  return {
    id: thread.id,
    subjectNormalized: thread.subjectNormalized,
    conversationState: thread.conversationState,
    archivedAt: thread.archivedAt ? thread.archivedAt.toISOString() : undefined,
    updatedAt: thread.updatedAt.toISOString()
  };
}

function serializeMessage(message) {
  return {
    id: message.id,
    direction: message.direction,
    fromAddress: message.fromAddress,
    toAddresses: message.toAddresses,
    subject: message.subject,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    snippet: message.snippet,
    starred: message.starred,
    sentAt: message.sentAt ? message.sentAt.toISOString() : undefined,
    receivedAt: message.receivedAt ? message.receivedAt.toISOString() : undefined
  };
}

function registerIpcHandlers() {
  ipcMain.handle("accounts:list", async () => {
    return db.select().from(accountsTable).all().map(serializeAccount);
  });

  ipcMain.handle("accounts:connectGoogle", async () => {
    if (!GOOGLE_CLIENT_ID) {
      throw new Error(
        "GOOGLE_CLIENT_ID is not configured. See docs/google-oauth-setup.md for how to create one."
      );
    }

    const result = await runGoogleOAuthFlow(
      { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, scopes: GOOGLE_SCOPES },
      (url) => {
        void shell.openExternal(url);
      }
    );

    const now = new Date();

    // Reconnecting the same Google account updates its existing row (display name, refreshed
    // tokens) instead of creating a duplicate entry — Section 13.3's "easy reconnect" behavior.
    const existing = db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.emailAddress, result.emailAddress))
      .get();

    const accountId = existing?.id ?? generateId();

    if (existing) {
      db.update(accountsTable)
        .set({ displayName: result.displayName, status: "connected", updatedAt: now })
        .where(eq(accountsTable.id, accountId))
        .run();
    } else {
      db.insert(accountsTable)
        .values({
          id: accountId,
          provider: "google",
          emailAddress: result.emailAddress,
          displayName: result.displayName,
          status: "connected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        })
        .run();
    }

    await tokenVault.store(accountId, serializeStoredTokens(result.tokens));
    return serializeAccount({
      id: accountId,
      provider: "google",
      emailAddress: result.emailAddress,
      displayName: result.displayName,
      status: "connected"
    });
  });

  ipcMain.handle("accounts:connectMicrosoft", async () => {
    if (!MICROSOFT_CLIENT_ID) {
      throw new Error(
        "MICROSOFT_CLIENT_ID is not configured. See docs/microsoft-oauth-setup.md for how to create one."
      );
    }

    const result = await runMicrosoftOAuthFlow({ clientId: MICROSOFT_CLIENT_ID, scopes: MICROSOFT_SCOPES }, (url) => {
      void shell.openExternal(url);
    });

    const now = new Date();

    // Reconnecting the same Microsoft account updates its existing row (display name, refreshed
    // token cache) instead of creating a duplicate entry, mirroring the Google flow above.
    const existing = db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.emailAddress, result.emailAddress))
      .get();

    const accountId = existing?.id ?? generateId();

    if (existing) {
      db.update(accountsTable)
        .set({ displayName: result.displayName, status: "connected", updatedAt: now })
        .where(eq(accountsTable.id, accountId))
        .run();
    } else {
      db.insert(accountsTable)
        .values({
          id: accountId,
          provider: "microsoft",
          emailAddress: result.emailAddress,
          displayName: result.displayName,
          status: "connected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        })
        .run();
    }

    await tokenVault.store(accountId, result.serializedCache);
    return serializeAccount({
      id: accountId,
      provider: "microsoft",
      emailAddress: result.emailAddress,
      displayName: result.displayName,
      status: "connected"
    });
  });

  ipcMain.handle("accounts:connectSmtpImap", async (_event, request) => {
    const credentials = {
      smtpHost: request.smtpHost,
      smtpPort: request.smtpPort,
      smtpSecure: request.smtpSecure,
      imapHost: request.imapHost,
      imapPort: request.imapPort,
      imapSecure: request.imapSecure,
      username: request.username,
      password: request.password
    };

    const now = new Date();
    const existing = db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.emailAddress, request.emailAddress))
      .get();
    const accountId = existing?.id ?? generateId();

    // Store first so authenticate() below exercises the exact same TokenVault-backed path a
    // later send/sync would use; if the real IMAP login fails, roll the stored credentials back
    // and never touch the accounts table, so a bad password never creates a "connected" account.
    await tokenVault.store(accountId, serializeSmtpImapCredentials(credentials));
    try {
      await smtpImapProvider.authenticate({ accountId, emailAddress: request.emailAddress });
    } catch (err) {
      if (!existing) await tokenVault.delete(accountId);
      throw err;
    }

    if (existing) {
      db.update(accountsTable)
        .set({ displayName: request.displayName, status: "connected", updatedAt: now })
        .where(eq(accountsTable.id, accountId))
        .run();
    } else {
      db.insert(accountsTable)
        .values({
          id: accountId,
          provider: "smtp_imap",
          emailAddress: request.emailAddress,
          displayName: request.displayName,
          status: "connected",
          connectedAt: now,
          createdAt: now,
          updatedAt: now
        })
        .run();
    }

    return serializeAccount({
      id: accountId,
      provider: "smtp_imap",
      emailAddress: request.emailAddress,
      displayName: request.displayName,
      status: "connected"
    });
  });

  ipcMain.handle("drafts:create", async (_event, request) => {
    const draft = await draftLifecycle.createDraft({
      accountId: request.accountId,
      subject: request.subject,
      document: parsePlainTextToDocument(request.body),
      to: request.to.map((addr) => ({ address: EmailAddress.parse(addr) }))
    });
    return serializeDraft(draft);
  });

  ipcMain.handle("drafts:autosave", async (_event, request) => {
    const patch = {};
    if (request.subject !== undefined) patch.subject = request.subject;
    if (request.body !== undefined) patch.document = parsePlainTextToDocument(request.body);
    const draft = await draftLifecycle.autosave(request.draftId, patch);
    return serializeDraft(draft);
  });

  ipcMain.handle("drafts:send", async (_event, request) => {
    const draft = await draftRepository.findById(request.draftId);
    if (!draft) throw new Error("Draft not found");

    const account = db.select().from(accountsTable).where(eq(accountsTable.id, draft.accountId)).get();
    if (!account) throw new Error("Account not found");

    const sendingDomain = account.emailAddress.split("@")[1];
    const accountRef = { accountId: account.id, emailAddress: account.emailAddress };

    return sendDraftMessage({
      draft,
      from: { address: EmailAddress.parse(account.emailAddress), displayName: account.displayName ?? undefined },
      sendingDomain,
      draftLifecycle,
      provider: providerFor(account),
      accountRef,
      conversationRepo: conversationRepository,
      deliverabilityReportRepo: deliverabilityReportRepository
    });
  });

  ipcMain.handle("inbox:sync", async (_event, request) => {
    const account = db.select().from(accountsTable).where(eq(accountsTable.id, request.accountId)).get();
    if (!account) throw new Error("Account not found");

    const accountRef = { accountId: account.id, emailAddress: account.emailAddress };
    const result = await syncInboxForAccount({
      accountId: account.id,
      accountRef,
      provider: providerFor(account),
      repo: conversationRepository
    });

    if (result.failedRefs.length > 0) {
      // Full details go to the terminal for debugging; the IPC response only exposes a count
      // (Section 23: don't push raw internal error text into the renderer unnecessarily).
      console.error("inbox:sync — some messages failed to sync:", result.failedRefs);
    }

    return {
      newMessageCount: result.newMessageCount,
      repliesDetected: result.repliesDetected,
      failedCount: result.failedRefs.length
    };
  });

  ipcMain.handle("inbox:listThreads", async (_event, request) => {
    const threadRows = await inboxViewRepository.listThreads(request.accountId, {
      includeArchived: request.includeArchived
    });
    return threadRows.map(serializeThread);
  });

  ipcMain.handle("inbox:getThreadMessages", async (_event, request) => {
    const messageRows = await inboxViewRepository.getThreadMessages(request.threadId);
    return messageRows.map(serializeMessage);
  });

  ipcMain.handle("inbox:setThreadArchived", async (_event, request) => {
    await inboxViewRepository.setThreadArchived(request.threadId, request.archived);
  });

  ipcMain.handle("inbox:setMessageStarred", async (_event, request) => {
    await inboxViewRepository.setMessageStarred(request.messageId, request.starred);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  void win.loadFile(join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  initServices();
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
