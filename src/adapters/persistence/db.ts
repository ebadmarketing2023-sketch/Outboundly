import Database from "better-sqlite3-multiple-ciphers";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type OutboundlyDb = BetterSQLite3Database<typeof schema>;

// "sqlcipher" is the well-known, audited cipher scheme this multi-cipher build supports, chosen
// explicitly rather than relying on the library's default. The raw-key `x'...'` form skips PBKDF2
// passphrase derivation since `encryptionKey` is already a random key, not a human passphrase.
function applyCipherAndKey(sqlite: Database.Database, pragmaName: "key" | "rekey", encryptionKey: string): void {
  sqlite.pragma("cipher='sqlcipher'");
  sqlite.pragma(`${pragmaName}="x'${encryptionKey}'"`);
}

function canReadExistingData(sqlite: Database.Database): boolean {
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens (creating if necessary) the SQLite database at `filePath`, applies whole-database at-rest
 * encryption (Section 23) using `encryptionKey` (a 64-character hex string — see database-key.ts
 * for how the real app sources one from the OS keychain), applies crash-safe pragmas (write-ahead
 * logging, enforced foreign keys), and runs any pending migrations.
 *
 * Handles the one-time upgrade from an existing *unencrypted* database file (this app shipped
 * without at-rest encryption before Section 23 landed, so real installs may already have local
 * data): if the file exists but can't be read with the given key, it's re-probed as plaintext,
 * and if that succeeds, migrated to encrypted form in place via SQLCipher's `rekey` pragma
 * (verified for real against this build: a plaintext file opened with no key, then
 * `cipher=...`+`rekey=...`, converts in place without data loss) — never silently discarded or
 * recreated, since it may hold real drafts and synced mail.
 */
export function openDatabase(filePath: string, encryptionKey: string): OutboundlyDb {
  const fileAlreadyExisted = existsSync(filePath);
  let sqlite = new Database(filePath);

  if (fileAlreadyExisted) {
    applyCipherAndKey(sqlite, "key", encryptionKey);

    if (!canReadExistingData(sqlite)) {
      sqlite.close();
      const plaintextProbe = new Database(filePath);
      if (!canReadExistingData(plaintextProbe)) {
        plaintextProbe.close();
        throw new Error(
          `Unable to open database at ${filePath}: the encryption key doesn't match this file, or it's corrupted`
        );
      }

      // Confirmed plaintext (pre-encryption install) — convert it in place, then reopen normally.
      applyCipherAndKey(plaintextProbe, "rekey", encryptionKey);
      plaintextProbe.close();
      sqlite = new Database(filePath);
      applyCipherAndKey(sqlite, "key", encryptionKey);
    }
  } else {
    // Brand-new file — nothing to migrate, encrypted from the very first byte written.
    applyCipherAndKey(sqlite, "key", encryptionKey);
  }

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: join(__dirname, "migrations") });
  return db;
}
