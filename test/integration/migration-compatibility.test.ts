import RawDatabase from "better-sqlite3-multiple-ciphers";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration testing (Section 24.6): "Every schema migration tested both forward (applies cleanly
 * against a snapshot of realistically-shaped existing data) and for safe, versioned rollback --
 * never assumed safe just because it ran once against an empty database."
 *
 * The "forward" half is what's tested here: every migration up to (not including) the latest is
 * applied to a fresh file, realistic pre-existing data is inserted matching that snapshot's
 * shape, then the latest migration is applied on top -- proving it doesn't corrupt or lose
 * existing rows, and that the new column/table it adds is genuinely usable afterward. This is a
 * stronger test than "migrations ran once against an empty database" (which test/integration/
 * db.test.ts already covers) because it exercises the actual ALTER TABLE / CREATE TABLE against a
 * populated schema, the same shape a real upgrading install would have.
 *
 * The "rollback" half is NOT implemented: this project's migration tooling (drizzle-kit) doesn't
 * generate down-migration scripts, and none exist in this repo to test against -- authoring a
 * rollback mechanism from scratch would be new infrastructure, not a test of existing behavior.
 */

const MIGRATIONS_DIR = join(process.cwd(), "src/adapters/persistence/migrations");

function orderedMigrationFiles(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((e) => `${e.tag}.sql`);
}

function applyMigrationFile(sqlite: RawDatabase.Database, fileName: string): void {
  const raw = readFileSync(join(MIGRATIONS_DIR, fileName), "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    sqlite.exec(statement);
  }
}

describe("Migration compatibility against realistic existing data (Section 24.6)", () => {
  it("applies the latest migration cleanly on top of data seeded under the prior schema snapshot", () => {
    const files = orderedMigrationFiles();
    expect(files.length).toBeGreaterThan(1); // otherwise there's nothing meaningful to test here

    const priorFiles = files.slice(0, -1);
    const latestFile = files[files.length - 1]!;

    const dir = mkdtempSync(join(tmpdir(), "outboundly-migration-compat-test-"));
    const dbPath = join(dir, "test.sqlite");
    const encryptionKey = randomBytes(32).toString("hex");

    const sqlite = new RawDatabase(dbPath);
    sqlite.pragma("cipher='sqlcipher'");
    sqlite.pragma(`key="x'${encryptionKey}'"`);
    sqlite.pragma("foreign_keys = ON");

    for (const file of priorFiles) {
      applyMigrationFile(sqlite, file);
    }

    // Realistic pre-existing data, inserted under the schema as it existed before the latest
    // migration (accounts has no signature_text column at this snapshot).
    const now = Date.now();
    const accountId = randomBytes(16).toString("hex");
    sqlite
      .prepare(
        `INSERT INTO accounts (id, provider, email_address, status, connected_at, created_at, updated_at)
         VALUES (?, 'google', 'me@outboundly.app', 'connected', ?, ?, ?)`
      )
      .run(accountId, now, now, now);

    expect(() => applyMigrationFile(sqlite, latestFile)).not.toThrow();

    // The pre-existing row survived, untouched.
    const account = sqlite.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as Record<string, unknown>;
    expect(account.email_address).toBe("me@outboundly.app");
    expect(account.status).toBe("connected");

    // The new column this migration adds is genuinely usable, not just present.
    expect(account.signature_text).toBeNull();
    sqlite.prepare("UPDATE accounts SET signature_text = ? WHERE id = ?").run("Best,\nMe", accountId);
    const updated = sqlite.prepare("SELECT signature_text FROM accounts WHERE id = ?").get(accountId) as {
      signature_text: string;
    };
    expect(updated.signature_text).toBe("Best,\nMe");

    // The new table this migration adds is genuinely usable, not just present.
    sqlite.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)").run("test_key", "test_value", now);
    const setting = sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get("test_key") as { value: string };
    expect(setting.value).toBe("test_value");

    sqlite.close();
  });

  it("applies every migration in order against a fresh file without error (baseline sanity check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-migration-fresh-test-"));
    const dbPath = join(dir, "test.sqlite");
    const encryptionKey = randomBytes(32).toString("hex");

    const sqlite = new RawDatabase(dbPath);
    sqlite.pragma("cipher='sqlcipher'");
    sqlite.pragma(`key="x'${encryptionKey}'"`);
    sqlite.pragma("foreign_keys = ON");

    for (const file of orderedMigrationFiles()) {
      expect(() => applyMigrationFile(sqlite, file)).not.toThrow();
    }

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["accounts", "app_settings", "notifications", "insights"]));

    sqlite.close();
  });
});
