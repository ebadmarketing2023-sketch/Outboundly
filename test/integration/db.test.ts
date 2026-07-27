import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RawDatabase from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import * as schema from "../../src/adapters/persistence/schema.js";
import { accounts, drafts } from "../../src/adapters/persistence/schema.js";
import { eq } from "drizzle-orm";

describe("SQLite schema + migrations (Section 5, Section 24.6)", () => {
  let db: OutboundlyDb;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "outboundly-db-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
  });

  afterEach(() => {
    // better-sqlite3 handles closes on process exit; nothing further needed for a temp file DB.
  });

  it("applies migrations and enforces foreign keys", () => {
    const accountId = randomUUID();
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

    expect(() =>
      db
        .insert(drafts)
        .values({
          id: randomUUID(),
          accountId: "does-not-exist",
          documentModelJson: "{}",
          toAddresses: ["them@example.com"],
          lastSavedAt: now
        })
        .run()
    ).toThrow();

    db.insert(drafts)
      .values({
        id: "draft-1",
        accountId,
        documentModelJson: "{}",
        toAddresses: ["them@example.com"],
        lastSavedAt: now
      })
      .run();

    const found = db.select().from(drafts).where(eq(drafts.id, "draft-1")).get();
    expect(found?.accountId).toBe(accountId);
    expect(found?.toAddresses).toEqual(["them@example.com"]);
  });

  it("encrypts the database at rest (Section 23): wrong key rejected, no plaintext on disk", () => {
    const encryptedDir = mkdtempSync(join(tmpdir(), "outboundly-db-encryption-test-"));
    const dbPath = join(encryptedDir, "encrypted.sqlite");
    const key = randomBytes(32).toString("hex");
    const secretMarker = "super-secret-marker-only-this-test-inserts";

    const encryptedDb = openDatabase(dbPath, key);
    encryptedDb.insert(accounts).values({
      id: randomUUID(),
      provider: "google",
      emailAddress: secretMarker,
      status: "connected",
      connectedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    }).run();

    const rawBytes = readFileSync(dbPath);
    expect(rawBytes.subarray(0, 16).toString("utf8")).not.toBe("SQLite format 3\0");
    expect(rawBytes.includes(secretMarker)).toBe(false);

    const wrongKey = randomBytes(32).toString("hex");
    expect(() => openDatabase(dbPath, wrongKey)).toThrow();

    const reopened = openDatabase(dbPath, key);
    const row = reopened
      .select()
      .from(accounts)
      .where(eq(accounts.emailAddress, secretMarker))
      .get();
    expect(row?.emailAddress).toBe(secretMarker);
  });

  it("migrates a pre-existing unencrypted database in place, preserving its data (Section 23 upgrade path)", () => {
    const upgradeDir = mkdtempSync(join(tmpdir(), "outboundly-db-upgrade-test-"));
    const dbPath = join(upgradeDir, "legacy.sqlite");
    const preExistingEmail = "already-connected-before-encryption-shipped@outboundly.app";

    // Simulate a real install from before Section 23: a plain, unencrypted better-sqlite3 file
    // built the exact same way the old (pre-encryption) openDatabase() used to — WAL journal mode,
    // real schema via drizzle's migrate(), no key pragmas at all — with real data already in it.
    // The WAL mode is not incidental: SQLCipher's rekey pragma fails against a WAL-mode database
    // (a real bug this test caught — "Rekeying is not supported in WAL journal mode."), so a
    // legacy database built without it would not have exercised that failure mode.
    const legacyRawDb = new RawDatabase(dbPath);
    legacyRawDb.pragma("journal_mode = WAL");
    const legacyDrizzleDb = drizzle(legacyRawDb, { schema });
    migrate(legacyDrizzleDb, { migrationsFolder: join(process.cwd(), "src/adapters/persistence/migrations") });
    const now = new Date();
    legacyDrizzleDb
      .insert(accounts)
      .values({
        id: randomUUID(),
        provider: "google",
        emailAddress: preExistingEmail,
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();
    legacyRawDb.close();

    const rawBytesBefore = readFileSync(dbPath);
    expect(rawBytesBefore.subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");

    const key = randomBytes(32).toString("hex");
    const migrated = openDatabase(dbPath, key);

    const preservedRow = migrated
      .select()
      .from(accounts)
      .where(eq(accounts.emailAddress, preExistingEmail))
      .get();
    expect(preservedRow?.emailAddress).toBe(preExistingEmail);

    const rawBytesAfter = readFileSync(dbPath);
    expect(rawBytesAfter.subarray(0, 16).toString("utf8")).not.toBe("SQLite format 3\0");

    // A second open with the same key must also work, proving the migration is durable, not a
    // one-time in-memory-only fixup.
    const reopenedAfterMigration = openDatabase(dbPath, key);
    expect(
      reopenedAfterMigration
        .select()
        .from(accounts)
        .where(eq(accounts.emailAddress, preExistingEmail))
        .get()?.emailAddress
    ).toBe(preExistingEmail);
  });
});
