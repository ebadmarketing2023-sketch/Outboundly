import { useEffect, useState } from "react";
import type {
  AccountSummary,
  DraftSummary,
  SendDraftResponse
} from "../../ipc-boundary/contracts.js";

/**
 * The Phase 1 "minimal" compose UI (Task 9): plain To/Subject/Body fields exercising the real
 * pipeline end-to-end (Draft Lifecycle -> Rendering -> MIME -> Gmail Compatibility Layer ->
 * Gmail send). A rich Tiptap-based editor (Section 22) is a later increment — this screen exists
 * to validate the pipeline, not to be the final compose experience.
 */
export function ComposeScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  const [sendResult, setSendResult] = useState<SendDraftResponse | null>(null);
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

  async function handleConnectGoogle(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const account = await window.outboundly.connectGoogleAccount();
      setAccounts((prev) => [...prev, account]);
      setSelectedAccountId(account.id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDraft(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const toList = to
        .split(",")
        .map((addr) => addr.trim())
        .filter(Boolean);

      if (draft) {
        const updated = await window.outboundly.autosaveDraft({ draftId: draft.id, subject, body });
        setDraft(updated);
      } else {
        const created = await window.outboundly.createDraft({
          accountId: selectedAccountId,
          subject,
          to: toList,
          body
        });
        setDraft(created);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSend(): Promise<void> {
    if (!draft) {
      setError("Save the draft before sending.");
      return;
    }
    setError(null);
    setBusy(true);
    setSendResult(null);
    try {
      const result = await window.outboundly.sendDraft({ draftId: draft.id });
      setSendResult(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "2rem auto" }}>
      <h1>Outboundly — Compose (Phase 1)</h1>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Account</h2>
        {accounts.length === 0 && <p>No connected accounts yet.</p>}
        <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
            </option>
          ))}
        </select>
        <button onClick={handleConnectGoogle} disabled={busy} style={{ marginLeft: "0.5rem" }}>
          Sign in with Google
        </button>
      </section>

      <section>
        <h2>Message</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <input placeholder="To" value={to} onChange={(e) => setTo(e.target.value)} />
          <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea
            placeholder="Write your message..."
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div style={{ marginTop: "0.75rem" }}>
          <button onClick={handleSaveDraft} disabled={busy || !selectedAccountId}>
            {draft ? "Save draft" : "Create draft"}
          </button>
          <button onClick={handleSend} disabled={busy || !draft} style={{ marginLeft: "0.5rem" }}>
            Send
          </button>
        </div>
      </section>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      {draft && (
        <p style={{ color: "#555" }}>
          Draft saved (autosave v{draft.autosaveVersion}, {draft.lastSavedAt})
        </p>
      )}

      {sendResult && (
        <section>
          <h2>Result</h2>
          <p>{sendResult.sent ? `Sent — provider message id ${sendResult.providerMessageId}` : "Blocked before sending"}</p>
          <p>Gmail Compatibility score: {sendResult.compatibilityReport.score}</p>
          {sendResult.compatibilityReport.findings.length > 0 && (
            <ul>
              {sendResult.compatibilityReport.findings.map((f) => (
                <li key={f.ruleId}>
                  <strong>[{f.severity}] {f.message}</strong>
                  <div>{f.explanation}</div>
                  <div><em>Fix: {f.recommendedFix}</em></div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
