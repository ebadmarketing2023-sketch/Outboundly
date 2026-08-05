import { eq } from "drizzle-orm";
import type { AccountId } from "../../core/shared-kernel/ids.js";
import type { OutboundlyDb } from "./db.js";
import { accounts, appSettings } from "./schema.js";

/**
 * Settings module (Section 3: "User preferences, sending defaults, signatures-by-account, business
 * hours"). Plain adapter-layer functions, not a repository class -- there's no domain logic here,
 * just reads/writes against two simple shapes (a key-value store, a column on an existing table),
 * matching the same precedent as campaign-scheduling-support.ts/campaign-analytics-support.ts for
 * glue with no dedicated port.
 */

export const APP_SETTING_KEYS = {
  defaultBusinessHoursProfileId: "default_business_hours_profile_id",
  defaultSendingAccountId: "default_sending_account_id",
  defaultMinSendDelaySeconds: "default_min_send_delay_seconds",
  defaultMaxSendDelaySeconds: "default_max_send_delay_seconds",
  allowConcurrentCampaigns: "allow_concurrent_campaigns",
  licenseKey: "license_key",
  licenseFingerprint: "license_fingerprint",
  licenseMachineId: "license_machine_id",
  licenseLastValidAt: "license_last_valid_at"
} as const;

export function getAppSetting(db: OutboundlyDb, key: string): string | undefined {
  return db.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value;
}

export function setAppSetting(db: OutboundlyDb, key: string, value: string, now: Date = new Date()): void {
  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
    .run();
}

export function getAccountSignature(db: OutboundlyDb, accountId: AccountId): string | undefined {
  return db.select().from(accounts).where(eq(accounts.id, accountId)).get()?.signatureText ?? undefined;
}

export function setAccountSignature(db: OutboundlyDb, accountId: AccountId, signatureText: string | undefined, now: Date = new Date()): void {
  db.update(accounts)
    .set({ signatureText: signatureText ?? null, updatedAt: now })
    .where(eq(accounts.id, accountId))
    .run();
}

export interface AppPreferences {
  defaultBusinessHoursProfileId?: string;
  defaultSendingAccountId?: string;
  /** The app-wide randomized send-delay range in seconds (Critical Improvement #1), the Settings
   * screen's one place to configure pacing -- saving it also applies it to every currently
   * connected account (see the `settings:updateAppPreferences` IPC handler), since the actual
   * enforcement is per-account (accounts.minSendDelaySeconds/maxSendDelaySeconds, read by
   * SqliteRateLimiter). Stored here too so it's remembered as the default for accounts connected
   * later. */
  defaultMinSendDelaySeconds?: number;
  defaultMaxSendDelaySeconds?: number;
  /** Whether a lead may be actively enrolled in more than one campaign at a time. Off unless the
   * user turns it on -- see enroll-contacts.ts for why sharing a lead across two live campaigns is
   * a spam-complaint risk rather than an extra touch. */
  allowConcurrentCampaigns?: boolean;
}

export function getAppPreferences(db: OutboundlyDb): AppPreferences {
  const min = getAppSetting(db, APP_SETTING_KEYS.defaultMinSendDelaySeconds);
  const max = getAppSetting(db, APP_SETTING_KEYS.defaultMaxSendDelaySeconds);
  return {
    defaultBusinessHoursProfileId: getAppSetting(db, APP_SETTING_KEYS.defaultBusinessHoursProfileId),
    defaultSendingAccountId: getAppSetting(db, APP_SETTING_KEYS.defaultSendingAccountId),
    defaultMinSendDelaySeconds: min === undefined ? undefined : Number(min),
    defaultMaxSendDelaySeconds: max === undefined ? undefined : Number(max),
    // Absent means off: the safe default has to survive a database that predates this setting.
    allowConcurrentCampaigns: getAppSetting(db, APP_SETTING_KEYS.allowConcurrentCampaigns) === "true"
  };
}

export function setAppPreferences(db: OutboundlyDb, prefs: AppPreferences, now: Date = new Date()): void {
  if (prefs.defaultBusinessHoursProfileId !== undefined) {
    setAppSetting(db, APP_SETTING_KEYS.defaultBusinessHoursProfileId, prefs.defaultBusinessHoursProfileId, now);
  }
  if (prefs.defaultSendingAccountId !== undefined) {
    setAppSetting(db, APP_SETTING_KEYS.defaultSendingAccountId, prefs.defaultSendingAccountId, now);
  }
  if (prefs.defaultMinSendDelaySeconds !== undefined) {
    setAppSetting(db, APP_SETTING_KEYS.defaultMinSendDelaySeconds, String(prefs.defaultMinSendDelaySeconds), now);
  }
  if (prefs.defaultMaxSendDelaySeconds !== undefined) {
    setAppSetting(db, APP_SETTING_KEYS.defaultMaxSendDelaySeconds, String(prefs.defaultMaxSendDelaySeconds), now);
  }
  if (prefs.allowConcurrentCampaigns !== undefined) {
    setAppSetting(db, APP_SETTING_KEYS.allowConcurrentCampaigns, String(prefs.allowConcurrentCampaigns), now);
  }
}

/**
 * Licensing (disclosed license-key model): what this specific installation activated with, if
 * anything yet. Stored in the same key-value settings table as everything else here -- the whole
 * database is already encrypted at rest (Section 19), so this needs no separate secret-storage
 * mechanism the way OAuth tokens do (those use the OS keychain because they're per-account and
 * more sensitive; there's exactly one license per installation, and it only ever authorizes
 * actions against itself, never another customer's).
 */
export interface StoredLicenseState {
  licenseKey?: string;
  fingerprint?: string;
  machineId?: string;
  lastValidAt?: Date;
}

export function getStoredLicenseState(db: OutboundlyDb): StoredLicenseState {
  const licenseKey = getAppSetting(db, APP_SETTING_KEYS.licenseKey);
  const fingerprint = getAppSetting(db, APP_SETTING_KEYS.licenseFingerprint);
  const machineId = getAppSetting(db, APP_SETTING_KEYS.licenseMachineId);
  const lastValidAtRaw = getAppSetting(db, APP_SETTING_KEYS.licenseLastValidAt);
  return {
    licenseKey,
    fingerprint,
    machineId,
    lastValidAt: lastValidAtRaw ? new Date(lastValidAtRaw) : undefined
  };
}

export function saveLicenseActivation(
  db: OutboundlyDb,
  input: { licenseKey: string; fingerprint: string; machineId: string },
  now: Date = new Date()
): void {
  setAppSetting(db, APP_SETTING_KEYS.licenseKey, input.licenseKey, now);
  setAppSetting(db, APP_SETTING_KEYS.licenseFingerprint, input.fingerprint, now);
  setAppSetting(db, APP_SETTING_KEYS.licenseMachineId, input.machineId, now);
}

export function recordLicenseValidationSuccess(db: OutboundlyDb, now: Date = new Date()): void {
  setAppSetting(db, APP_SETTING_KEYS.licenseLastValidAt, now.toISOString(), now);
}
