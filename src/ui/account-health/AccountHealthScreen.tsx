import { useEffect, useState } from "react";
import type { AccountHealthSnapshotSummary, AccountSummary } from "../../ipc-boundary/contracts.js";
import {
  ActivityIcon,
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  RefreshIcon,
  Select,
  SeverityBadge,
  Spinner,
  StatCard
} from "../components/index.js";
import { formatDateTime } from "../lib/format.js";

const RISK_TONE: Record<string, BadgeTone> = {
  healthy: "success",
  watch: "info",
  at_risk: "warning",
  critical: "danger"
};

/**
 * The Phase 3 "minimal" Account Health panel (Section 19): a manual-trigger view, since no
 * background Scheduler exists yet (Phase 4) to run this periodically. Exists to prove the engine
 * round-trip end to end — a real dashboard with trend history is Section 20.5, later.
 */
export function AccountHealthScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<AccountHealthSnapshotSummary | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.outboundly
      .listAccounts()
      .then((list) => {
        setAccounts(list);
        if (list.length > 0 && !selectedAccountId) setSelectedAccountId(list[0]!.id);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingAccounts(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedAccountId) return;
    setLoadingSnapshot(true);
    window.outboundly
      .getLatestAccountHealth({ accountId: selectedAccountId })
      .then((result) => setSnapshot(result ?? null))
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingSnapshot(false));
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
    <div>
      <PageHeader title="Account Health" description="Reply rate, sending consistency, and domain authentication for each connected account." />

      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "var(--space-6)" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)" }}>
          <div style={{ flex: 1, maxWidth: 360 }}>
            <Field label="Account">
              <Select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} disabled={loadingAccounts}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button variant="primary" icon={<RefreshIcon size={15} />} loading={busy} disabled={!selectedAccountId} onClick={handleComputeSnapshot}>
            Check health now
          </Button>
        </div>
      </Card>

      {loadingAccounts ? (
        <Card>
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-6)" }}>
            <Spinner size={22} />
          </div>
        </Card>
      ) : accounts.length === 0 ? (
        <Card padding="none">
          <EmptyState icon={<ActivityIcon size={20} />} title="No accounts connected yet" description="Connect a sending account from the Compose screen first." />
        </Card>
      ) : loadingSnapshot ? (
        <Card>
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-6)" }}>
            <Spinner size={22} />
          </div>
        </Card>
      ) : !snapshot ? (
        <Card padding="none">
          <EmptyState
            icon={<ActivityIcon size={20} />}
            title="No health check yet"
            description="Run a health check to see this account's score, risk level, and any findings."
          />
        </Card>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--space-4)", marginBottom: "var(--space-6)" }}>
            <StatCard label="Health score" value={snapshot.healthScore} hint={<Badge tone={RISK_TONE[snapshot.riskLevel] ?? "neutral"}>{snapshot.riskLevel}</Badge>} />
            <StatCard label="Sends (24h)" value={snapshot.sendsLast24h} />
            <StatCard label="Sends (7d)" value={snapshot.sendsLast7d} />
            <StatCard label="Account age" value={`${snapshot.accountAgeDays}d`} />
            <StatCard label="Reply rate" value={snapshot.replyRate !== undefined ? `${Math.round(snapshot.replyRate * 100)}%` : "—"} hint={snapshot.replyRate === undefined ? "Not enough data yet" : undefined} />
            <StatCard
              label="Sending consistency"
              value={snapshot.sendingConsistencyScore ?? "—"}
              hint={snapshot.sendingConsistencyScore === undefined ? "Not enough data yet" : undefined}
            />
          </div>

          <Card style={{ marginBottom: "var(--space-6)" }}>
            <CardHeader title="Domain authentication" description={`Last checked ${formatDateTime(snapshot.capturedAt)}`} />
            <div style={{ display: "flex", gap: "var(--space-6)" }}>
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginBottom: "4px" }}>SPF</div>
                <Badge tone={snapshot.spfStatus === "pass" ? "success" : "warning"}>{snapshot.spfStatus}</Badge>
              </div>
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginBottom: "4px" }}>DKIM</div>
                <Badge tone={snapshot.dkimStatus === "pass" ? "success" : "warning"}>{snapshot.dkimStatus}</Badge>
              </div>
              <div>
                <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginBottom: "4px" }}>DMARC</div>
                <Badge tone={snapshot.dmarcStatus === "pass" ? "success" : "info"}>{snapshot.dmarcStatus}</Badge>
              </div>
            </div>
          </Card>

          <Card padding="none">
            <div style={{ padding: "var(--space-5) var(--space-5) 0" }}>
              <CardHeader title={`Findings (${snapshot.findings.length})`} />
            </div>
            {snapshot.findings.length === 0 ? (
              <EmptyState icon={<ActivityIcon size={20} />} title="No issues found" description="This account looks healthy." />
            ) : (
              <div>
                {snapshot.findings.map((f, i) => (
                  <div key={`${f.findingType}-${i}`} style={{ padding: "var(--space-4) var(--space-5)", borderTop: i === 0 ? undefined : "1px solid var(--color-border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "4px" }}>
                      <SeverityBadge severity={f.severity} />
                      <span style={{ fontSize: "13.5px", fontWeight: 600 }}>{f.message}</span>
                    </div>
                    <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{f.explanation}</p>
                    {f.recommendedAction && (
                      <p style={{ fontSize: "13px", color: "var(--color-text-primary)", marginTop: "4px" }}>
                        <strong>Recommendation:</strong> {f.recommendedAction}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
