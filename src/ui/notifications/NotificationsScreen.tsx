import { useEffect, useState } from "react";
import type { ErrorLogEntrySummary, NotificationSummary } from "../../ipc-boundary/contracts.js";
import {
  Badge,
  BellIcon,
  Button,
  Card,
  CheckIcon,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Select,
  SeverityBadge,
  Spinner,
  Table,
  TableRow,
  Tabs,
  Td,
  Th,
  useToast
} from "../components/index.js";
import { formatDateTime, humanizeSnakeCase } from "../lib/format.js";

type SectionKey = "notifications" | "logs";

const LOG_SOURCES = ["send-worker", "scheduler", "inbox-sync", "account-health-sweep"] as const;

/**
 * The Phase 5 "minimal" Notifications module (Section 3): "Surface in-app alerts (reply arrived,
 * campaign paused, account health issue) ... most domain events." A manual-refresh feed, since
 * there's no live push mechanism between the main and renderer processes yet -- each screen that
 * triggers a notification-worthy action (inbox sync, a send worker tick, an account health check)
 * already writes to the same notifications table this refresh reads from.
 *
 * The "Logs" tab (Critical Improvement #12) is a separate, complete diagnostic trail rather than
 * the curated/dismissible Notifications feed -- every background worker's per-item failure, with
 * exactly the context needed to troubleshoot it, searchable by source.
 */
export function NotificationsScreen(): JSX.Element {
  const [section, setSection] = useState<SectionKey>("notifications");
  const [notifications, setNotifications] = useState<NotificationSummary[]>([]);
  const [logs, setLogs] = useState<ErrorLogEntrySummary[]>([]);
  const [logSourceFilter, setLogSourceFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(true);
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

  function refreshLogs(showSpinner: boolean): void {
    if (showSpinner) setLogsLoading(true);
    window.outboundly
      .listErrorLogs({ limit: 100, source: logSourceFilter || undefined })
      .then((list) => {
        setLogs(list);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLogsLoading(false));
  }

  useEffect(() => {
    refresh(true);
  }, []);

  useEffect(() => {
    if (section === "logs") refreshLogs(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, logSourceFilter]);

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
        description="In-app alerts for replies, delivery failures, and account health issues, plus a searchable error log for troubleshooting."
        actions={
          <Button variant="secondary" size="sm" onClick={() => (section === "logs" ? refreshLogs(false) : refresh(false))}>
            Refresh
          </Button>
        }
      />

      <Tabs
        items={[
          { key: "notifications", label: "Notifications", count: notifications.length },
          { key: "logs", label: "Logs" }
        ]}
        active={section}
        onChange={(key) => setSection(key as SectionKey)}
      />

      {error && <ErrorBanner message={error} />}

      {section === "notifications" ? (
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
      ) : (
        <Card padding="none">
          <div style={{ padding: "var(--space-5) var(--space-5) 0", maxWidth: 240 }}>
            <Select value={logSourceFilter} onChange={(e) => setLogSourceFilter(e.target.value)}>
              <option value="">All sources</option>
              {LOG_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {humanizeSnakeCase(s.replace(/-/g, "_"))}
                </option>
              ))}
            </Select>
          </div>
          {logsLoading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-10)" }}>
              <Spinner size={22} />
            </div>
          ) : logs.length === 0 ? (
            <EmptyState
              icon={<BellIcon size={20} />}
              title="No errors logged"
              description="Failures from the send worker, scheduler, inbox sync, and account health sweep will show up here."
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <Table>
                <thead>
                  <tr>
                    <Th>Time</Th>
                    <Th>Source</Th>
                    <Th>Type</Th>
                    <Th>Message</Th>
                    <Th>Recipient</Th>
                    <Th align="right">Retries</Th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((entry) => (
                    <TableRow key={entry.id}>
                      <Td style={{ whiteSpace: "nowrap" }}>{formatDateTime(entry.occurredAt)}</Td>
                      <Td>
                        <Badge tone="neutral">{entry.source}</Badge>
                      </Td>
                      <Td>{humanizeSnakeCase(entry.errorType)}</Td>
                      <Td style={{ maxWidth: 360 }}>{entry.errorMessage}</Td>
                      <Td>{entry.recipientEmail ?? "—"}</Td>
                      <Td align="right">{entry.retryCount ?? "—"}</Td>
                    </TableRow>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
