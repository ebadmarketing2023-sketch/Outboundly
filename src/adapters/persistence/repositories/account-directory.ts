import { eq } from "drizzle-orm";
import { asAccountId } from "../../../core/shared-kernel/ids.js";
import type { AccountDirectory, AccountDirectoryEntry, AccountStatus } from "../../../ports/account-directory.port.js";
import type { OutboundlyDb } from "../db.js";
import { accounts } from "../schema.js";

/** SQLite-backed implementation of AccountDirectory (Section 13.3). */
export class SqliteAccountDirectory implements AccountDirectory {
  constructor(private readonly db: OutboundlyDb) {}

  async list(): Promise<AccountDirectoryEntry[]> {
    const rows = this.db.select().from(accounts).all();
    return rows.map((row) => ({
      id: asAccountId(row.id),
      provider: row.provider as AccountDirectoryEntry["provider"],
      emailAddress: row.emailAddress,
      status: row.status as AccountStatus
    }));
  }

  async updateStatus(accountId: string, status: AccountStatus): Promise<void> {
    this.db.update(accounts).set({ status, updatedAt: new Date() }).where(eq(accounts.id, accountId)).run();
  }
}
