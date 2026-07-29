import { useEffect, useState } from "react";
import type { AccountSummary, MessageSummary, ThreadSummary } from "../../ipc-boundary/contracts.js";
import {
  AccountStatusBadge,
  ArchiveIcon,
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  InboxIcon,
  RefreshIcon,
  Select,
  Spinner,
  StarIcon,
  useToast
} from "../components/index.js";
import { formatDateTime } from "../lib/format.js";

const CONVERSATION_STATE_TONE: Record<string, BadgeTone> = {
  active: "success",
  awaiting_reply: "warning",
  stale: "neutral",
  closed: "neutral"
};

/**
 * The Phase 2 "minimal" Unified Inbox (Section 11.4): lists threads for one account, shows a
 * thread's messages, and a manual "Sync now" button. No background Sync worker yet (Section
 * 21 — that's Phase 4) and no snooze/search yet — this exists to prove the Conversation Engine
 * round-trip end to end, not to be the final inbox experience.
 */
export function InboxScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  useEffect(() => {
    window.outboundly
      .listAccounts()
      .then((list) => {
        setAccounts(list);
        if (list.length > 0 && !selectedAccountId) setSelectedAccountId(list[0]!.id);
      })
      .catch((err) => setError(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadThreads(accountId: string): Promise<void> {
    const list = await window.outboundly.listThreads({ accountId });
    setThreads(list);
  }

  useEffect(() => {
    if (!selectedAccountId) return;
    setLoadingThreads(true);
    setSelectedThreadId(null);
    setMessages([]);
    loadThreads(selectedAccountId)
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingThreads(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId]);

  async function handleSync(): Promise<void> {
    if (!selectedAccountId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.outboundly.syncInbox({ accountId: selectedAccountId });
      const failedNote = result.failedCount > 0 ? `, ${result.failedCount} failed to sync` : "";
      const bounceNote = result.bouncesDetected > 0 ? `, ${result.bouncesDetected} bounce(s)` : "";
      toast.showToast(`${result.newMessageCount} new message(s), ${result.repliesDetected} repl(y/ies)${bounceNote}${failedNote}.`, "success");
      await loadThreads(selectedAccountId);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenThread(threadId: string): Promise<void> {
    setSelectedThreadId(threadId);
    setError(null);
    try {
      const list = await window.outboundly.getThreadMessages({ threadId });
      setMessages(list);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleArchive(threadId: string): Promise<void> {
    try {
      await window.outboundly.setThreadArchived({ threadId, archived: true });
      if (selectedThreadId === threadId) setSelectedThreadId(null);
      await loadThreads(selectedAccountId);
    } catch (err) {
      toast.showToast(String(err), "error");
    }
  }

  async function handleStar(messageId: string, starred: boolean): Promise<void> {
    try {
      await window.outboundly.setMessageStarred({ messageId, starred });
      if (selectedThreadId) await handleOpenThread(selectedThreadId);
    } catch (err) {
      toast.showToast(String(err), "error");
    }
  }

  async function handleLabelReply(messageId: string, classification: "interested" | "not_interested" | "out_of_office"): Promise<void> {
    try {
      await window.outboundly.setReplyClassification({ messageId, classification });
      toast.showToast("Reply labeled.", "success");
    } catch (err) {
      toast.showToast(String(err), "error");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 2 * var(--space-8))" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-5)", flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: "20px", fontWeight: 650, letterSpacing: "-0.01em" }}>Inbox</h1>
          <p style={{ marginTop: "4px", fontSize: "13.5px", color: "var(--color-text-secondary)" }}>Read and reply across your connected accounts.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} style={{ minWidth: 220 }}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
                {a.status === "reauth_required" ? " (reconnect needed)" : ""}
              </option>
            ))}
          </Select>
          {selectedAccount && selectedAccount.status !== "connected" && <AccountStatusBadge status={selectedAccount.status} />}
          <Button variant="primary" icon={<RefreshIcon size={15} />} loading={busy} disabled={!selectedAccountId} onClick={handleSync}>
            Sync now
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      <div style={{ display: "flex", gap: "var(--space-5)", flex: 1, minHeight: 0 }}>
        <Card padding="none" style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "var(--space-4) var(--space-5)", borderBottom: "1px solid var(--color-border)", fontSize: "12.5px", fontWeight: 600, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
            Threads ({threads.length})
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {loadingThreads ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-8)" }}>
                <Spinner size={20} />
              </div>
            ) : threads.length === 0 ? (
              <EmptyState icon={<InboxIcon size={18} />} title="No threads yet" description="Try Sync now to fetch mail." />
            ) : (
              threads.map((t) => (
                <div
                  key={t.id}
                  onClick={() => handleOpenThread(t.id)}
                  style={{
                    padding: "var(--space-3) var(--space-5)",
                    borderBottom: "1px solid var(--color-border)",
                    cursor: "pointer",
                    background: selectedThreadId === t.id ? "var(--color-primary-light)" : undefined
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                    <span className="ob-truncate" style={{ fontSize: "13.5px", fontWeight: 600 }}>
                      {t.subjectNormalized || "(no subject)"}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<ArchiveIcon size={13} />}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleArchive(t.id);
                      }}
                      style={{ padding: "3px 6px" }}
                    />
                  </div>
                  <Badge tone={CONVERSATION_STATE_TONE[t.conversationState] ?? "neutral"}>{t.conversationState.replace("_", " ")}</Badge>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card padding="none" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "var(--space-5)" }}>
            {!selectedThreadId ? (
              <EmptyState icon={<InboxIcon size={20} />} title="Select a thread" description="Choose a conversation from the list to read it." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {messages.map((m) => (
                  <div key={m.id} style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--space-4)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", marginBottom: "6px" }}>
                      <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)" }}>
                        <strong style={{ color: "var(--color-text-primary)" }}>{m.direction === "outbound" ? "You" : m.fromAddress}</strong>
                        {" → "}
                        {m.toAddresses.join(", ")}
                        {" · "}
                        {formatDateTime(m.sentAt ?? m.receivedAt)}
                      </div>
                      <button
                        onClick={() => handleStar(m.id, !m.starred)}
                        aria-label={m.starred ? "Unstar" : "Star"}
                        style={{ border: "none", background: "transparent", cursor: "pointer", color: m.starred ? "#f79009" : "var(--color-text-tertiary)", display: "flex" }}
                      >
                        <StarIcon size={16} filled={m.starred} />
                      </button>
                    </div>
                    <p style={{ fontSize: "13.5px", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{m.bodyText}</p>
                    {m.direction === "inbound" && (
                      <div style={{ display: "flex", gap: "0.4rem", marginTop: "var(--space-3)" }}>
                        <Button variant="secondary" size="sm" onClick={() => handleLabelReply(m.id, "interested")}>
                          Interested
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => handleLabelReply(m.id, "not_interested")}>
                          Not interested
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => handleLabelReply(m.id, "out_of_office")}>
                          Out of office
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
