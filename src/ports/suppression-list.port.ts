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
  /** Un-suppresses an email so future campaign enrollments/sends are no longer blocked against
   * it. This is purely a local database change -- it does not touch any previously sent message,
   * header, or content, so it has no bearing on how any mailbox provider classifies mail (e.g.
   * Gmail's Promotions tab). A no-op if the email isn't currently suppressed. */
  remove(email: string): Promise<void>;
}
