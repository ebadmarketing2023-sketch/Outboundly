import type { AccountId } from "../core/shared-kernel/ids.js";

/**
 * OAuth token material never touches the SQL database (Section 23) — it lives exclusively
 * behind this port, backed by the OS-native credential store (Keychain / Credential Manager /
 * Secret Service). The database only ever stores the opaque reference this port hands back.
 *
 * The vault stores an opaque string payload per account, not a fixed {accessToken, refreshToken,
 * expiresAt} shape. That shape fit Google (google-auth-library exposes a plain refresh-token
 * string), but Microsoft's MSAL library manages its own internal token cache and exposes no raw
 * refresh token at all — the only thing to persist is MSAL's own serialized cache blob, via its
 * ICachePlugin mechanism (verified against @azure/msal-common's ICachePlugin/TokenCacheContext
 * types). Each provider adapter owns its own serialization format against this generic store:
 * Google JSON-encodes its StoredTokens shape; Microsoft hands MSAL's cache serialize()/
 * deserialize() output through unchanged.
 */
export interface TokenVault {
  store(accountId: AccountId, payload: string): Promise<void>;
  retrieve(accountId: AccountId): Promise<string | undefined>;
  delete(accountId: AccountId): Promise<void>;
}

/** Google's own token shape, JSON-encoded before being handed to the generic TokenVault. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}
