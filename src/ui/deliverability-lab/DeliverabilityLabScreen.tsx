import { useEffect, useState } from "react";
import type { AccountSummary, LabAnalysisResponse } from "../../ipc-boundary/contracts.js";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Field,
  FlaskIcon,
  Input,
  PageHeader,
  Select,
  SeverityBadge,
  Spinner,
  Textarea
} from "../components/index.js";
import { humanizeSnakeCase } from "../lib/format.js";

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
  const [loadingAccounts, setLoadingAccounts] = useState(true);
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

  const scoreTone: BadgeTone = result ? (result.score >= 85 ? "success" : result.score >= 60 ? "warning" : "danger") : "neutral";

  return (
    <div>
      <PageHeader
        title="Deliverability Lab"
        description="Test a hypothetical message before you write it for real. Nothing here is saved, queued, or sent."
      />

      {error && <ErrorBanner message={error} />}

      {loadingAccounts ? (
        <Card>
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-6)" }}>
            <Spinner size={22} />
          </div>
        </Card>
      ) : accounts.length === 0 ? (
        <Card padding="none">
          <EmptyState icon={<FlaskIcon size={20} />} title="No accounts connected yet" description="Connect a sending account from the Compose screen first." />
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-6)", alignItems: "start" }}>
          <Card>
            <CardHeader title="Hypothetical message" />
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              <Field label="From (borrowed identity — never authenticated or sent from)">
                <Select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sample recipient(s)">
                <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="sample@example.com" />
              </Field>
              <Field label="Subject">
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
              </Field>
              <Field label="Body">
                <Textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a hypothetical message..." />
              </Field>
              <Checkbox checked={checkDomainAuth} onChange={setCheckDomainAuth} label="Also check SPF/DKIM/DMARC for the selected account's domain" />
              <Button variant="primary" loading={busy} onClick={handleRunAnalysis}>
                Run analysis
              </Button>
            </div>
          </Card>

          <Card padding="none">
            <div style={{ padding: "var(--space-6) var(--space-6) 0" }}>
              <CardHeader
                title="Result"
                actions={result ? <Badge tone={scoreTone}>Score {result.score}</Badge> : undefined}
              />
            </div>
            {!result ? (
              <EmptyState icon={<FlaskIcon size={20} />} title="No analysis yet" description="Run an analysis to see the deliverability score and findings." />
            ) : result.findings.length === 0 ? (
              <EmptyState icon={<FlaskIcon size={20} />} title="No issues found" description="This hypothetical message looks clean." />
            ) : (
              <div style={{ paddingBottom: "var(--space-2)" }}>
                {result.findings.map((f, i) => (
                  <div key={`${f.ruleId}-${i}`} style={{ padding: "var(--space-4) var(--space-6)", borderTop: i === 0 ? "1px solid var(--color-border)" : "1px solid var(--color-border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "4px", flexWrap: "wrap" }}>
                      <SeverityBadge severity={f.severity} />
                      <Badge tone="neutral">{humanizeSnakeCase(f.category)}</Badge>
                    </div>
                    <p style={{ fontSize: "13.5px", fontWeight: 600 }}>{f.message}</p>
                    <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{f.explanation}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
