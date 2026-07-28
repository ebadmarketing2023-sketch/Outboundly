import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportEncryptedBackup, restoreEncryptedBackup } from "../../src/adapters/persistence/backup-restore.js";
import { openDatabase } from "../../src/adapters/persistence/db.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { generateId } from "../../src/core/shared-kernel/ids.js";

describe("backup/restore (Section 23: encrypted backups under a separate passphrase)", () => {
  it("round-trips real app data through export and restore under a different app key", () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-backup-restore-test-"));
    const liveDbPath = join(dir, "live.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const restoredPath = join(dir, "restored.sqlite");

    const originalAppKey = randomBytes(32).toString("hex");
    const db = openDatabase(liveDbPath, originalAppKey);
    const accountId = generateId();
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

    exportEncryptedBackup(liveDbPath, originalAppKey, backupPath, "correct horse battery staple");

    // The exported backup must NOT be openable under the app's own key -- it's a different key now.
    expect(() => openDatabase(backupPath, originalAppKey)).toThrow();

    const newAppKey = randomBytes(32).toString("hex");
    restoreEncryptedBackup(backupPath, "correct horse battery staple", newAppKey, restoredPath);

    const restoredDb = openDatabase(restoredPath, newAppKey);
    const found = restoredDb.select().from(accounts).all().find((a) => a.id === accountId);
    expect(found?.emailAddress).toBe("me@outboundly.app");
  });

  it("throws restoring with the wrong passphrase, and leaves no partial file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-backup-restore-wrongpass-test-"));
    const liveDbPath = join(dir, "live.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const restoredPath = join(dir, "restored.sqlite");

    const appKey = randomBytes(32).toString("hex");
    openDatabase(liveDbPath, appKey);
    exportEncryptedBackup(liveDbPath, appKey, backupPath, "the-real-passphrase");

    expect(() => restoreEncryptedBackup(backupPath, "totally-wrong-passphrase", appKey, restoredPath)).toThrow(/wrong passphrase/i);
    expect(existsSync(restoredPath)).toBe(false);
  });

  it("throws exporting with an empty passphrase", () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-backup-restore-emptypass-test-"));
    const liveDbPath = join(dir, "live.sqlite");
    const backupPath = join(dir, "backup.sqlite");
    const appKey = randomBytes(32).toString("hex");
    openDatabase(liveDbPath, appKey);

    expect(() => exportEncryptedBackup(liveDbPath, appKey, backupPath, "   ")).toThrow(/passphrase is required/i);
  });

  it("throws exporting a database file that doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-backup-restore-nofile-test-"));
    expect(() => exportEncryptedBackup(join(dir, "nope.sqlite"), randomBytes(32).toString("hex"), join(dir, "backup.sqlite"), "pass")).toThrow(
      /no database file/i
    );
  });
});
