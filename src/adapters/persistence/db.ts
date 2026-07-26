import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type OutboundlyDb = BetterSQLite3Database<typeof schema>;

/**
 * Opens (creating if necessary) the SQLite database at `filePath`, applies crash-safe pragmas
 * (Section 23: write-ahead logging, enforced foreign keys), and runs any pending migrations.
 * Whole-database at-rest encryption (Section 23) is a follow-up increment once a keychain-backed
 * key management story is wired up (Section 13.3) — not required to validate Phase 1's pipeline.
 */
export function openDatabase(filePath: string): OutboundlyDb {
  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(__dirname, "migrations") });
  return db;
}
