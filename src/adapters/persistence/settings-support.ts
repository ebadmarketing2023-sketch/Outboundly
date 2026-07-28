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
  defaultSendingAccountId: "default_sending_account_id"
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
}

export function getAppPreferences(db: OutboundlyDb): AppPreferences {
  return {
    defaultBusinessHoursProfileId: getAppSetting(db, APP_SETTING_KEYS.defaultBusinessHoursProfileId),
    defaultSendingAccountId: getAppSetting(db, APP_SETTING_KEYS.defaultSendingAccountId)
  };
}

export function setAppPreferences(db: OutboundlyDb, prefs: AppPreferences, now: Date = new Date()): void {
  if (prefs.defaultBusinessHoursProfileId !== undefined) {
    setAppSetting(db, APP_SETTING_KEYS.defaultBusinessHoursProfileId, prefs.defaultBusinessHoursProfileId, now);
  }
  if (prefs.defaultSendingAccountId !== undefined) {
    setAppSetting(db, APP_SETTING_KEYS.defaultSendingAccountId, prefs.defaultSendingAccountId, now);
  }
}
