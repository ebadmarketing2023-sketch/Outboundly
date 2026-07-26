import type { AccountId } from "../core/shared-kernel/ids.js";

/**
 * OAuth token material never touches the SQL database (Section 23) — it lives exclusively
 * behind this port, backed by the OS-native credential store (Keychain / Credential Manager /
 * Secret Service). The database only ever stores the opaque reference this port hands back.
 */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface TokenVault {
  store(accountId: AccountId, tokens: StoredTokens): Promise<void>;
  retrieve(accountId: AccountId): Promise<StoredTokens | undefined>;
  delete(accountId: AccountId): Promise<void>;
}
