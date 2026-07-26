import type { AccountId } from "../../core/shared-kernel/ids.js";
import type { StoredTokens, TokenVault } from "../../ports/token-vault.port.js";

/**
 * Test/dev-only TokenVault implementation. NOT used by the production Electron app (Section 23
 * requires OS-native storage) — this exists purely so unit/integration tests and headless
 * development environments without a working OS keychain can exercise the OAuth and Gmail
 * adapter code paths without real secret storage.
 */
export class InMemoryTokenVault implements TokenVault {
  private readonly entries = new Map<AccountId, StoredTokens>();

  async store(accountId: AccountId, tokens: StoredTokens): Promise<void> {
    this.entries.set(accountId, tokens);
  }

  async retrieve(accountId: AccountId): Promise<StoredTokens | undefined> {
    return this.entries.get(accountId);
  }

  async delete(accountId: AccountId): Promise<void> {
    this.entries.delete(accountId);
  }
}
