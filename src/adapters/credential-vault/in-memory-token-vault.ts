import type { AccountId } from "../../core/shared-kernel/ids.js";
import type { TokenVault } from "../../ports/token-vault.port.js";

/**
 * Test/dev-only TokenVault implementation. NOT used by the production Electron app (Section 23
 * requires OS-native storage) — this exists purely so unit/integration tests and headless
 * development environments without a working OS keychain can exercise the OAuth and provider
 * adapter code paths without real secret storage.
 */
export class InMemoryTokenVault implements TokenVault {
  private readonly entries = new Map<AccountId, string>();

  async store(accountId: AccountId, payload: string): Promise<void> {
    this.entries.set(accountId, payload);
  }

  async retrieve(accountId: AccountId): Promise<string | undefined> {
    return this.entries.get(accountId);
  }

  async delete(accountId: AccountId): Promise<void> {
    this.entries.delete(accountId);
  }
}
