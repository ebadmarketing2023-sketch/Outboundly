import { randomBytes } from "node:crypto";
import { Entry } from "@napi-rs/keyring";

const SERVICE_NAME = "Outboundly";
const ACCOUNT_NAME = "database-encryption-key";

/**
 * Whole-database at-rest encryption (Section 23): the SQLite file itself never has cleartext
 * content on disk once this key is applied via `openDatabase()`. The key is a random 256-bit
 * value, generated once per install and sealed in the OS-native credential store via
 * @napi-rs/keyring — the same mechanism NativeKeychainTokenVault already uses for OAuth tokens,
 * since a database encryption key needs identical protection (never in the SQL database itself,
 * never in plaintext on disk).
 *
 * Hex-encoded (not a passphrase) so it can be handed to SQLCipher's raw-key pragma format
 * directly, skipping PBKDF2 key derivation entirely — verified against a real
 * better-sqlite3-multiple-ciphers database round-trip (write, close, reopen with the same key,
 * reopen with a wrong key and confirm rejection).
 */
export function getOrCreateDatabaseEncryptionKey(): string {
  const entry = new Entry(SERVICE_NAME, ACCOUNT_NAME);

  let existing: string | undefined;
  try {
    existing = entry.getPassword() ?? undefined;
  } catch {
    existing = undefined;
  }
  if (existing) return existing;

  const key = randomBytes(32).toString("hex");
  entry.setPassword(key);
  return key;
}
