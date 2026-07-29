import { useEffect, useState } from "react";
import type { CampaignAnalyticsSummary, CampaignSummary, InsightSummary } from "../../ipc-boundary/contracts.js";
import {
  BarChartIcon,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
  SeverityBadge,
  Spinner,
  StatCard,
  TargetIcon
} from "../components/index.js";
import { formatDateTime, formatPercent, humanizeSnakeCase } from "../lib/format.js";

/**
 * The Phase 5 "minimal" Analytics & Insights dashboard (Section 20.5): one campaign's primary
 * metrics (Section 20.2), per-step funnel, and stop-reason breakdown, plus the Insights Engine's
 * running feed (Section 20.3) across all campaigns/accounts. Both read only the already-
 * materialized rollup/insights tables — never the events log directly.
 */
export function AnalyticsScreen(): JSX.Element {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [analytics, setAnalytics] = useState<CampaignAnalyticsSummary | null>(null);
  const [insights, setInsights] = useState<InsightSummary[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refreshInsights(): void {
    window.outboundly.listActiveInsights().then(setInsights).catch((err) => setError(String(err)));
  }

  useEffect(() => {
    window.outboundly
      .listCampaigns()
      .then((list) => {
        setCampaigns(list);
        if (list.length > 0 && !selectedCampaignId) setSelectedCampaignId(list[0]!.id);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingCampaigns(false));
    refreshInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedCampaignId) {
      setAnalytics(null);
      return;
    }
    setLoadingAnalytics(true);
    window.outboundly
      .getCampaignAnalytics({ campaignId: selectedCampaignId })
      .then(setAnalytics)
      .catch((err) => setError(String(err)))
      .finally(() => setLoadingAnalytics(false));
  }, [selectedCampaignId]);

  async function handleDismiss(insightId: string): Promise<void> {
    try {
      await window.outboundly.dismissInsight({ insightId });
      refreshInsights();
    } catch (err) {
      setError(String(err));
    }
  }

  const maxFunnelSent = analytics ? Math.max(1, ...analytics.stepFunnel.map((s) => s.sentCount)) : 1;

  return (
    <div>
      <PageHeader title="Analytics" description="Campaign performance and the Insights Engine's running feed." />

      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "var(--space-6)" }}>
        <CardHeader title="Campaign dashboard" />
        {loadingCampaigns ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-6)" }}>
            <Spinner size={22} />
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState icon={<BarChartIcon size={20} />} title="No campaigns yet" description="Create a campaign to see its metrics here." />
        ) : (
          <>
            <div style={{ maxWidth: 340, marginBottom: "var(--space-5)" }}>
              <Field label="Campaign">
                <Select value={selectedCampaignId} onChange={(e) => setSelectedCampaignId(e.target.value)}>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {loadingAnalytics ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-6)" }}>
                <Spinner size={22} />
              </div>
            ) : analytics ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--space-4)", marginBottom: "var(--space-6)" }}>
                  <StatCard label="Sent" value={analytics.sentCount} />
                  <StatCard label="Delivery rate" value={formatPercent(analytics.deliveryRate)} />
                  <StatCard label="Reply rate" value={formatPercent(analytics.replyRate)} />
                  <StatCard label="Positive reply rate" value={formatPercent(analytics.positiveReplyRate)} />
                  <StatCard label="Bounce rate" value={formatPercent(analytics.bounceRate)} />
                  <StatCard label="Conversions" value={analytics.conversionCount} icon={<TargetIcon size={14} />} />
                </div>

                <p style={{ fontSize: "12.5px", color: "var(--color-text-tertiary)", marginBottom: "var(--space-6)" }}>
                  Open/click rate aren't shown: this is a local desktop app with no publicly reachable server to receive pixel/redirect hits, so
                  they can't be honestly tracked. Delivery rate is approximated as sent-minus-bounced.
                </p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-6)" }}>
                  <div>
                    <h3 style={{ fontSize: "13px", fontWeight: 600, marginBottom: "var(--space-3)" }}>Per-step funnel</h3>
                    {analytics.stepFunnel.length === 0 ? (
                      <p style={{ fontSize: "13px", color: "var(--color-text-tertiary)" }}>No steps sent yet.</p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                        {analytics.stepFunnel.map((step) => (
                          <div key={step.stepOrder}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", marginBottom: "2px" }}>
                              <span>Step {step.stepOrder}</span>
                              <span style={{ color: "var(--color-text-secondary)" }}>{step.sentCount} sent</span>
                            </div>
                            <div style={{ height: 6, borderRadius: "var(--radius-full)", background: "var(--color-surface-hover)" }}>
                              <div
                                style={{
                                  height: "100%",
                                  width: `${(step.sentCount / maxFunnelSent) * 100}%`,
                                  borderRadius: "var(--radius-full)",
                                  background: "var(--color-primary)"
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <h3 style={{ fontSize: "13px", fontWeight: 600, marginBottom: "var(--space-3)" }}>Stop-reason breakdown</h3>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2)", fontSize: "12.5px" }}>
                      {Object.entries(analytics.stopReasonBreakdown).map(([reason, count]) => (
                        <div key={reason} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", background: "var(--color-surface-hover)", borderRadius: "var(--radius-sm)" }}>
                          <span style={{ color: "var(--color-text-secondary)" }}>{humanizeSnakeCase(reason)}</span>
                          <strong>{count}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </>
        )}
      </Card>

      <Card padding="none">
        <div style={{ padding: "var(--space-6) var(--space-6) 0" }}>
          <CardHeader title={`Insights feed (${insights.length})`} />
        </div>
        {insights.length === 0 ? (
          <EmptyState icon={<BarChartIcon size={20} />} title="No active insights" description="Trends, warnings, and anomalies will show up here as they're detected." />
        ) : (
          <div>
            {insights.map((i, idx) => (
              <div key={i.id} style={{ padding: "var(--space-4) var(--space-6)", borderTop: idx === 0 ? "1px solid var(--color-border)" : "1px solid var(--color-border)" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-4)" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "4px" }}>
                      <SeverityBadge severity={i.severity} />
                      <span style={{ fontSize: "13.5px", fontWeight: 600 }}>{i.message}</span>
                    </div>
                    <p style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{i.explanation}</p>
                    {i.recommendedAction && (
                      <p style={{ fontSize: "13px", color: "var(--color-text-primary)", marginTop: "4px" }}>
                        <strong>Recommendation:</strong> {i.recommendedAction}
                      </p>
                    )}
                    <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginTop: "6px" }}>
                      {i.scope}
                      {i.scopeId ? ` · ${i.scopeId}` : ""} · {formatDateTime(i.generatedAt)}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleDismiss(i.id)} style={{ flexShrink: 0 }}>
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
