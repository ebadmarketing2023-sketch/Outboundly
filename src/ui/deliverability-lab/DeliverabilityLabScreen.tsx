import { useEffect, useState } from "react";
import type { AccountSummary, LabAnalysisResponse } from "../../ipc-boundary/contracts.js";

/**
 * The Phase 3 "minimal" Deliverability Lab (Section 18): a sandbox to test a hypothetical
 * message with zero side effects — nothing is queued or sent, no account is authenticated to
 * build the message (only its display name/email/domain are borrowed as the hypothetical
 * "From"). No personalization-variable editor yet (Section 18.2's variable-resolution check is
 * implemented and tested at the engine level, but this minimal UI doesn't expose it) — a richer
 * editor is a later increment, matching how Compose's own IDM-based editor is still to come.
 */
export function DeliverabilityLabScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [to, setTo] = useState("sample@example.com");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [checkDomainAuth, setCheckDomainAuth] = useState(false);
  const [result, setResult] = useState<LabAnalysisResponse | null>(null);
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

  async function handleRunAnalysis(): Promise<void> {
    if (!selectedAccountId) {
      setError("Connect an account first — its email/domain is borrowed for the hypothetical From address.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const toList = to
        .split(",")
        .map((addr) => addr.trim())
        .filter(Boolean);
      const response = await window.outboundly.runLabAnalysis({
        subject,
        body,
        to: toList,
        accountId: selectedAccountId,
        checkDomainAuth
      });
      setResult(response);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 700, margin: "2rem auto" }}>
      <h1>Outboundly — Deliverability Lab (Phase 3)</h1>
      <p style={{ color: "#555" }}>
        Test a hypothetical message before you write it for real. Nothing here is saved as a draft,
        queued, or sent — this is a sandbox.
      </p>

      <section style={{ marginBottom: "1rem" }}>
        <label>
          From (borrowed identity, never authenticated or sent from):{" "}
          <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <input placeholder="Sample To (comma-separated)" value={to} onChange={(e) => setTo(e.target.value)} />
          <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea
            placeholder="Write a hypothetical message..."
            rows={10}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div style={{ marginTop: "0.5rem" }}>
          <label>
            <input type="checkbox" checked={checkDomainAuth} onChange={(e) => setCheckDomainAuth(e.target.checked)} />{" "}
            Also check SPF/DKIM/DMARC for the selected account's domain
          </label>
        </div>
        <div style={{ marginTop: "0.75rem" }}>
          <button onClick={handleRunAnalysis} disabled={busy}>
            {busy ? "Analyzing..." : "Run analysis"}
          </button>
        </div>
      </section>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      {result && (
        <section>
          <h2>Result</h2>
          <p>Score: {result.score}</p>
          {result.findings.length === 0 && <p>No issues found.</p>}
          {result.findings.length > 0 && (
            <ul>
              {result.findings.map((f, i) => (
                <li key={`${f.ruleId}-${i}`}>
                  <strong>[{f.severity}] [{f.category}] {f.message}</strong>
                  <div>{f.explanation}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
