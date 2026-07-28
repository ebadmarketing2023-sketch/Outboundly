export type SuppressionReason = "unsubscribed" | "bounced_hard" | "manual" | "complaint";

export interface SuppressionEntry {
  id: string;
  email: string;
  reason: SuppressionReason;
  createdAt: Date;
}

/** Suppression list persistence (Section 5.5) — emails that must never be enrolled or sent to,
 * checked by the Campaign Engine's enrollment logic (Section 14.2) before every send. */
export interface SuppressionListRepository {
  isSuppressed(email: string): Promise<boolean>;
  add(email: string, reason: SuppressionReason): Promise<void>;
  list(): Promise<SuppressionEntry[]>;
}
