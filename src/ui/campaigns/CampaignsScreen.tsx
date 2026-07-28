import { useEffect, useState } from "react";
import type {
  AccountSummary,
  CampaignSummary,
  ContactSummary,
  EnrollmentSummary,
  SequenceSummary,
  TemplateSummary
} from "../../ipc-boundary/contracts.js";

/**
 * The Phase 4 "minimal" Campaign UI (Section 14): template/sequence/campaign creation and
 * enrollment monitoring — proves the Campaign Engine end-to-end (Scheduler tick + Send worker
 * pick this up automatically once contacts are enrolled). A single-step sequence builder here;
 * multi-step sequences and weighted A/B variants are authorable only via the underlying
 * repositories today, not this screen.
 */
export function CampaignsScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("Hi {{first_name}},\n\nJust checking in.\n\nBest,\nMe");

  const [sequenceName, setSequenceName] = useState("");
  const [sequenceTemplateId, setSequenceTemplateId] = useState("");
  const [sequenceSubject, setSequenceSubject] = useState("Quick question");
  const [sequenceDelayDays, setSequenceDelayDays] = useState("0");

  const [campaignName, setCampaignName] = useState("");
  const [campaignSequenceId, setCampaignSequenceId] = useState("");
  const [campaignAccountId, setCampaignAccountId] = useState("");

  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [enrollments, setEnrollments] = useState<EnrollmentSummary[]>([]);

  function refreshAll(): void {
    window.outboundly.listAccounts().then(setAccounts).catch((err) => setError(String(err)));
    window.outboundly.listContacts().then(setContacts).catch((err) => setError(String(err)));
    window.outboundly.listTemplates().then(setTemplates).catch((err) => setError(String(err)));
    window.outboundly.listSequences().then(setSequences).catch((err) => setError(String(err)));
    window.outboundly.listCampaigns().then(setCampaigns).catch((err) => setError(String(err)));
  }

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    if (!selectedCampaignId) {
      setEnrollments([]);
      return;
    }
    window.outboundly
      .listEnrollments({ campaignId: selectedCampaignId })
      .then(setEnrollments)
      .catch((err) => setError(String(err)));
  }, [selectedCampaignId]);

  async function handleCreateTemplate(): Promise<void> {
    setError(null);
    try {
      await window.outboundly.createTemplate({ name: templateName, bodyText: templateBody });
      setTemplateName("");
      refreshAll();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCreateSequence(): Promise<void> {
    setError(null);
    try {
      await window.outboundly.createSequence({
        name: sequenceName,
        steps: [
          {
            delayDays: Number(sequenceDelayDays) || 0,
            delayHours: 0,
            templateId: sequenceTemplateId,
            subjectText: sequenceSubject
          }
        ]
      });
      setSequenceName("");
      refreshAll();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCreateCampaign(): Promise<void> {
    setError(null);
    try {
      await window.outboundly.createCampaign({
        name: campaignName,
        sequenceId: campaignSequenceId,
        sendingAccountId: campaignAccountId
      });
      setCampaignName("");
      refreshAll();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleStartCampaign(campaignId: string): Promise<void> {
    setError(null);
    try {
      await window.outboundly.setCampaignStatus({ campaignId, status: "running" });
      refreshAll();
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleEnrollAll(campaignId: string): Promise<void> {
    setError(null);
    try {
      const result = await window.outboundly.enrollContacts({ campaignId, contactIds: contacts.map((c) => c.id) });
      window.alert(`Enrolled ${result.enrolled}. Skipped ${result.skipped.length}.`);
      if (campaignId === selectedCampaignId) {
        window.outboundly.listEnrollments({ campaignId }).then(setEnrollments);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 900, margin: "2rem auto" }}>
      <h1>Outboundly — Campaigns (Phase 4)</h1>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>1. Templates ({templates.length})</h2>
        <input
          placeholder="Template name"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          style={{ display: "block", width: "100%", marginBottom: "0.5rem" }}
        />
        <textarea
          value={templateBody}
          onChange={(e) => setTemplateBody(e.target.value)}
          rows={4}
          style={{ width: "100%", marginBottom: "0.5rem" }}
        />
        <button onClick={handleCreateTemplate} disabled={!templateName}>
          Create template
        </button>
        <ul>
          {templates.map((t) => (
            <li key={t.id}>{t.name}</li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>2. Sequences ({sequences.length})</h2>
        <input
          placeholder="Sequence name"
          value={sequenceName}
          onChange={(e) => setSequenceName(e.target.value)}
          style={{ display: "block", width: "100%", marginBottom: "0.5rem" }}
        />
        <select value={sequenceTemplateId} onChange={(e) => setSequenceTemplateId(e.target.value)} style={{ marginRight: "0.5rem" }}>
          <option value="">Select template...</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Subject"
          value={sequenceSubject}
          onChange={(e) => setSequenceSubject(e.target.value)}
          style={{ marginRight: "0.5rem" }}
        />
        <input
          type="number"
          min={0}
          placeholder="Delay (days)"
          value={sequenceDelayDays}
          onChange={(e) => setSequenceDelayDays(e.target.value)}
          style={{ width: "6rem", marginRight: "0.5rem" }}
        />
        <button onClick={handleCreateSequence} disabled={!sequenceName || !sequenceTemplateId}>
          Create single-step sequence
        </button>
        <ul>
          {sequences.map((s) => (
            <li key={s.id}>
              {s.name} ({s.stepCount} step{s.stepCount === 1 ? "" : "s"})
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>3. Campaigns ({campaigns.length})</h2>
        <input
          placeholder="Campaign name"
          value={campaignName}
          onChange={(e) => setCampaignName(e.target.value)}
          style={{ display: "block", width: "100%", marginBottom: "0.5rem" }}
        />
        <select value={campaignSequenceId} onChange={(e) => setCampaignSequenceId(e.target.value)} style={{ marginRight: "0.5rem" }}>
          <option value="">Select sequence...</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={campaignAccountId} onChange={(e) => setCampaignAccountId(e.target.value)} style={{ marginRight: "0.5rem" }}>
          <option value="">Select sending account...</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emailAddress}
            </option>
          ))}
        </select>
        <button onClick={handleCreateCampaign} disabled={!campaignName || !campaignSequenceId || !campaignAccountId}>
          Create campaign
        </button>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>Name</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid #eee" }}>
                <td>
                  <button onClick={() => setSelectedCampaignId(c.id)} style={{ fontWeight: c.id === selectedCampaignId ? "bold" : "normal" }}>
                    {c.name}
                  </button>
                </td>
                <td>{c.status}</td>
                <td>
                  {c.status === "draft" && <button onClick={() => handleStartCampaign(c.id)}>Start</button>}
                  <button onClick={() => handleEnrollAll(c.id)} disabled={contacts.length === 0}>
                    Enroll all contacts ({contacts.length})
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selectedCampaignId && (
        <section>
          <h2>Enrollments for {campaigns.find((c) => c.id === selectedCampaignId)?.name}</h2>
          {enrollments.length === 0 && <p>No enrollments yet.</p>}
          {enrollments.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Next send</th>
                  <th>Enrolled</th>
                </tr>
              </thead>
              <tbody>
                {enrollments.map((e) => (
                  <tr key={e.id} style={{ borderBottom: "1px solid #eee" }}>
                    <td>{contacts.find((c) => c.id === e.contactId)?.email ?? e.contactId}</td>
                    <td>{e.status}</td>
                    <td>{e.nextSendAt ?? "—"}</td>
                    <td>{e.enrolledAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
