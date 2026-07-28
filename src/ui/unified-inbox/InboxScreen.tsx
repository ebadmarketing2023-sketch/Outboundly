import { useEffect, useState } from "react";
import type { AccountSummary, MessageSummary, ThreadSummary } from "../../ipc-boundary/contracts.js";

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
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    loadThreads(selectedAccountId).catch((err) => setError(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId]);

  async function handleSync(): Promise<void> {
    if (!selectedAccountId) return;
    setBusy(true);
    setError(null);
    setSyncSummary(null);
    try {
      const result = await window.outboundly.syncInbox({ accountId: selectedAccountId });
      const failedNote = result.failedCount > 0 ? `, ${result.failedCount} message(s) failed to sync` : "";
      const bounceNote = result.bouncesDetected > 0 ? `, ${result.bouncesDetected} bounce(s) detected` : "";
      setSyncSummary(
        `${result.newMessageCount} new message(s), ${result.repliesDetected} reply/replies detected${bounceNote}${failedNote}`
      );
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

  async function handleArchive(threadId: string, archived: boolean): Promise<void> {
    try {
      await window.outboundly.setThreadArchived({ threadId, archived });
      if (selectedThreadId === threadId) setSelectedThreadId(null);
      await loadThreads(selectedAccountId);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleStar(messageId: string, starred: boolean): Promise<void> {
    try {
      await window.outboundly.setMessageStarred({ messageId, starred });
      if (selectedThreadId) await handleOpenThread(selectedThreadId);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 800, margin: "2rem auto" }}>
      <h1>Outboundly — Unified Inbox (Phase 2)</h1>

      <section style={{ marginBottom: "1rem" }}>
        <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
            </option>
          ))}
        </select>
        <button onClick={handleSync} disabled={busy || !selectedAccountId} style={{ marginLeft: "0.5rem" }}>
          Sync now
        </button>
        {syncSummary && <span style={{ marginLeft: "0.75rem", color: "#555" }}>{syncSummary}</span>}
      </section>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      <div style={{ display: "flex", gap: "1.5rem" }}>
        <div style={{ flex: "0 0 320px" }}>
          <h2>Threads</h2>
          {threads.length === 0 && <p>No threads yet — try Sync now.</p>}
          <ul style={{ listStyle: "none", padding: 0 }}>
            {threads.map((t) => (
              <li
                key={t.id}
                style={{
                  padding: "0.5rem",
                  border: "1px solid #ddd",
                  marginBottom: "0.25rem",
                  cursor: "pointer",
                  background: selectedThreadId === t.id ? "#eef" : undefined
                }}
              >
                <div onClick={() => handleOpenThread(t.id)}>
                  <strong>{t.subjectNormalized || "(no subject)"}</strong>
                  <div style={{ fontSize: "0.8rem", color: "#666" }}>{t.conversationState}</div>
                </div>
                <button onClick={() => handleArchive(t.id, true)} style={{ marginTop: "0.25rem" }}>
                  Archive
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ flex: 1 }}>
          <h2>Conversation</h2>
          {!selectedThreadId && <p>Select a thread to view its messages.</p>}
          {messages.map((m) => (
            <div key={m.id} style={{ border: "1px solid #ddd", padding: "0.75rem", marginBottom: "0.5rem" }}>
              <div style={{ fontSize: "0.85rem", color: "#666" }}>
                <strong>{m.direction === "outbound" ? "You" : m.fromAddress}</strong> to {m.toAddresses.join(", ")}
                {" — "}
                {m.sentAt ?? m.receivedAt}
              </div>
              <div style={{ margin: "0.4rem 0" }}>{m.bodyText}</div>
              <button onClick={() => handleStar(m.id, !m.starred)}>{m.starred ? "Unstar" : "Star"}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
