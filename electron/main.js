import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import electronUpdaterPkg from "electron-updater";
// electron-updater ships as CommonJS with a getter-based `autoUpdater` export that Node's ESM
// interop can't statically pick up as a named import (verified for real: `import { autoUpdater }`
// throws "Named export 'autoUpdater' not found") -- the default-import-then-destructure form works.
const { autoUpdater } = electronUpdaterPkg;
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";

import { openDatabase } from "../dist/adapters/persistence/db.js";
import { getOrCreateDatabaseEncryptionKey } from "../dist/adapters/persistence/database-key.js";
import { accounts as accountsTable, contacts as contactsTable } from "../dist/adapters/persistence/schema.js";
import { SqliteDraftRepository } from "../dist/adapters/persistence/repositories/draft-repository.js";
import { SqliteConversationRepository } from "../dist/adapters/persistence/repositories/conversation-repository.js";
import { InboxViewRepository } from "../dist/adapters/persistence/repositories/inbox-view-repository.js";
import { SqliteDeliverabilityReportRepository } from "../dist/adapters/persistence/repositories/deliverability-report-repository.js";
import { SqliteLabReportRepository } from "../dist/adapters/persistence/repositories/lab-report-repository.js";
import { runLabAnalysis } from "../dist/application/deliverability-lab/run-lab-analysis.js";
import { SqliteAccountHealthMetricsSource } from "../dist/adapters/persistence/repositories/account-health-metrics-source.js";
import { SqliteAccountHealthRepository } from "../dist/adapters/persistence/repositories/account-health-repository.js";
import { DnsDomainAuthChecker } from "../dist/adapters/dns/dns-domain-auth-checker.js";
import { computeAccountHealthSnapshot } from "../dist/application/account-health/compute-account-health-snapshot.js";
import { runAccountHealthSweep } from "../dist/application/account-health/account-health-sweep.js";
import { SqliteAccountDirectory } from "../dist/adapters/persistence/repositories/account-directory.js";
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
import { handleBounceDetected, handleReplyDetected, unsubscribeContact } from "../dist/application/campaigns/stop-enrollments.js";
import { recordConversion } from "../dist/application/analytics/record-conversion.js";
import { labelReply } from "../dist/application/analytics/label-reply.js";
import { getCampaignAnalytics } from "../dist/adapters/persistence/campaign-analytics-support.js";
import { getCampaignDashboard } from "../dist/adapters/persistence/campaign-dashboard-support.js";
import { getAppPreferences, setAccountSignature, setAppPreferences } from "../dist/adapters/persistence/settings-support.js";
import { exportEncryptedBackup, restoreEncryptedBackup } from "../dist/adapters/persistence/backup-restore.js";
import { EmailAddress } from "../dist/core/shared-kernel/email-address.js";
import { generateId } from "../dist/core/shared-kernel/ids.js";
import { SqliteContactRepository } from "../dist/adapters/persistence/repositories/contact-repository.js";
import { SqliteSuppressionListRepository } from "../dist/adapters/persistence/repositories/suppression-list-repository.js";
import { SqliteEnrollmentRepository } from "../dist/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteCampaignRepository } from "../dist/adapters/persistence/repositories/campaign-repository.js";
import { SqliteSequenceRepository } from "../dist/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../dist/adapters/persistence/repositories/template-repository.js";
import { SqliteTemplateVariantRepository } from "../dist/adapters/persistence/repositories/template-variant-repository.js";
import { SqliteSubjectVariantRepository } from "../dist/adapters/persistence/repositories/subject-variant-repository.js";
import { SqliteBusinessHoursProfileRepository } from "../dist/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteWarmupProfileRepository } from "../dist/adapters/persistence/repositories/warmup-profile-repository.js";
import { SqliteDelayPolicyConfigRepository } from "../dist/adapters/persistence/repositories/delay-policy-config-repository.js";
import { SqliteSendQueueRepository } from "../dist/adapters/persistence/repositories/send-queue-repository.js";
import { SqliteRateLimiter } from "../dist/adapters/persistence/rate-limiter.js";
import { SqliteEventRepository } from "../dist/adapters/persistence/repositories/event-repository.js";
import { SqliteNotificationRepository } from "../dist/adapters/persistence/repositories/notification-repository.js";
import { SqliteErrorLogRepository } from "../dist/adapters/persistence/repositories/error-log-repository.js";
import { SqliteCampaignMetricsRollupRepository } from "../dist/adapters/persistence/repositories/campaign-metrics-rollup-repository.js";
import { SqliteAccountMetricsRollupRepository } from "../dist/adapters/persistence/repositories/account-metrics-rollup-repository.js";
import { computeRollups } from "../dist/adapters/persistence/compute-rollups.js";
import { SqliteInsightRepository } from "../dist/adapters/persistence/repositories/insight-repository.js";
import { computeInsights } from "../dist/adapters/persistence/compute-insights.js";
import { SqliteProviderSelector } from "../dist/adapters/persistence/provider-selector.js";
import { runSchedulerTick } from "../dist/application/campaigns/scheduler-tick.js";
import { runSendWorkerTick } from "../dist/application/campaigns/send-worker-tick.js";
import { importContactsCsv } from "../dist/application/leads/import-contacts-csv.js";
import { deleteContact } from "../dist/application/leads/delete-contact.js";
import { deleteLeadImportBatch } from "../dist/application/leads/delete-lead-import-batch.js";
import { SqliteLeadImportBatchRepository } from "../dist/adapters/persistence/repositories/lead-import-batch-repository.js";

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
let dbPath;
let mainWindow;
// Section 21.3/Critical Improvement #8's "one active worker" principle applied to inbox sync too:
// an account currently syncing (whether the periodic worker or a manual "Sync now" click started
// it) is tracked here so a second concurrent sync attempt for the same account is skipped rather
// than racing the same sync cursor.
const accountsCurrentlySyncing = new Set();
let draftRepository;
let draftLifecycle;
let tokenVault;
let gmailProvider;
let microsoftProvider;
let smtpImapProvider;
let conversationRepository;
let inboxViewRepository;
let deliverabilityReportRepository;
let accountHealthMetricsSource;
let accountHealthRepository;
let accountDirectory;
let domainAuthChecker;
let labReportRepository;
let contactRepository;
let leadImportBatchRepository;
let suppressionListRepository;
let enrollmentRepository;
let campaignRepository;
let sequenceRepository;
let templateRepository;
let templateVariantRepository;
let subjectVariantRepository;
let businessHoursProfileRepository;
let warmupProfileRepository;
let delayPolicyConfigRepository;
let sendQueueRepository;
let rateLimiter;
let providerSelector;
let eventRepository;
let notificationRepository;
let errorLogRepository;
let campaignMetricsRollupRepository;
let accountMetricsRollupRepository;
let insightRepository;
let schedulerTickTimer;
let sendWorkerTickTimer;
let rollupTickTimer;
let accountHealthSweepTimer;
let inboxSyncTickTimer;

const SCHEDULER_TICK_INTERVAL_MS = 60_000;
const SEND_WORKER_TICK_INTERVAL_MS = 30_000;
// Was 1 hour -- far too coarse for a dashboard someone is actively watching during/after a test
// send; every metric on the Campaign dashboard that isn't computed live (reply rate, emails sent)
// is only ever as fresh as this tick.
const ROLLUP_TICK_INTERVAL_MS = 5 * 60 * 1000;
const ACCOUNT_HEALTH_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const INBOX_SYNC_TICK_INTERVAL_MS = 5 * 60 * 1000;

function initServices() {
  dbPath = join(app.getPath("userData"), "outboundly.sqlite");
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
  accountHealthMetricsSource = new SqliteAccountHealthMetricsSource(db);
  accountHealthRepository = new SqliteAccountHealthRepository(db);
  accountDirectory = new SqliteAccountDirectory(db);
  domainAuthChecker = new DnsDomainAuthChecker();
  labReportRepository = new SqliteLabReportRepository(db);
  contactRepository = new SqliteContactRepository(db);
  leadImportBatchRepository = new SqliteLeadImportBatchRepository(db);
  suppressionListRepository = new SqliteSuppressionListRepository(db);
  enrollmentRepository = new SqliteEnrollmentRepository(db);
  campaignRepository = new SqliteCampaignRepository(db);
  sequenceRepository = new SqliteSequenceRepository(db);
  templateRepository = new SqliteTemplateRepository(db);
  templateVariantRepository = new SqliteTemplateVariantRepository(db);
  subjectVariantRepository = new SqliteSubjectVariantRepository(db);
  businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
  warmupProfileRepository = new SqliteWarmupProfileRepository(db);
  delayPolicyConfigRepository = new SqliteDelayPolicyConfigRepository(db);
  sendQueueRepository = new SqliteSendQueueRepository(db);
  rateLimiter = new SqliteRateLimiter(db);
  providerSelector = new SqliteProviderSelector(db, accountHealthRepository, rateLimiter);
  eventRepository = new SqliteEventRepository(db);
  notificationRepository = new SqliteNotificationRepository(db);
  errorLogRepository = new SqliteErrorLogRepository(db);
  campaignMetricsRollupRepository = new SqliteCampaignMetricsRollupRepository(db);
  accountMetricsRollupRepository = new SqliteAccountMetricsRollupRepository(db);
  insightRepository = new SqliteInsightRepository(db);
}

/** Dependencies shared by both the Scheduler tick and fireEnrollmentStep's own callers (Section
 * 14.3, Section 21.1). */
function campaignEngineDeps() {
  return {
    db,
    businessHoursProfileRepository,
    warmupProfileRepository,
    delayPolicyConfigRepository,
    campaignRepository,
    sequenceRepository,
    templateRepository,
    templateVariantRepository,
    subjectVariantRepository,
    contactRepository,
    suppressionListRepository,
    enrollmentRepository,
    sendQueueRepository,
    deliverabilityReportRepository,
    conversationRepository,
    draftLifecycle,
    errorLogRepository
  };
}

/** Shared by the manual contact-picker enrollment handler and the campaign-specific CSV-upload
 * handler (Critical Improvement #2) so there's exactly one place that enforces "not already
 * actively enrolled" and "not suppressed" before creating an enrollment row. */
async function enrollContactIdsIntoCampaign(campaignId, contactIds) {
  const campaign = await campaignRepository.findById(campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const sequence = await sequenceRepository.findById(campaign.sequenceId);
  if (!sequence || sequence.steps.length === 0) throw new Error("Campaign's sequence has no steps");
  const firstStep = sequence.steps[0];

  let enrolled = 0;
  const skipped = [];
  for (const contactId of contactIds) {
    const contact = await contactRepository.findById(contactId);
    if (!contact) {
      skipped.push({ contactId, reason: "Contact not found" });
      continue;
    }
    if (await suppressionListRepository.isSuppressed(contact.email)) {
      skipped.push({ contactId, reason: "Contact is on the suppression list" });
      continue;
    }
    const existing = await enrollmentRepository.findActiveByCampaignAndContact(campaign.id, contactId);
    if (existing) {
      skipped.push({ contactId, reason: "Already actively enrolled in this campaign" });
      continue;
    }
    try {
      await enrollmentRepository.enroll({
        campaignId: campaign.id,
        contactId,
        currentStepId: firstStep.id,
        nextSendAt: new Date()
      });
      enrolled++;
    } catch (err) {
      // Database Integrity (Critical Improvement #13): campaign_enrollments has a real partial
      // unique index on (campaign_id, contact_id) WHERE status = 'active', so a genuine race
      // between two overlapping enroll requests for the same contact (the check above passing for
      // both before either insert lands) throws here instead of silently creating a duplicate
      // active enrollment. Treated the same as losing the check above -- skip this one contact,
      // not the rest of the batch.
      skipped.push({ contactId, reason: "Already actively enrolled in this campaign" });
    }
  }
  return { enrolled, skipped };
}

async function getProviderForAccount(accountId) {
  const account = db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).get();
  return providerFor(account);
}

/** Shared by the manual "Sync now" IPC handler and the periodic sync worker (Critical Improvement
 * #5/#11) so there's exactly one implementation of "sync this account" -- including the
 * concurrency guard, which prevents a periodic tick and a manual click (or two periodic ticks
 * overlapping a slow sync) from racing the same account's sync cursor. Callers are responsible for
 * checking accountsCurrentlySyncing first if they need to react to "already syncing" (the manual
 * handler does, to surface a clear error instead of a silent no-op); the periodic worker just skips
 * silently since there's no one to tell. */
async function syncAccountById(accountId, { reportProgress }) {
  accountsCurrentlySyncing.add(accountId);
  try {
    const account = db.select().from(accountsTable).where(eq(accountsTable.id, accountId)).get();
    if (!account) throw new Error("Account not found");

    const accountRef = { accountId: account.id, emailAddress: account.emailAddress };
    const stopEnrollmentDeps = {
      db,
      enrollmentRepository,
      campaignRepository,
      sequenceRepository,
      contactRepository,
      conversationRepository,
      eventRepository,
      notificationRepository
    };
    const result = await syncInboxForAccount({
      accountId: account.id,
      accountRef,
      provider: providerFor(account),
      repo: conversationRepository,
      onReplyDetected: (fromAddress, threadId) =>
        handleReplyDetected(stopEnrollmentDeps, fromAddress, { threadId, accountId: account.id }).then(() => undefined),
      onBounceDetected: (threadId) =>
        handleBounceDetected(stopEnrollmentDeps, threadId, account.id).then(() => undefined),
      errorLogRepository,
      onProgress: reportProgress ? (done, total) => sendToRenderer("inbox:syncProgress", { accountId, done, total }) : undefined
    });

    if (result.failedRefs.length > 0) {
      // Full details already went to errorLogRepository per-message above; this is just a
      // terminal breadcrumb for whoever's watching the process output live.
      console.error(`inbox:sync — ${result.failedRefs.length} message(s) failed to sync for account ${accountId}`);
    }

    return result;
  } finally {
    accountsCurrentlySyncing.delete(accountId);
  }
}

/** Recomputes the Analytics rollup tables, then the Insights Engine on top of them (Section 21.1's
 * "fixed interval, after rollups" chaining) -- shared by startBackgroundWorkers' immediate
 * run-once-at-startup call and its recurring interval, so there's exactly one implementation of
 * "run this tick" for both. */
function runRollupAndInsightsTick() {
  const now = new Date();
  computeRollups({ db, campaignRepository, eventRepository, campaignMetricsRollupRepository, accountMetricsRollupRepository }, now)
    .then(() =>
      computeInsights(
        { db, campaignRepository, campaignMetricsRollupRepository, accountMetricsRollupRepository, insightRepository },
        now
      )
    )
    .catch((err) => {
      console.error("[rollup-tick] failed:", err);
    });
}

/** Background workers (Section 21.1): fixed-interval Scheduler tick, Send worker, and the
 * Analytics rollup + Insights worker pair (the latter chained onto the former's tick, since
 * insights are meant to run "after rollups"), coordinated purely through the database (Section
 * 21.2) -- each tick's own failure isolation (Section 21.3) means a bad interval run is logged and
 * skipped, never left to crash the process or the timer. */
function startBackgroundWorkers() {
  schedulerTickTimer = setInterval(() => {
    runSchedulerTick(campaignEngineDeps(), new Date()).catch((err) => {
      console.error("[scheduler-tick] failed:", err);
    });
  }, SCHEDULER_TICK_INTERVAL_MS);

  sendWorkerTickTimer = setInterval(() => {
    runSendWorkerTick(
      {
        db,
        sendQueueRepository,
        rateLimiter,
        providerSelector,
        conversationRepository,
        enrollmentRepository,
        campaignRepository,
        sequenceRepository,
        contactRepository,
        draftRepository,
        draftLifecycle,
        eventRepository,
        notificationRepository,
        errorLogRepository,
        getProviderForAccount
      },
      new Date()
    ).catch((err) => {
      console.error("[send-worker-tick] failed:", err);
    });
  }, SEND_WORKER_TICK_INTERVAL_MS);

  // setInterval alone never fires until the first full interval has elapsed -- with the old
  // one-hour period, a freshly started app (or any session shorter than an hour, which is most
  // real usage) would show a stale/zeroed reply rate and emails-sent count on the Campaign
  // dashboard the whole time, since those numbers are deliberately read only from these rollup
  // tables (Section 20.1), never computed live from the events log. Running once immediately at
  // startup, on top of the recurring interval below, is what actually keeps the dashboard truthful
  // during ordinary use instead of only after an hour has passed.
  runRollupAndInsightsTick();
  rollupTickTimer = setInterval(runRollupAndInsightsTick, ROLLUP_TICK_INTERVAL_MS);

  // Account Health sweep (Section 17.3's "Periodic (background)" mode): re-runs the same live
  // auth check the manual "Recompute" button triggers, for every non-disconnected account, so a
  // revoked/expired token is caught and reflected in accounts.status without waiting for a send or
  // sync to fail first.
  accountHealthSweepTimer = setInterval(() => {
    runAccountHealthSweep(
      {
        accountDirectory,
        getProviderForAccount: (account) => providerFor(account),
        metricsSource: accountHealthMetricsSource,
        authChecker: domainAuthChecker,
        repository: accountHealthRepository,
        notificationRepository,
        errorLogRepository
      },
      new Date()
    ).catch((err) => {
      console.error("[account-health-sweep] failed:", err);
    });
  }, ACCOUNT_HEALTH_SWEEP_INTERVAL_MS);

  // Periodic inbox sync (Critical Improvement #5/#11): the manual "Sync now" button was, until
  // now, the only way an inbox ever got synced. Every connected account is synced on a fixed
  // interval too, so replies/bounces/campaign stop-conditions are picked up automatically. Skips
  // an account already mid-sync (accountsCurrentlySyncing) rather than piling up overlapping
  // requests against the same provider, and isolates one account's failure from the rest (Section
  // 21.3) exactly like every other tick worker.
  inboxSyncTickTimer = setInterval(() => {
    const connectedAccounts = db.select().from(accountsTable).where(eq(accountsTable.status, "connected")).all();
    for (const account of connectedAccounts) {
      if (accountsCurrentlySyncing.has(account.id)) continue;
      syncAccountById(account.id, { reportProgress: false }).catch((err) => {
        console.error(`[inbox-sync-tick] failed for account ${account.id}:`, err);
      });
    }
  }, INBOX_SYNC_TICK_INTERVAL_MS);
}

function stopBackgroundWorkers() {
  clearInterval(schedulerTickTimer);
  clearInterval(sendWorkerTickTimer);
  clearInterval(rollupTickTimer);
  clearInterval(accountHealthSweepTimer);
  clearInterval(inboxSyncTickTimer);
}

/** Picks the MailProvider matching an account row's `provider` column (Section 12.1). */
function providerFor(account) {
  if (account.provider === "microsoft") return microsoftProvider;
  if (account.provider === "smtp_imap") return smtpImapProvider;
  return gmailProvider;
}

function serializeCampaign(campaign) {
  return {
    id: campaign.id,
    name: campaign.name,
    sequenceId: campaign.sequenceId,
    status: campaign.status,
    businessHoursProfileId: campaign.businessHoursProfileId
  };
}

function serializeAccount(row) {
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    displayName: row.displayName ?? undefined,
    status: row.status,
    dailySendLimit: row.dailySendLimit ?? undefined,
    hourlySendLimit: row.hourlySendLimit ?? undefined,
    minSendDelaySeconds: row.minSendDelaySeconds ?? undefined,
    maxSendDelaySeconds: row.maxSendDelaySeconds ?? undefined,
    signatureText: row.signatureText ?? undefined
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

function serializeAccountHealthSnapshot(record) {
  return {
    capturedAt: record.capturedAt.toISOString(),
    healthScore: record.result.healthScore,
    riskLevel: record.result.riskLevel,
    sendsLast24h: record.input.metrics.sendsLast24h,
    sendsLast7d: record.input.metrics.sendsLast7d,
    accountAgeDays: record.input.metrics.accountAgeDays,
    replyRate: record.input.metrics.replyRate,
    sendingConsistencyScore: record.input.metrics.sendingConsistencyScore,
    spfStatus: record.input.authStatus.spf,
    dkimStatus: record.input.authStatus.dkim,
    dmarcStatus: record.input.authStatus.dmarc,
    findings: record.result.findings.map((f) => ({
      findingType: f.findingType,
      severity: f.severity,
      message: f.message,
      explanation: f.explanation,
      recommendedAction: f.recommendedAction
    }))
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
      const defaults = getAppPreferences(db);
      db.insert(accountsTable)
        .values({
          id: accountId,
          provider: "google",
          emailAddress: result.emailAddress,
          displayName: result.displayName,
          status: "connected",
          minSendDelaySeconds: defaults.defaultMinSendDelaySeconds,
          maxSendDelaySeconds: defaults.defaultMaxSendDelaySeconds,
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
      const defaults = getAppPreferences(db);
      db.insert(accountsTable)
        .values({
          id: accountId,
          provider: "microsoft",
          emailAddress: result.emailAddress,
          displayName: result.displayName,
          status: "connected",
          minSendDelaySeconds: defaults.defaultMinSendDelaySeconds,
          maxSendDelaySeconds: defaults.defaultMaxSendDelaySeconds,
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
      const defaults = getAppPreferences(db);
      db.insert(accountsTable)
        .values({
          id: accountId,
          provider: "smtp_imap",
          emailAddress: request.emailAddress,
          displayName: request.displayName,
          status: "connected",
          minSendDelaySeconds: defaults.defaultMinSendDelaySeconds,
          maxSendDelaySeconds: defaults.defaultMaxSendDelaySeconds,
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
    if (accountsCurrentlySyncing.has(request.accountId)) {
      throw new Error("This account is already syncing -- please wait for it to finish.");
    }
    const result = await syncAccountById(request.accountId, { reportProgress: true });
    return {
      newMessageCount: result.newMessageCount,
      repliesDetected: result.repliesDetected,
      bouncesDetected: result.bouncesDetected,
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

  ipcMain.handle("accountHealth:computeSnapshot", async (_event, request) => {
    const account = db.select().from(accountsTable).where(eq(accountsTable.id, request.accountId)).get();
    if (!account) throw new Error("Account not found");

    await computeAccountHealthSnapshot({
      accountRef: { accountId: account.id, emailAddress: account.emailAddress },
      provider: providerFor(account),
      metricsSource: accountHealthMetricsSource,
      authChecker: domainAuthChecker,
      repository: accountHealthRepository,
      notificationRepository,
      providerName: account.provider,
      accountDirectory
    });

    const record = await accountHealthRepository.getLatest(account.id);
    return serializeAccountHealthSnapshot(record);
  });

  ipcMain.handle("accountHealth:getLatest", async (_event, request) => {
    const record = await accountHealthRepository.getLatest(request.accountId);
    return record ? serializeAccountHealthSnapshot(record) : undefined;
  });

  ipcMain.handle("deliverabilityLab:runAnalysis", async (_event, request) => {
    const account = db.select().from(accountsTable).where(eq(accountsTable.id, request.accountId)).get();
    if (!account) throw new Error("Account not found");

    const report = await runLabAnalysis({
      input: {
        subject: request.subject,
        document: parsePlainTextToDocument(request.body),
        to: request.to.map((addr) => ({ address: EmailAddress.parse(addr) })),
        from: { address: EmailAddress.parse(account.emailAddress), displayName: account.displayName ?? undefined },
        sendingDomain: account.emailAddress.split("@")[1],
        authCheck: request.checkDomainAuth
          ? { domain: account.emailAddress.split("@")[1], providerName: account.provider }
          : undefined
      },
      draftLifecycle,
      authChecker: domainAuthChecker,
      repository: labReportRepository
    });

    return {
      score: report.score,
      findings: report.findings.map((f) => ({
        ruleId: f.ruleId,
        category: f.category,
        severity: f.severity,
        message: f.message,
        explanation: f.explanation
      }))
    };
  });

  ipcMain.handle("contacts:importCsv", async (_event, request) => {
    return importContactsCsv(request.csvText, contactRepository, leadImportBatchRepository, request.filename || "Pasted import");
  });

  ipcMain.handle("contacts:list", async () => {
    const contacts = await contactRepository.list();
    return contacts.map((c) => ({
      id: c.id,
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName,
      company: c.company,
      source: c.source,
      importBatchId: c.importBatchId
    }));
  });

  ipcMain.handle("leadImportBatches:list", async () => {
    const [batches, contacts] = await Promise.all([leadImportBatchRepository.list(), contactRepository.list()]);
    const countByBatchId = new Map();
    for (const contact of contacts) {
      if (!contact.importBatchId) continue;
      countByBatchId.set(contact.importBatchId, (countByBatchId.get(contact.importBatchId) ?? 0) + 1);
    }
    return batches.map((b) => ({
      id: b.id,
      filename: b.filename,
      importedAt: b.importedAt.toISOString(),
      contactCount: countByBatchId.get(b.id) ?? 0
    }));
  });

  ipcMain.handle("contacts:delete", async (_event, request) => {
    await deleteContact(
      { db, enrollmentRepository, campaignRepository, sequenceRepository, contactRepository },
      request.contactId
    );
  });

  ipcMain.handle("leadImportBatches:delete", async (_event, request) => {
    await deleteLeadImportBatch(
      { db, enrollmentRepository, campaignRepository, sequenceRepository, contactRepository, leadImportBatchRepository },
      request.batchId
    );
  });

  ipcMain.handle("templates:create", async (_event, request) => {
    const template = await templateRepository.create({ name: request.name, document: parsePlainTextToDocument(request.bodyText) });
    return { id: template.id, name: template.name };
  });

  ipcMain.handle("templates:list", async () => {
    const templates = await templateRepository.list();
    return templates.map((t) => ({ id: t.id, name: t.name }));
  });

  ipcMain.handle("sequences:create", async (_event, request) => {
    const sequence = await sequenceRepository.create({
      name: request.name,
      steps: request.steps.map((s) => ({ delayDays: s.delayDays, delayHours: s.delayHours, templateId: s.templateId }))
    });
    for (const [index, step] of sequence.steps.entries()) {
      await subjectVariantRepository.create({
        sequenceStepId: step.id,
        subjectText: request.steps[index].subjectText,
        weight: 1
      });
    }
    return { id: sequence.id, name: sequence.name, stepCount: sequence.steps.length };
  });

  ipcMain.handle("sequences:list", async () => {
    const sequences = await sequenceRepository.list();
    return sequences.map((s) => ({ id: s.id, name: s.name, stepCount: s.steps.length }));
  });

  ipcMain.handle("campaigns:create", async (_event, request) => {
    const campaign = await campaignRepository.create({
      name: request.name,
      sequenceId: request.sequenceId,
      sendingAccountIds: [request.sendingAccountId],
      businessHoursProfileId: request.businessHoursProfileId
    });
    return serializeCampaign(campaign);
  });

  ipcMain.handle("campaigns:list", async () => {
    const campaigns = await campaignRepository.list();
    return campaigns.map(serializeCampaign);
  });

  ipcMain.handle("campaigns:listDashboard", async () => {
    const entries = await getCampaignDashboard({ db, campaignRepository, enrollmentRepository });
    return entries.map((e) => ({
      id: e.id,
      name: e.name,
      status: e.status,
      sendingAccountIds: e.sendingAccountIds,
      totalLeads: e.totalLeads,
      emailsSent: e.emailsSent,
      emailsRemaining: e.emailsRemaining,
      replies: e.replies,
      replyRatePercent: e.replyRatePercent,
      completionPercent: e.completionPercent,
      lastActivityAt: e.lastActivityAt ? e.lastActivityAt.toISOString() : undefined,
      createdAt: e.createdAt.toISOString()
    }));
  });

  ipcMain.handle("campaigns:update", async (_event, request) => {
    const campaign = await campaignRepository.update(request.campaignId, {
      name: request.name,
      businessHoursProfileId: request.businessHoursProfileId
    });
    return serializeCampaign(campaign);
  });

  ipcMain.handle("campaigns:delete", async (_event, request) => {
    // campaignRepository.delete cascades safely (cancels outstanding queued sends, removes
    // enrollments, all in one transaction) -- a campaign is always deletable regardless of how
    // many leads it has, unlike the earlier "only an empty draft" restriction.
    await campaignRepository.delete(request.campaignId);
  });

  ipcMain.handle("businessHoursProfiles:create", async (_event, request) => {
    const windows = {};
    for (const day of request.days) {
      windows[day] = [{ start: request.start, end: request.end }];
    }
    const profile = await businessHoursProfileRepository.create({
      name: request.name,
      timezone: request.timezone,
      windows
    });
    return { id: profile.id, name: profile.name, timezone: profile.timezone, windows: profile.windows };
  });

  ipcMain.handle("businessHoursProfiles:list", async () => {
    const profiles = await businessHoursProfileRepository.list();
    return profiles.map((p) => ({ id: p.id, name: p.name, timezone: p.timezone, windows: p.windows }));
  });

  ipcMain.handle("accounts:updateLimits", async (_event, request) => {
    db.update(accountsTable)
      .set({
        dailySendLimit: request.dailySendLimit ?? null,
        hourlySendLimit: request.hourlySendLimit ?? null,
        minSendDelaySeconds: request.minSendDelaySeconds ?? null,
        maxSendDelaySeconds: request.maxSendDelaySeconds ?? null
      })
      .where(eq(accountsTable.id, request.accountId))
      .run();
    const row = db.select().from(accountsTable).where(eq(accountsTable.id, request.accountId)).get();
    return serializeAccount(row);
  });

  ipcMain.handle("accounts:updateSignature", async (_event, request) => {
    setAccountSignature(db, request.accountId, request.signatureText);
    const row = db.select().from(accountsTable).where(eq(accountsTable.id, request.accountId)).get();
    return serializeAccount(row);
  });

  // Disconnecting revokes this app's locally stored access (deletes the TokenVault entry) rather
  // than merely flipping a flag -- a disconnected account genuinely can't be used to send or sync
  // until the user reconnects (signs in again / re-enters SMTP-IMAP credentials), which is the
  // existing connect flow: it already matches on email address and updates this same row back to
  // 'connected'. Provider Selector already excludes any non-'connected' account (Section 12.4), so
  // this alone is enough to stop future sends/syncs against it -- no other cleanup needed, and
  // every account/message/campaign row referencing this accountId is left untouched.
  ipcMain.handle("accounts:disconnect", async (_event, request) => {
    const row = db.select().from(accountsTable).where(eq(accountsTable.id, request.accountId)).get();
    if (!row) throw new Error("Account not found");

    await tokenVault.delete(request.accountId);
    await accountDirectory.updateStatus(request.accountId, "disconnected");

    const updated = db.select().from(accountsTable).where(eq(accountsTable.id, request.accountId)).get();
    return serializeAccount(updated);
  });

  ipcMain.handle("settings:getAppPreferences", async () => {
    return getAppPreferences(db);
  });

  ipcMain.handle("settings:updateAppPreferences", async (_event, request) => {
    if (request.defaultMinSendDelaySeconds !== undefined || request.defaultMaxSendDelaySeconds !== undefined) {
      const min = request.defaultMinSendDelaySeconds;
      const max = request.defaultMaxSendDelaySeconds;
      if (min === undefined || max === undefined) {
        throw new Error("Set both a minimum and maximum send delay.");
      }
      if (min < 0 || max < min) {
        throw new Error("The minimum send delay must be 0 or greater, and no larger than the maximum.");
      }
      // Critical Improvement #1: Settings is the one place to configure send pacing, so saving it
      // here applies immediately to every currently connected account -- not just a default that
      // silently does nothing until someone also visits the Campaigns screen's per-account fields.
      // Enforcement itself is unchanged: SqliteRateLimiter reads these same per-account columns.
      db.update(accountsTable).set({ minSendDelaySeconds: min, maxSendDelaySeconds: max }).run();
    }
    setAppPreferences(db, request);
    return getAppPreferences(db);
  });

  ipcMain.handle("backup:export", async (_event, request) => {
    const result = await dialog.showSaveDialog({
      title: "Export Outboundly Backup",
      defaultPath: `outboundly-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: "Outboundly Backup", extensions: ["sqlite"] }]
    });
    if (result.canceled || !result.filePath) return { exported: false };

    exportEncryptedBackup(dbPath, getOrCreateDatabaseEncryptionKey(), result.filePath, request.passphrase);
    return { exported: true, filePath: result.filePath };
  });

  ipcMain.handle("backup:restore", async (_event, request) => {
    const result = await dialog.showOpenDialog({
      title: "Restore Outboundly Backup",
      properties: ["openFile"],
      filters: [{ name: "Outboundly Backup", extensions: ["sqlite"] }]
    });
    if (result.canceled || result.filePaths.length === 0) return { restored: false };

    // Replaces the live db file on disk -- the renderer already confirmed this destructive action
    // before invoking this handler. A restart is required so a fresh openDatabase() picks up the
    // replaced file instead of every already-constructed repository continuing to hold the old one.
    restoreEncryptedBackup(result.filePaths[0], request.passphrase, getOrCreateDatabaseEncryptionKey(), dbPath);
    app.relaunch();
    app.exit(0);
    return { restored: true };
  });

  ipcMain.handle("campaigns:setStatus", async (_event, request) => {
    await campaignRepository.setStatus(request.campaignId, request.status);
  });

  ipcMain.handle("campaigns:enrollContacts", async (_event, request) => {
    return enrollContactIdsIntoCampaign(request.campaignId, request.contactIds);
  });

  // Critical Improvement #2: a campaign's own CSV upload, not the global contacts list, is the
  // only way leads get enrolled -- importContactsCsv's returned contactIds are exactly and only
  // this run's batch, so enrollContactIdsIntoCampaign (shared with the manual-selection handler
  // above) never reaches outside it into unrelated contacts from other campaigns/imports.
  ipcMain.handle("campaigns:enrollFromCsv", async (_event, request) => {
    const importResult = await importContactsCsv(
      request.csvText,
      contactRepository,
      leadImportBatchRepository,
      request.filename || "Pasted import"
    );
    const enrollResult = await enrollContactIdsIntoCampaign(request.campaignId, importResult.contactIds);
    return {
      batchId: importResult.batchId,
      imported: importResult.imported,
      importSkipped: importResult.skipped,
      enrolled: enrollResult.enrolled,
      enrollSkipped: enrollResult.skipped
    };
  });

  // Critical Improvement #2, extended: picking an already-uploaded batch (instead of uploading
  // the same CSV again) still only ever enrolls that exact batch's contacts -- same isolation
  // guarantee as campaigns:enrollFromCsv, just skipping the redundant re-import.
  ipcMain.handle("campaigns:enrollFromBatch", async (_event, request) => {
    const batchContacts = db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(and(eq(contactsTable.importBatchId, request.batchId), isNull(contactsTable.deletedAt)))
      .all();
    return enrollContactIdsIntoCampaign(request.campaignId, batchContacts.map((c) => c.id));
  });

  ipcMain.handle("campaigns:listEnrollments", async (_event, request) => {
    const enrollments = await enrollmentRepository.listByCampaign(request.campaignId);
    return enrollments.map((e) => ({
      id: e.id,
      contactId: e.contactId,
      status: e.status,
      nextSendAt: e.nextSendAt ? e.nextSendAt.toISOString() : undefined,
      enrolledAt: e.enrolledAt.toISOString()
    }));
  });

  ipcMain.handle("analytics:getCampaignAnalytics", async (_event, request) => {
    return getCampaignAnalytics(
      { db, campaignRepository, sequenceRepository, enrollmentRepository, campaignMetricsRollupRepository },
      request.campaignId,
      new Date()
    );
  });

  ipcMain.handle("insights:listActive", async () => {
    const list = await insightRepository.findActiveFeed(50);
    return list.map((i) => ({
      id: i.id,
      scope: i.scope,
      scopeId: i.scopeId,
      insightType: i.insightType,
      severity: i.severity,
      message: i.message,
      explanation: i.explanation,
      recommendedAction: i.recommendedAction,
      generatedAt: i.generatedAt.toISOString()
    }));
  });

  ipcMain.handle("insights:dismiss", async (_event, request) => {
    await insightRepository.dismiss(request.insightId);
  });

  ipcMain.handle("analytics:markConversion", async (_event, request) => {
    await recordConversion(eventRepository, request.campaignId, request.contactId);
  });

  ipcMain.handle("campaigns:unsubscribeContact", async (_event, request) => {
    await unsubscribeContact(
      { db, enrollmentRepository, campaignRepository, sequenceRepository, contactRepository, suppressionListRepository, eventRepository },
      request.contactId,
      request.campaignId
    );
  });

  ipcMain.handle("suppressionList:list", async () => {
    const entries = await suppressionListRepository.list();
    return entries.map((e) => ({ id: e.id, email: e.email, reason: e.reason, createdAt: e.createdAt.toISOString() }));
  });

  // A purely local database change (Section 5.5): un-suppressing an email only affects future
  // campaign enrollment/send eligibility. It never touches any previously sent message or any
  // outbound header/content, so it has no bearing on how a mailbox provider (e.g. Gmail) files
  // future mail into Primary vs. Promotions -- that classification is driven by sending
  // reputation/content/engagement signals, none of which this action changes.
  ipcMain.handle("suppressionList:remove", async (_event, request) => {
    await suppressionListRepository.remove(request.email);
  });

  ipcMain.handle("inbox:setReplyClassification", async (_event, request) => {
    await labelReply({ conversationRepository, enrollmentRepository, eventRepository }, request.messageId, request.classification);
  });

  ipcMain.handle("notifications:listUnread", async () => {
    const list = await notificationRepository.findUnread(50);
    return list.map((n) => ({
      id: n.id,
      notificationType: n.notificationType,
      severity: n.severity,
      message: n.message,
      relatedAccountId: n.relatedAccountId,
      relatedCampaignId: n.relatedCampaignId,
      createdAt: n.createdAt.toISOString()
    }));
  });

  ipcMain.handle("logs:listRecent", async (_event, request) => {
    const list = await errorLogRepository.listRecent(request.limit, request.source);
    return list.map((e) => ({
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      source: e.source,
      errorType: e.errorType,
      errorMessage: e.errorMessage,
      campaignId: e.campaignId,
      accountId: e.accountId,
      recipientEmail: e.recipientEmail,
      retryCount: e.retryCount
    }));
  });

  ipcMain.handle("notifications:markRead", async (_event, request) => {
    await notificationRepository.markRead(request.notificationId);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // OS-level renderer sandbox (Section 23 defense-in-depth): preload.cjs only ever calls
      // contextBridge/ipcRenderer, both fully supported from a sandboxed preload, so there's no
      // functional reason for this to be off.
      sandbox: true
    }
  });
  void mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
}

/** Pushes a main -> renderer event (Critical Improvement #5's sync-progress feed) -- a no-op if
 * the window doesn't exist yet or was already closed, since progress updates are best-effort. */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(async () => {
  initServices();

  // Startup crash recovery (Section 16.2): a row can only ever be left in status='claimed' by a
  // process that died mid-dispatch, and this fresh process has no in-flight dispatch of its own
  // yet, so every 'claimed' row found right now is unconditionally orphaned. Runs before any
  // background worker starts claiming new rows.
  const recoveredCount = await sendQueueRepository.requeueOrphanedClaims(new Date());
  if (recoveredCount > 0) {
    console.warn(`[startup] recovered ${recoveredCount} send_queue row(s) orphaned by an unclean shutdown`);
  }

  registerIpcHandlers();
  startBackgroundWorkers();
  createWindow();

  // Auto-update (Section 27): only meaningful for an actual packaged/installed build checking
  // GitHub Releases (electron-builder.yml's `publish` config) -- running from source in
  // development has no installed artifact to update in place, and electron-updater itself expects
  // an app-update.yml file that only exists in a packaged build, so this would just error out.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error("[auto-update] check failed:", err);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopBackgroundWorkers();
});
