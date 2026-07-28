import type { AccountId, CampaignId, NotificationId } from "../core/shared-kernel/ids.js";

export type NotificationType = "reply_arrived" | "send_failure" | "account_health_issue";
export type NotificationSeverity = "info" | "warning" | "critical";

export interface RecordNotificationInput {
  notificationType: NotificationType;
  severity: NotificationSeverity;
  message: string;
  relatedAccountId?: AccountId;
  relatedCampaignId?: CampaignId;
  createdAt: Date;
}

export interface NotificationRecord extends RecordNotificationInput {
  id: NotificationId;
  readAt?: Date;
}

/** Notifications module (Section 3): "Surface in-app alerts ... most domain events." A thin
 * persistence port, not an engine -- there's no rule registry here, just a record of what already
 * happened elsewhere (reply detected, send failed permanently, account health degraded). */
export interface NotificationRepository {
  record(input: RecordNotificationInput): Promise<NotificationRecord>;
  /** Unread notifications, newest first -- the in-app alert feed. */
  findUnread(limit: number): Promise<NotificationRecord[]>;
  markRead(id: NotificationId): Promise<void>;
}
