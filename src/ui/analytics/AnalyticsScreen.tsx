import { useEffect, useState } from "react";
import type { CampaignAnalyticsSummary, CampaignSummary, InsightSummary } from "../../ipc-boundary/contracts.js";

function pct(rate: number | undefined): string {
  return rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}

const SEVERITY_COLOR: Record<string, string> = { info: "#555", warning: "#a67c00", critical: "crimson" };

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
      .catch((err) => setError(String(err)));
    refreshInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedCampaignId) {
      setAnalytics(null);
      return;
    }
    window.outboundly
      .getCampaignAnalytics({ campaignId: selectedCampaignId })
      .then(setAnalytics)
      .catch((err) => setError(String(err)));
  }, [selectedCampaignId]);

  async function handleDismiss(insightId: string): Promise<void> {
    try {
      await window.outboundly.dismissInsight({ insightId });
      refreshInsights();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 900, margin: "2rem auto" }}>
      <h1>Outboundly — Analytics &amp; Insights (Phase 5)</h1>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>Campaign dashboard</h2>
        <select value={selectedCampaignId} onChange={(e) => setSelectedCampaignId(e.target.value)}>
          <option value="">Select a campaign...</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        {!selectedCampaignId && <p>Select a campaign to view its metrics.</p>}

        {analytics && (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
              <tbody>
                <tr>
                  <td>Sent</td>
                  <td>{analytics.sentCount}</td>
                  <td>Delivery rate</td>
                  <td>{pct(analytics.deliveryRate)}</td>
                </tr>
                <tr>
                  <td>Reply rate</td>
                  <td>{pct(analytics.replyRate)}</td>
                  <td>Positive reply rate</td>
                  <td>{pct(analytics.positiveReplyRate)}</td>
                </tr>
                <tr>
                  <td>Bounce rate</td>
                  <td>{pct(analytics.bounceRate)}</td>
                  <td>Conversions</td>
                  <td>{analytics.conversionCount}</td>
                </tr>
              </tbody>
            </table>
            <p style={{ color: "#666", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              Open/click rate aren't shown: this is a local desktop app with no publicly reachable server to receive
              pixel/redirect hits, so they can't be honestly tracked (Section 20.2). Delivery rate is approximated as
              sent-minus-bounced — there's no real delivery-confirmation signal.
            </p>

            <h3>Per-step funnel</h3>
            {analytics.stepFunnel.length === 0 && <p>No steps sent yet.</p>}
            {analytics.stepFunnel.length > 0 && (
              <ul>
                {analytics.stepFunnel.map((step) => (
                  <li key={step.stepOrder}>
                    Step {step.stepOrder}: {step.sentCount} sent
                  </li>
                ))}
              </ul>
            )}

            <h3>Stop-reason breakdown</h3>
            <ul>
              <li>Active: {analytics.stopReasonBreakdown.active}</li>
              <li>Completed: {analytics.stopReasonBreakdown.completed}</li>
              <li>Stopped (reply): {analytics.stopReasonBreakdown.stopped_reply}</li>
              <li>Stopped (bounce): {analytics.stopReasonBreakdown.stopped_bounce}</li>
              <li>Stopped (manual): {analytics.stopReasonBreakdown.stopped_manual}</li>
              <li>Stopped (unsubscribed): {analytics.stopReasonBreakdown.stopped_suppressed}</li>
            </ul>
          </>
        )}
      </section>

      <section>
        <h2>Insights feed ({insights.length})</h2>
        {insights.length === 0 && <p>No active insights right now.</p>}
        {insights.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {insights.map((i) => (
              <li key={i.id} style={{ border: "1px solid #ddd", padding: "0.75rem", marginBottom: "0.5rem" }}>
                <strong style={{ color: SEVERITY_COLOR[i.severity] ?? "#555" }}>
                  [{i.severity}] {i.message}
                </strong>
                <div>{i.explanation}</div>
                {i.recommendedAction && (
                  <div>
                    <em>Recommendation: {i.recommendedAction}</em>
                  </div>
                )}
                <div style={{ fontSize: "0.8rem", color: "#666" }}>
                  {i.scope} {i.scopeId ? `(${i.scopeId})` : ""} — {i.generatedAt}
                </div>
                <button onClick={() => handleDismiss(i.id)} style={{ marginTop: "0.25rem" }}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
