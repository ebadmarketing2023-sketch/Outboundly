import type { AccountId } from "../core/shared-kernel/ids.js";

export type AccountStatus = "connected" | "reauth_required" | "disconnected";

export interface AccountDirectoryEntry {
  id: AccountId;
  provider: "google" | "microsoft" | "smtp_imap";
  emailAddress: string;
  status: AccountStatus;
}

/** Read/status-write access to the accounts table (Section 13.3), scoped to exactly what the
 * Account Health sweep needs: enumerate accounts to check, and record what a live check found. */
export interface AccountDirectory {
  list(): Promise<AccountDirectoryEntry[]>;
  updateStatus(accountId: AccountId, status: AccountStatus): Promise<void>;
}
