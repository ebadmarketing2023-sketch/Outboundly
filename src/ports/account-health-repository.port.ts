import type { AccountHealthInput, AccountHealthResult } from "../core/account-health/types.js";
import type { AccountId } from "../core/shared-kernel/ids.js";

export interface AccountHealthSnapshotRecord {
  id: string;
  accountId: AccountId;
  capturedAt: Date;
  input: AccountHealthInput;
  result: AccountHealthResult;
}

export interface SaveAccountHealthSnapshotInput {
  accountId: AccountId;
  capturedAt: Date;
  input: AccountHealthInput;
  result: AccountHealthResult;
}

/** Persistence for Account Health Engine snapshots (Section 5.2, Section 19.3). */
export interface AccountHealthRepository {
  save(input: SaveAccountHealthSnapshotInput): Promise<string>;
  getLatest(accountId: AccountId): Promise<AccountHealthSnapshotRecord | undefined>;
}
