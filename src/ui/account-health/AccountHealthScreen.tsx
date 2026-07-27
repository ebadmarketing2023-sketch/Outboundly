import { useEffect, useState } from "react";
import type { AccountHealthSnapshotSummary, AccountSummary } from "../../ipc-boundary/contracts.js";

/**
 * The Phase 3 "minimal" Account Health panel (Section 19): a manual-trigger view, since no
 * background Scheduler exists yet (Phase 4) to run this periodically. Exists to prove the engine
 * round-trip end to end — a real dashboard with trend history is Section 20.5, later.
 */
export function AccountHealthScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<AccountHealthSnapshotSummary | null>(null);
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

  useEffect(() => {
    if (!selectedAccountId) return;
    setSnapshot(null);
    window.outboundly
      .getLatestAccountHealth({ accountId: selectedAccountId })
      .then((result) => setSnapshot(result ?? null))
      .catch((err) => setError(String(err)));
  }, [selectedAccountId]);

  async function handleComputeSnapshot(): Promise<void> {
    if (!selectedAccountId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.outboundly.computeAccountHealth({ accountId: selectedAccountId });
      setSnapshot(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 700, margin: "2rem auto" }}>
      <h1>Outboundly — Account Health (Phase 3)</h1>

      <section style={{ marginBottom: "1rem" }}>
        <select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
            </option>
          ))}
        </select>
        <button onClick={handleComputeSnapshot} disabled={busy || !selectedAccountId} style={{ marginLeft: "0.5rem" }}>
          {busy ? "Checking..." : "Check health now"}
        </button>
      </section>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      {!snapshot && !error && <p>No health check has been run for this account yet.</p>}

      {snapshot && (
        <section>
          <p style={{ color: "#555" }}>Last checked: {snapshot.capturedAt}</p>
          <h2>
            Health score: {snapshot.healthScore} —{" "}
            <span
              style={{
                color:
                  snapshot.riskLevel === "healthy"
                    ? "green"
                    : snapshot.riskLevel === "watch"
                      ? "#a67c00"
                      : "crimson"
              }}
            >
              {snapshot.riskLevel}
            </span>
          </h2>

          <ul style={{ color: "#555" }}>
            <li>Account age: {snapshot.accountAgeDays} day(s)</li>
            <li>Sends: {snapshot.sendsLast24h} in the last 24h, {snapshot.sendsLast7d} in the last 7 days</li>
            <li>Reply rate: {snapshot.replyRate !== undefined ? `${Math.round(snapshot.replyRate * 100)}%` : "not enough data yet"}</li>
            <li>
              Sending consistency:{" "}
              {snapshot.sendingConsistencyScore !== undefined ? snapshot.sendingConsistencyScore : "not enough data yet"}
            </li>
            <li>
              SPF: {snapshot.spfStatus} / DKIM: {snapshot.dkimStatus} / DMARC: {snapshot.dmarcStatus}
            </li>
          </ul>

          {snapshot.findings.length === 0 && <p>No issues found.</p>}
          {snapshot.findings.length > 0 && (
            <ul>
              {snapshot.findings.map((f, i) => (
                <li key={`${f.findingType}-${i}`}>
                  <strong>[{f.severity}] {f.message}</strong>
                  <div>{f.explanation}</div>
                  {f.recommendedAction && <div><em>Recommendation: {f.recommendedAction}</em></div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
