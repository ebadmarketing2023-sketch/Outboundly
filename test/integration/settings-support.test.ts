import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getAccountSignature,
  getAppPreferences,
  getAppSetting,
  setAccountSignature,
  setAppPreferences,
  setAppSetting
} from "../../src/adapters/persistence/settings-support.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";

describe("settings-support (Section 3 Settings module)", () => {
  let db: OutboundlyDb;
  let accountId: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-settings-support-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    accountId = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id: accountId,
        provider: "google",
        emailAddress: "me@outboundly.app",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();
  });

  it("returns undefined for an unset key-value setting", () => {
    expect(getAppSetting(db, "no_such_key")).toBeUndefined();
  });

  it("sets and reads back a key-value setting", () => {
    setAppSetting(db, "some_key", "some_value");
    expect(getAppSetting(db, "some_key")).toBe("some_value");
  });

  it("replaces (not duplicates) an existing key-value setting on re-set", () => {
    setAppSetting(db, "some_key", "first");
    setAppSetting(db, "some_key", "second");
    expect(getAppSetting(db, "some_key")).toBe("second");
  });

  it("has no signature by default, then round-trips a set signature", () => {
    expect(getAccountSignature(db, asAccountId(accountId))).toBeUndefined();
    setAccountSignature(db, asAccountId(accountId), "Best,\nMe");
    expect(getAccountSignature(db, asAccountId(accountId))).toBe("Best,\nMe");
  });

  it("clears a signature when set to undefined", () => {
    setAccountSignature(db, asAccountId(accountId), "Best,\nMe");
    setAccountSignature(db, asAccountId(accountId), undefined);
    expect(getAccountSignature(db, asAccountId(accountId))).toBeUndefined();
  });

  it("round-trips app preferences, leaving an omitted preference untouched", () => {
    expect(getAppPreferences(db)).toEqual({ defaultBusinessHoursProfileId: undefined, defaultSendingAccountId: undefined });

    setAppPreferences(db, { defaultBusinessHoursProfileId: "bhp-1" });
    expect(getAppPreferences(db)).toEqual({ defaultBusinessHoursProfileId: "bhp-1", defaultSendingAccountId: undefined });

    setAppPreferences(db, { defaultSendingAccountId: accountId });
    expect(getAppPreferences(db)).toEqual({ defaultBusinessHoursProfileId: "bhp-1", defaultSendingAccountId: accountId });
  });

  it("round-trips the default send-delay range as numbers, not strings", () => {
    expect(getAppPreferences(db).defaultMinSendDelaySeconds).toBeUndefined();

    setAppPreferences(db, { defaultMinSendDelaySeconds: 60, defaultMaxSendDelaySeconds: 120 });
    const prefs = getAppPreferences(db);
    expect(prefs.defaultMinSendDelaySeconds).toBe(60);
    expect(prefs.defaultMaxSendDelaySeconds).toBe(120);
  });
});
