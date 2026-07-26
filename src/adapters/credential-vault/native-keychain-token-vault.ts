import { Entry } from "@napi-rs/keyring";
import type { AccountId } from "../../core/shared-kernel/ids.js";
import type { StoredTokens, TokenVault } from "../../ports/token-vault.port.js";

const SERVICE_NAME = "Outboundly";

/**
 * OS-native credential store adapter (Section 23): macOS Keychain, Windows Credential Manager,
 * or Linux Secret Service, via @napi-rs/keyring. Token material never touches the SQL database —
 * only the opaque `provider_token_ref` (Section 5.1) does, and that ref is simply this account's ID.
 *
 * Requires a real desktop session with a working keychain/Secret Service. In a headless
 * environment (no D-Bus Secret Service, no display session) this throws at call time rather than
 * silently degrading to a less secure fallback — see the Phase 1 setup README for why there is no
 * automatic insecure fallback in the production code path.
 */
export class NativeKeychainTokenVault implements TokenVault {
  async store(accountId: AccountId, tokens: StoredTokens): Promise<void> {
    const entry = new Entry(SERVICE_NAME, accountId);
    entry.setPassword(JSON.stringify(tokens));
  }

  async retrieve(accountId: AccountId): Promise<StoredTokens | undefined> {
    const entry = new Entry(SERVICE_NAME, accountId);
    try {
      const raw = entry.getPassword();
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as StoredTokens & { expiresAt: string };
      return { ...parsed, expiresAt: new Date(parsed.expiresAt) };
    } catch {
      return undefined;
    }
  }

  async delete(accountId: AccountId): Promise<void> {
    const entry = new Entry(SERVICE_NAME, accountId);
    try {
      entry.deletePassword();
    } catch {
      // Nothing stored for this account — deletion is idempotent.
    }
  }
}
