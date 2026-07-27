import { Entry } from "@napi-rs/keyring";
import type { AccountId } from "../../core/shared-kernel/ids.js";
import type { TokenVault } from "../../ports/token-vault.port.js";

const SERVICE_NAME = "Outboundly";

/**
 * OS-native credential store adapter (Section 23): macOS Keychain, Windows Credential Manager,
 * or Linux Secret Service, via @napi-rs/keyring. Token material never touches the SQL database —
 * only the opaque `provider_token_ref` (Section 5.1) does, and that ref is simply this account's ID.
 * Stores an opaque string payload per account; each provider adapter owns its own serialization
 * format (see token-vault.port.ts).
 *
 * Requires a real desktop session with a working keychain/Secret Service. In a headless
 * environment (no D-Bus Secret Service, no display session) this throws at call time rather than
 * silently degrading to a less secure fallback — see the Phase 1 setup README for why there is no
 * automatic insecure fallback in the production code path.
 */
export class NativeKeychainTokenVault implements TokenVault {
  async store(accountId: AccountId, payload: string): Promise<void> {
    const entry = new Entry(SERVICE_NAME, accountId);
    entry.setPassword(payload);
  }

  async retrieve(accountId: AccountId): Promise<string | undefined> {
    const entry = new Entry(SERVICE_NAME, accountId);
    try {
      return entry.getPassword() ?? undefined;
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
