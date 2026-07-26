import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";

import { openDatabase } from "../dist/adapters/persistence/db.js";
import { accounts as accountsTable } from "../dist/adapters/persistence/schema.js";
import { SqliteDraftRepository } from "../dist/adapters/persistence/repositories/draft-repository.js";
import { DraftLifecycleService } from "../dist/core/drafts/draft-lifecycle.js";
import { SystemClock } from "../dist/ports/clock.port.js";
import { paragraph, textRun } from "../dist/core/rendering/document-model.js";
import { GmailProvider } from "../dist/adapters/providers/google/gmail-provider.js";
import { runGoogleOAuthFlow } from "../dist/adapters/providers/google/oauth-flow.js";
import { NativeKeychainTokenVault } from "../dist/adapters/credential-vault/native-keychain-token-vault.js";
import { sendDraftMessage } from "../dist/application/send-message/send-message.js";
import { EmailAddress } from "../dist/core/shared-kernel/email-address.js";
import { generateId } from "../dist/core/shared-kernel/ids.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Section 13: the app owns one registered OAuth application; the user never configures this.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email"
];

let db;
let draftRepository;
let draftLifecycle;
let tokenVault;
let gmailProvider;

function initServices() {
  const dbPath = join(app.getPath("userData"), "outboundly.sqlite");
  db = openDatabase(dbPath);
  draftRepository = new SqliteDraftRepository(db);
  draftLifecycle = new DraftLifecycleService(draftRepository, new SystemClock());
  tokenVault = new NativeKeychainTokenVault();
  gmailProvider = new GmailProvider(
    { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, scopes: GOOGLE_SCOPES },
    tokenVault
  );
}

function documentFromPlainText(text) {
  const blocks = text.split(/\n{2,}/).map((block) => paragraph(textRun(block)));
  return { blocks: blocks.length > 0 ? blocks : [paragraph()] };
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

    await tokenVault.store(accountId, result.tokens);
    return serializeAccount({
      id: accountId,
      provider: "google",
      emailAddress: result.emailAddress,
      displayName: result.displayName,
      status: "connected"
    });
  });

  ipcMain.handle("drafts:create", async (_event, request) => {
    const draft = await draftLifecycle.createDraft({
      accountId: request.accountId,
      subject: request.subject,
      document: documentFromPlainText(request.body),
      to: request.to.map((addr) => ({ address: EmailAddress.parse(addr) }))
    });
    return serializeDraft(draft);
  });

  ipcMain.handle("drafts:autosave", async (_event, request) => {
    const patch = {};
    if (request.subject !== undefined) patch.subject = request.subject;
    if (request.body !== undefined) patch.document = documentFromPlainText(request.body);
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
      provider: gmailProvider,
      accountRef
    });
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
