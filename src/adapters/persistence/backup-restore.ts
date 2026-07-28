import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";

/**
 * Backup/restore (Section 23: "Exported backups are encrypted with a user-supplied passphrase
 * separate from the app's own at-rest key"). Works directly against the raw SQLite file with the
 * cipher extension's own `key`/`rekey` pragmas (Section 23, same mechanism db.ts already uses and
 * has verified for real) rather than any custom crypto -- the backup file this produces is a
 * normal, directly-openable encrypted SQLite database, not a bespoke envelope format.
 *
 * `sqlcipher_export()` (SQLCipher's own built-in re-encryption function) is NOT available in this
 * multi-cipher build -- verified for real against this exact package (`no such function:
 * sqlcipher_export`). The approach here instead: checkpoint the live database's WAL into its main
 * file so a plain filesystem copy is self-contained, copy it, then `rekey` that copy from the
 * app's own key to the user's passphrase (or back, for restore) -- `rekey` requires the rollback
 * journal mode, not WAL, matching the exact limitation db.ts's own docblock already documents and
 * works around for the plaintext-to-encrypted upgrade path.
 */

function hexKeyLiteral(hexKey: string): string {
  return `"x'${hexKey}'"`;
}

function passphraseLiteral(passphrase: string): string {
  return `'${passphrase.replace(/'/g, "''")}'`;
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
 * Exports the live database at `liveDbPath` (encrypted under the app's own `appEncryptionKeyHex`)
 * into a standalone backup file at `destBackupPath`, encrypted under `passphrase` instead. Safe to
 * call while the app's own long-lived connection to `liveDbPath` is still open -- this opens its
 * own short-lived connection to the same file, which SQLite/the cipher extension both support
 * concurrently (verified for real), so the running app is never interrupted.
 */
export function exportEncryptedBackup(liveDbPath: string, appEncryptionKeyHex: string, destBackupPath: string, passphrase: string): void {
  if (!existsSync(liveDbPath)) throw new Error(`No database file found at ${liveDbPath}`);
  if (passphrase.trim().length === 0) throw new Error("A backup passphrase is required");

  const liveConn = new Database(liveDbPath);
  liveConn.pragma("cipher='sqlcipher'");
  liveConn.pragma(`key=${hexKeyLiteral(appEncryptionKeyHex)}`);
  liveConn.pragma("wal_checkpoint(TRUNCATE)");
  liveConn.close();

  const tempPath = `${destBackupPath}.tmp-${Date.now()}`;
  copyFileSync(liveDbPath, tempPath);

  const tempConn = new Database(tempPath);
  tempConn.pragma("cipher='sqlcipher'");
  tempConn.pragma(`key=${hexKeyLiteral(appEncryptionKeyHex)}`);
  tempConn.pragma("journal_mode = DELETE"); // rekey doesn't support WAL mode
  tempConn.pragma(`rekey=${passphraseLiteral(passphrase)}`);
  tempConn.close();

  if (existsSync(destBackupPath)) unlinkSync(destBackupPath);
  renameSync(tempPath, destBackupPath);
}

/**
 * Restores `backupFilePath` (encrypted under `passphrase`) into `destDbPath`, re-encrypted under
 * the app's own `appEncryptionKeyHex` so the app keeps using its normal OS-keychain-sourced key
 * afterward rather than remembering the backup passphrase. The caller must close its own
 * connection to `destDbPath` before calling this (the file is replaced on disk) and restart the
 * app afterward so a fresh `openDatabase()` call picks up the replaced file, rather than
 * continuing to use stale in-memory repository instances built against the old one.
 */
export function restoreEncryptedBackup(backupFilePath: string, passphrase: string, appEncryptionKeyHex: string, destDbPath: string): void {
  if (!existsSync(backupFilePath)) throw new Error(`No backup file found at ${backupFilePath}`);

  const tempPath = `${destDbPath}.restoring-${Date.now()}`;
  copyFileSync(backupFilePath, tempPath);

  const tempConn = new Database(tempPath);
  tempConn.pragma("cipher='sqlcipher'");
  tempConn.pragma(`key=${passphraseLiteral(passphrase)}`);
  // `PRAGMA key` never throws on a wrong passphrase by itself -- verified for real -- only a real
  // read against the (mis-)decrypted file does, so an explicit read is the only honest way to
  // detect "wrong passphrase" before treating the restore as successful.
  if (!canReadExistingData(tempConn)) {
    tempConn.close();
    unlinkSync(tempPath);
    throw new Error("Unable to restore this backup: wrong passphrase, or the file is corrupted");
  }
  tempConn.pragma("journal_mode = DELETE");
  tempConn.pragma(`rekey=${hexKeyLiteral(appEncryptionKeyHex)}`);
  tempConn.pragma("journal_mode = WAL");
  tempConn.close();

  if (existsSync(destDbPath)) unlinkSync(destDbPath);
  renameSync(tempPath, destDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${destDbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
}
