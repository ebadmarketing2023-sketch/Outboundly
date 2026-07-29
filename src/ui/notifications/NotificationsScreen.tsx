import { useEffect, useState } from "react";
import type { NotificationSummary } from "../../ipc-boundary/contracts.js";
import { Badge, BellIcon, Button, Card, CheckIcon, EmptyState, ErrorBanner, PageHeader, SeverityBadge, Spinner, useToast } from "../components/index.js";
import { formatDateTime, humanizeSnakeCase } from "../lib/format.js";

/**
 * The Phase 5 "minimal" Notifications module (Section 3): "Surface in-app alerts (reply arrived,
 * campaign paused, account health issue) ... most domain events." A manual-refresh feed, since
 * there's no live push mechanism between the main and renderer processes yet -- each screen that
 * triggers a notification-worthy action (inbox sync, a send worker tick, an account health check)
 * already writes to the same notifications table this refresh reads from.
 */
export function NotificationsScreen(): JSX.Element {
  const [notifications, setNotifications] = useState<NotificationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function refresh(showSpinner: boolean): void {
    if (showSpinner) setLoading(true);
    window.outboundly
      .listUnreadNotifications()
      .then((list) => {
        setNotifications(list);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh(true);
  }, []);

  async function handleMarkRead(notificationId: string): Promise<void> {
    try {
      await window.outboundly.markNotificationRead({ notificationId });
      refresh(false);
    } catch (err) {
      toast.showToast(String(err), "error");
    }
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="In-app alerts for replies, delivery failures, and account health issues."
        actions={
          <Button variant="secondary" size="sm" onClick={() => refresh(false)}>
            Refresh
          </Button>
        }
      />

      {error && <ErrorBanner message={error} />}

      <Card padding="none">
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-10)" }}>
            <Spinner size={22} />
          </div>
        ) : notifications.length === 0 ? (
          <EmptyState
            icon={<BellIcon size={20} />}
            title="You're all caught up"
            description="New replies, send failures, and account health issues will show up here as they happen."
          />
        ) : (
          <div>
            {notifications.map((n, i) => (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "var(--space-4)",
                  padding: "var(--space-4) var(--space-5)",
                  borderTop: i === 0 ? undefined : "1px solid var(--color-border)"
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "4px" }}>
                    <SeverityBadge severity={n.severity} />
                    <Badge tone="neutral">{humanizeSnakeCase(n.notificationType)}</Badge>
                  </div>
                  <p style={{ fontSize: "13.5px", color: "var(--color-text-primary)" }}>{n.message}</p>
                  <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginTop: "3px" }}>
                    {formatDateTime(n.createdAt)}
                  </p>
                </div>
                <Button variant="ghost" size="sm" icon={<CheckIcon size={14} />} onClick={() => handleMarkRead(n.id)}>
                  Mark read
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
