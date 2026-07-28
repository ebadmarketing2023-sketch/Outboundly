import { useEffect, useState } from "react";
import type { NotificationSummary } from "../../ipc-boundary/contracts.js";

const SEVERITY_COLOR: Record<string, string> = { info: "#555", warning: "#a67c00", critical: "crimson" };

/**
 * The Phase 5 "minimal" Notifications module (Section 3): "Surface in-app alerts (reply arrived,
 * campaign paused, account health issue) ... most domain events." A manual-refresh feed, since
 * there's no live push mechanism between the main and renderer processes yet -- each screen that
 * triggers a notification-worthy action (inbox sync, a send worker tick, an account health check)
 * already refreshes this screen's data indirectly by writing to the same notifications table.
 */
export function NotificationsScreen(): JSX.Element {
  const [notifications, setNotifications] = useState<NotificationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh(): void {
    window.outboundly.listUnreadNotifications().then(setNotifications).catch((err) => setError(String(err)));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleMarkRead(notificationId: string): Promise<void> {
    try {
      await window.outboundly.markNotificationRead({ notificationId });
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 700, margin: "2rem auto" }}>
      <h1>Outboundly — Notifications (Phase 5)</h1>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      <button onClick={refresh} style={{ marginBottom: "1rem" }}>
        Refresh
      </button>

      {notifications.length === 0 && <p>No unread notifications.</p>}
      {notifications.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {notifications.map((n) => (
            <li key={n.id} style={{ border: "1px solid #ddd", padding: "0.75rem", marginBottom: "0.5rem" }}>
              <strong style={{ color: SEVERITY_COLOR[n.severity] ?? "#555" }}>
                [{n.severity}] {n.message}
              </strong>
              <div style={{ fontSize: "0.8rem", color: "#666" }}>
                {n.notificationType} — {n.createdAt}
              </div>
              <button onClick={() => handleMarkRead(n.id)} style={{ marginTop: "0.25rem" }}>
                Mark read
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
