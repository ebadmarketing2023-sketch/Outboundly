import { useEffect, useState } from "react";
import type {
  AccountSummary,
  BusinessHoursProfileSummary,
  CampaignSummary,
  ContactSummary,
  EnrollmentSummary,
  SequenceSummary,
  TemplateSummary
} from "../../ipc-boundary/contracts.js";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WEEKDAY_LABELS: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun"
};

/**
 * The Phase 4 "minimal" Campaign UI (Section 14): sending-account limits, business hours
 * profiles, template/sequence/campaign creation, and enrollment monitoring — proves the Campaign
 * Engine end-to-end (Scheduler tick + Send worker pick this up automatically once contacts are
 * enrolled). Sequences support any number of steps, each with its own delay/template/subject;
 * weighted A/B variants (multiple subject/content options per step) are authorable only via the
 * underlying repositories today, not this screen. Business hours profiles apply one shared
 * start/end window to every selected day, not the full per-weekday/multi-window data model.
 */
export function CampaignsScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [businessHoursProfiles, setBusinessHoursProfiles] = useState<BusinessHoursProfileSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [accountLimitDrafts, setAccountLimitDrafts] = useState<Record<string, { daily: string; hourly: string }>>({});

  const [bhpName, setBhpName] = useState("");
  const [bhpTimezone, setBhpTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [bhpDays, setBhpDays] = useState<Set<string>>(new Set(["monday", "tuesday", "wednesday", "thursday", "friday"]));
  const [bhpStart, setBhpStart] = useState("09:00");
  const [bhpEnd, setBhpEnd] = useState("17:00");

  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("Hi {{first_name}},\n\nJust checking in.\n\nBest,\nMe");

  const [sequenceName, setSequenceName] = useState("");
  const [sequenceSteps, setSequenceSteps] = useState<
    Array<{ delayDays: string; delayHours: string; templateId: string; subjectText: string }>
  >([{ delayDays: "0", delayHours: "0", templateId: "", subjectText: "Quick question" }]);

  const [campaignName, setCampaignName] = useState("");
  const [campaignSequenceId, setCampaignSequenceId] = useState("");
  const [campaignAccountId, setCampaignAccountId] = useState("");
  const [campaignBusinessHoursProfileId, setCampaignBusinessHoursProfileId] = useState("");

  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [enrollments, setEnrollments] = useState<EnrollmentSummary[]>([]);

  function refreshAll(): void {
    window.outboundly
      .listAccounts()
      .then((list) => {
        setAccounts(list);
        setAccountLimitDrafts((prev) => {
          const next = { ...prev };
          for (const a of list) {
            if (!next[a.id]) {
              next[a.id] = { daily: a.dailySendLimit?.toString() ?? "", hourly: a.hourlySendLimit?.toString() ?? "" };
            }
          }
          return next;
        });
      })
      .catch((err) => setError(String(err)));
    window.outboundly.listContacts().then(setContacts).catch((err) => setError(String(err)));
    window.outboundly.listTemplates().then(setTemplates).catch((err) => setError(String(err)));
    window.outboundly.listSequences().then(setSequences).catch((err) => setError(String(err)));
    window.outboundly.listCampaigns().then(setCampaigns).catch((err) => setError(String(err)));
    window.outboundly.listBusinessHoursProfiles().then(setBusinessHoursProfiles).catch((err) => setError(String(err)));
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

  function toggleBhpDay(day: string): void {
    setBhpDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  async function handleSaveAccountLimits(accountId: string): Promise<void> {
    setError(null);
    const draft = accountLimitDrafts[accountId] ?? { daily: "", hourly: "" };
    try {
      const updated = await window.outboundly.updateAccountLimits({
        accountId,
        dailySendLimit: draft.daily.trim() === "" ? undefined : Number(draft.daily),
        hourlySendLimit: draft.hourly.trim() === "" ? undefined : Number(draft.hourly)
      });
      setAccounts((prev) => prev.map((a) => (a.id === accountId ? updated : a)));
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCreateBusinessHoursProfile(): Promise<void> {
    setError(null);
    try {
      await window.outboundly.createBusinessHoursProfile({
        name: bhpName,
        timezone: bhpTimezone,
        days: [...bhpDays],
        start: bhpStart,
        end: bhpEnd
      });
      setBhpName("");
      refreshAll();
    } catch (err) {
      setError(String(err));
    }
  }

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

  function addSequenceStep(): void {
    setSequenceSteps((prev) => [...prev, { delayDays: "1", delayHours: "0", templateId: "", subjectText: "" }]);
  }

  function removeSequenceStep(index: number): void {
    setSequenceSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function updateSequenceStep(index: number, patch: Partial<(typeof sequenceSteps)[number]>): void {
    setSequenceSteps((prev) => prev.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  async function handleCreateSequence(): Promise<void> {
    setError(null);
    try {
      await window.outboundly.createSequence({
        name: sequenceName,
        steps: sequenceSteps.map((step) => ({
          delayDays: Number(step.delayDays) || 0,
          delayHours: Number(step.delayHours) || 0,
          templateId: step.templateId,
          subjectText: step.subjectText
        }))
      });
      setSequenceName("");
      setSequenceSteps([{ delayDays: "0", delayHours: "0", templateId: "", subjectText: "Quick question" }]);
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
        sendingAccountId: campaignAccountId,
        businessHoursProfileId: campaignBusinessHoursProfileId
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
        <h2>1. Sending accounts &amp; limits</h2>
        <p style={{ color: "#666", fontSize: "0.85rem" }}>
          Caps applied per account by the Rate Limit Policy and the authoritative Rate Limiter — leave blank for no limit.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>Account</th>
              <th>Daily limit</th>
              <th>Hourly limit</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const draft = accountLimitDrafts[a.id] ?? { daily: "", hourly: "" };
              return (
                <tr key={a.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td>{a.emailAddress}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={draft.daily}
                      onChange={(e) =>
                        setAccountLimitDrafts((prev) => ({ ...prev, [a.id]: { ...draft, daily: e.target.value } }))
                      }
                      style={{ width: "6rem" }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={draft.hourly}
                      onChange={(e) =>
                        setAccountLimitDrafts((prev) => ({ ...prev, [a.id]: { ...draft, hourly: e.target.value } }))
                      }
                      style={{ width: "6rem" }}
                    />
                  </td>
                  <td>
                    <button onClick={() => handleSaveAccountLimits(a.id)}>Save</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {accounts.length === 0 && <p>No accounts connected yet.</p>}
      </section>

      <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>2. Business hours profiles ({businessHoursProfiles.length})</h2>
        <p style={{ color: "#666", fontSize: "0.85rem" }}>
          When a campaign bound to this profile is allowed to send, in the profile's own timezone.
        </p>
        <input
          placeholder="Profile name"
          value={bhpName}
          onChange={(e) => setBhpName(e.target.value)}
          style={{ display: "block", width: "100%", marginBottom: "0.5rem" }}
        />
        <input
          placeholder="IANA timezone, e.g. America/New_York"
          value={bhpTimezone}
          onChange={(e) => setBhpTimezone(e.target.value)}
          style={{ display: "block", width: "100%", marginBottom: "0.5rem" }}
        />
        <div style={{ marginBottom: "0.5rem" }}>
          {WEEKDAYS.map((day) => (
            <label key={day} style={{ marginRight: "0.75rem" }}>
              <input type="checkbox" checked={bhpDays.has(day)} onChange={() => toggleBhpDay(day)} /> {WEEKDAY_LABELS[day]}
            </label>
          ))}
        </div>
        <label style={{ marginRight: "0.5rem" }}>
          From <input type="time" value={bhpStart} onChange={(e) => setBhpStart(e.target.value)} />
        </label>
        <label style={{ marginRight: "0.5rem" }}>
          To <input type="time" value={bhpEnd} onChange={(e) => setBhpEnd(e.target.value)} />
        </label>
        <button onClick={handleCreateBusinessHoursProfile} disabled={!bhpName || !bhpTimezone || bhpDays.size === 0}>
          Create profile
        </button>
        <ul>
          {businessHoursProfiles.map((p) => (
            <li key={p.id}>
              {p.name} — {p.timezone}, {Object.keys(p.windows).length} day(s) active
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>3. Templates ({templates.length})</h2>
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
        <h2>4. Sequences ({sequences.length})</h2>
        <input
          placeholder="Sequence name"
          value={sequenceName}
          onChange={(e) => setSequenceName(e.target.value)}
          style={{ display: "block", width: "100%", marginBottom: "0.5rem" }}
        />
        {sequenceSteps.map((step, index) => (
          <div key={index} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <strong style={{ width: "3.5rem" }}>Step {index + 1}</strong>
            <select value={step.templateId} onChange={(e) => updateSequenceStep(index, { templateId: e.target.value })}>
              <option value="">Select template...</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Subject"
              value={step.subjectText}
              onChange={(e) => updateSequenceStep(index, { subjectText: e.target.value })}
            />
            <label>
              Wait
              <input
                type="number"
                min={0}
                value={step.delayDays}
                onChange={(e) => updateSequenceStep(index, { delayDays: e.target.value })}
                style={{ width: "4rem", margin: "0 0.25rem" }}
              />
              day(s)
            </label>
            <label>
              <input
                type="number"
                min={0}
                max={23}
                value={step.delayHours}
                onChange={(e) => updateSequenceStep(index, { delayHours: e.target.value })}
                style={{ width: "4rem", margin: "0 0.25rem" }}
              />
              hour(s) after the previous step
            </label>
            <button onClick={() => removeSequenceStep(index)} disabled={sequenceSteps.length === 1}>
              Remove
            </button>
          </div>
        ))}
        <div style={{ marginBottom: "0.5rem" }}>
          <button onClick={addSequenceStep}>+ Add another step</button>
        </div>
        <button
          onClick={handleCreateSequence}
          disabled={!sequenceName || sequenceSteps.some((s) => !s.templateId || !s.subjectText)}
        >
          Create sequence ({sequenceSteps.length} step{sequenceSteps.length === 1 ? "" : "s"})
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
        <h2>5. Campaigns ({campaigns.length})</h2>
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
        <select
          value={campaignBusinessHoursProfileId}
          onChange={(e) => setCampaignBusinessHoursProfileId(e.target.value)}
          style={{ marginRight: "0.5rem" }}
        >
          <option value="">Select business hours...</option>
          {businessHoursProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleCreateCampaign}
          disabled={!campaignName || !campaignSequenceId || !campaignAccountId || !campaignBusinessHoursProfileId}
        >
          Create campaign
        </button>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.75rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th>Name</th>
              <th>Status</th>
              <th>Business hours</th>
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
                <td>{businessHoursProfiles.find((p) => p.id === c.businessHoursProfileId)?.name ?? "—"}</td>
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
