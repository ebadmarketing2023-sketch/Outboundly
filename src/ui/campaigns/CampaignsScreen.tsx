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
import {
  AccountStatusBadge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  EnrollmentStatusBadge,
  ErrorBanner,
  Field,
  Input,
  MegaphoneIcon,
  PageHeader,
  PlusIcon,
  Select,
  StatusBadge,
  Table,
  TableRow,
  Tabs,
  Td,
  Textarea,
  Th,
  TrashIcon,
  useToast
} from "../components/index.js";
import { formatDate } from "../lib/format.js";

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

type SectionKey = "accounts" | "business-hours" | "templates" | "sequences" | "campaigns";

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
  const [section, setSection] = useState<SectionKey>("campaigns");
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [sequences, setSequences] = useState<SequenceSummary[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [businessHoursProfiles, setBusinessHoursProfiles] = useState<BusinessHoursProfileSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

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
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<{ contactId: string; email: string } | null>(null);

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
    // Settings module (Section 3: "sending defaults") -- pre-fills the create-campaign form only;
    // doesn't override a selection the user has already made in this session.
    window.outboundly
      .getAppPreferences()
      .then((prefs) => {
        if (prefs.defaultSendingAccountId) setCampaignAccountId((prev) => prev || prefs.defaultSendingAccountId!);
        if (prefs.defaultBusinessHoursProfileId) {
          setCampaignBusinessHoursProfileId((prev) => prev || prefs.defaultBusinessHoursProfileId!);
        }
      })
      .catch((err) => setError(String(err)));
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
      toast.showToast("Limits saved.", "success");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleCreateBusinessHoursProfile(): Promise<void> {
    setError(null);
    try {
      await window.outboundly.createBusinessHoursProfile({ name: bhpName, timezone: bhpTimezone, days: [...bhpDays], start: bhpStart, end: bhpEnd });
      setBhpName("");
      refreshAll();
      toast.showToast("Business hours profile created.", "success");
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
      toast.showToast("Template created.", "success");
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
      toast.showToast("Sequence created.", "success");
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
      toast.showToast("Campaign created.", "success");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleStartCampaign(campaignId: string): Promise<void> {
    setError(null);
    try {
      await window.outboundly.setCampaignStatus({ campaignId, status: "running" });
      refreshAll();
      toast.showToast("Campaign started.", "success");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleEnrollAll(campaignId: string): Promise<void> {
    setError(null);
    try {
      const result = await window.outboundly.enrollContacts({ campaignId, contactIds: contacts.map((c) => c.id) });
      toast.showToast(`Enrolled ${result.enrolled}. Skipped ${result.skipped.length}.`, "success");
      if (campaignId === selectedCampaignId) {
        window.outboundly.listEnrollments({ campaignId }).then(setEnrollments);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleMarkConversion(campaignId: string, contactId: string): Promise<void> {
    setError(null);
    try {
      await window.outboundly.markConversion({ campaignId, contactId });
      toast.showToast("Marked as converted.", "success");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleUnsubscribe(): Promise<void> {
    if (!unsubscribeTarget) return;
    setError(null);
    try {
      await window.outboundly.unsubscribeContact({ campaignId: selectedCampaignId, contactId: unsubscribeTarget.contactId });
      window.outboundly.listEnrollments({ campaignId: selectedCampaignId }).then(setEnrollments);
      toast.showToast("Contact unsubscribed.", "success");
    } catch (err) {
      setError(String(err));
    } finally {
      setUnsubscribeTarget(null);
    }
  }

  return (
    <div>
      <PageHeader title="Campaigns" description="Sending accounts, business hours, templates, sequences, and enrollment monitoring." />

      {error && <ErrorBanner message={error} />}

      <Tabs
        active={section}
        onChange={(k) => setSection(k as SectionKey)}
        items={[
          { key: "accounts", label: "Sending accounts", count: accounts.length },
          { key: "business-hours", label: "Business hours", count: businessHoursProfiles.length },
          { key: "templates", label: "Templates", count: templates.length },
          { key: "sequences", label: "Sequences", count: sequences.length },
          { key: "campaigns", label: "Campaigns", count: campaigns.length }
        ]}
      />

      {section === "accounts" && (
        <Card padding="none">
          <div style={{ padding: "var(--space-6) var(--space-6) 0" }}>
            <CardHeader title="Sending accounts & limits" description="Caps applied per account by the Rate Limit Policy — leave blank for no limit." />
          </div>
          {accounts.length === 0 ? (
            <EmptyState icon={<MegaphoneIcon size={20} />} title="No accounts connected yet" description="Connect a sending account from the Compose screen first." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th>Status</Th>
                  <Th>Daily limit</Th>
                  <Th>Hourly limit</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const draft = accountLimitDrafts[a.id] ?? { daily: "", hourly: "" };
                  return (
                    <TableRow key={a.id}>
                      <Td>{a.emailAddress}</Td>
                      <Td>
                        <AccountStatusBadge status={a.status} />
                      </Td>
                      <Td>
                        <Input
                          type="number"
                          min={0}
                          value={draft.daily}
                          onChange={(e) => setAccountLimitDrafts((prev) => ({ ...prev, [a.id]: { ...draft, daily: e.target.value } }))}
                          style={{ width: "6rem" }}
                        />
                      </Td>
                      <Td>
                        <Input
                          type="number"
                          min={0}
                          value={draft.hourly}
                          onChange={(e) => setAccountLimitDrafts((prev) => ({ ...prev, [a.id]: { ...draft, hourly: e.target.value } }))}
                          style={{ width: "6rem" }}
                        />
                      </Td>
                      <Td align="right">
                        <Button variant="secondary" size="sm" onClick={() => handleSaveAccountLimits(a.id)}>
                          Save
                        </Button>
                      </Td>
                    </TableRow>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {section === "business-hours" && (
        <Card>
          <CardHeader title="Create a business hours profile" description="When a campaign bound to this profile is allowed to send, in the profile's own timezone." />
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", maxWidth: 480, marginBottom: "var(--space-6)" }}>
            <Field label="Profile name">
              <Input value={bhpName} onChange={(e) => setBhpName(e.target.value)} />
            </Field>
            <Field label="Timezone" hint="IANA timezone, e.g. America/New_York">
              <Input value={bhpTimezone} onChange={(e) => setBhpTimezone(e.target.value)} />
            </Field>
            <Field label="Active days">
              <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                {WEEKDAYS.map((day) => (
                  <Checkbox key={day} checked={bhpDays.has(day)} onChange={() => toggleBhpDay(day)} label={WEEKDAY_LABELS[day]} />
                ))}
              </div>
            </Field>
            <div style={{ display: "flex", gap: "1rem" }}>
              <Field label="From">
                <Input type="time" value={bhpStart} onChange={(e) => setBhpStart(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="time" value={bhpEnd} onChange={(e) => setBhpEnd(e.target.value)} />
              </Field>
            </div>
            <div>
              <Button variant="primary" icon={<PlusIcon size={15} />} disabled={!bhpName || !bhpTimezone || bhpDays.size === 0} onClick={handleCreateBusinessHoursProfile}>
                Create profile
              </Button>
            </div>
          </div>

          {businessHoursProfiles.length === 0 ? (
            <EmptyState title="No profiles yet" description="Create one above to use it on a campaign." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {businessHoursProfiles.map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "var(--space-3) var(--space-4)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)", fontSize: "13.5px" }}>
                  <strong>{p.name}</strong>
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    {p.timezone} · {Object.keys(p.windows).length} day(s) active
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {section === "templates" && (
        <Card>
          <CardHeader title="Create a template" />
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", marginBottom: "var(--space-6)" }}>
            <Field label="Template name">
              <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
            </Field>
            <Field label="Body">
              <Textarea value={templateBody} onChange={(e) => setTemplateBody(e.target.value)} rows={5} />
            </Field>
            <div>
              <Button variant="primary" icon={<PlusIcon size={15} />} disabled={!templateName} onClick={handleCreateTemplate}>
                Create template
              </Button>
            </div>
          </div>

          {templates.length === 0 ? (
            <EmptyState title="No templates yet" description="Create one above to use it in a sequence." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {templates.map((t) => (
                <div key={t.id} style={{ padding: "var(--space-3) var(--space-4)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)", fontSize: "13.5px", fontWeight: 550 }}>
                  {t.name}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {section === "sequences" && (
        <Card>
          <CardHeader title="Create a sequence" />
          <div style={{ marginBottom: "var(--space-6)" }}>
            <div style={{ maxWidth: 420, marginBottom: "var(--space-4)" }}>
              <Field label="Sequence name">
                <Input value={sequenceName} onChange={(e) => setSequenceName(e.target.value)} />
              </Field>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              {sequenceSteps.map((step, index) => (
                <div key={index} style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)", padding: "var(--space-3)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)" }}>
                  <strong style={{ width: "3.5rem", fontSize: "12.5px", paddingBottom: "8px" }}>Step {index + 1}</strong>
                  <div style={{ flex: 1 }}>
                    <Field label="Template">
                      <Select value={step.templateId} onChange={(e) => updateSequenceStep(index, { templateId: e.target.value })}>
                        <option value="">Select template...</option>
                        {templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Field label="Subject">
                      <Input value={step.subjectText} onChange={(e) => updateSequenceStep(index, { subjectText: e.target.value })} />
                    </Field>
                  </div>
                  <div style={{ width: 70 }}>
                    <Field label="Days">
                      <Input type="number" min={0} value={step.delayDays} onChange={(e) => updateSequenceStep(index, { delayDays: e.target.value })} />
                    </Field>
                  </div>
                  <div style={{ width: 70 }}>
                    <Field label="Hours">
                      <Input type="number" min={0} max={23} value={step.delayHours} onChange={(e) => updateSequenceStep(index, { delayHours: e.target.value })} />
                    </Field>
                  </div>
                  <Button variant="ghost" size="sm" icon={<TrashIcon size={14} />} disabled={sequenceSteps.length === 1} onClick={() => removeSequenceStep(index)} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: "var(--space-3)", display: "flex", gap: "0.5rem" }}>
              <Button variant="secondary" size="sm" icon={<PlusIcon size={14} />} onClick={addSequenceStep}>
                Add another step
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!sequenceName || sequenceSteps.some((s) => !s.templateId || !s.subjectText)}
                onClick={handleCreateSequence}
              >
                Create sequence ({sequenceSteps.length} step{sequenceSteps.length === 1 ? "" : "s"})
              </Button>
            </div>
          </div>

          {sequences.length === 0 ? (
            <EmptyState title="No sequences yet" description="Create one above to use it in a campaign." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {sequences.map((s) => (
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between", padding: "var(--space-3) var(--space-4)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)", fontSize: "13.5px" }}>
                  <strong>{s.name}</strong>
                  <span style={{ color: "var(--color-text-secondary)" }}>
                    {s.stepCount} step{s.stepCount === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {section === "campaigns" && (
        <>
          <Card style={{ marginBottom: "var(--space-6)" }}>
            <CardHeader title="Create a campaign" />
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
              <div style={{ flex: "1 1 220px" }}>
                <Field label="Campaign name">
                  <Input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <Field label="Sequence">
                  <Select value={campaignSequenceId} onChange={(e) => setCampaignSequenceId(e.target.value)}>
                    <option value="">Select sequence...</option>
                    {sequences.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <Field label="Sending account">
                  <Select value={campaignAccountId} onChange={(e) => setCampaignAccountId(e.target.value)}>
                    <option value="">Select account...</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.emailAddress}
                        {a.status === "reauth_required" ? " (reconnect needed)" : ""}
                        {a.status === "disconnected" ? " (disconnected)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <Field label="Business hours">
                  <Select value={campaignBusinessHoursProfileId} onChange={(e) => setCampaignBusinessHoursProfileId(e.target.value)}>
                    <option value="">Select profile...</option>
                    {businessHoursProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button
                variant="primary"
                icon={<PlusIcon size={15} />}
                disabled={!campaignName || !campaignSequenceId || !campaignAccountId || !campaignBusinessHoursProfileId}
                onClick={handleCreateCampaign}
              >
                Create
              </Button>
            </div>

            {campaigns.length === 0 ? (
              <EmptyState icon={<MegaphoneIcon size={20} />} title="No campaigns yet" description="Create your first campaign above." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Status</Th>
                    <Th>Business hours</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <TableRow key={c.id} onClick={() => setSelectedCampaignId(c.id)} style={{ background: c.id === selectedCampaignId ? "var(--color-primary-light)" : undefined }}>
                      <Td style={{ fontWeight: 600 }}>{c.name}</Td>
                      <Td>
                        <StatusBadge status={c.status} />
                      </Td>
                      <Td>{businessHoursProfiles.find((p) => p.id === c.businessHoursProfileId)?.name ?? "—"}</Td>
                      <Td align="right">
                        <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
                          {c.status === "draft" && (
                            <Button variant="secondary" size="sm" onClick={() => handleStartCampaign(c.id)}>
                              Start
                            </Button>
                          )}
                          <Button variant="secondary" size="sm" disabled={contacts.length === 0} onClick={() => handleEnrollAll(c.id)}>
                            Enroll all ({contacts.length})
                          </Button>
                        </div>
                      </Td>
                    </TableRow>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {selectedCampaignId && (
            <Card padding="none">
              <div style={{ padding: "var(--space-6) var(--space-6) 0" }}>
                <CardHeader title={`Enrollments — ${campaigns.find((c) => c.id === selectedCampaignId)?.name ?? ""}`} />
              </div>
              {enrollments.length === 0 ? (
                <EmptyState title="No enrollments yet" description="Enroll contacts from the campaigns table above." />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Contact</Th>
                      <Th>Status</Th>
                      <Th>Next send</Th>
                      <Th>Enrolled</Th>
                      <Th align="right">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {enrollments.map((e) => {
                      const email = contacts.find((c) => c.id === e.contactId)?.email ?? e.contactId;
                      return (
                        <TableRow key={e.id}>
                          <Td>{email}</Td>
                          <Td>
                            <EnrollmentStatusBadge status={e.status} />
                          </Td>
                          <Td>{e.nextSendAt ? formatDate(e.nextSendAt) : "—"}</Td>
                          <Td>{formatDate(e.enrolledAt)}</Td>
                          <Td align="right">
                            <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end" }}>
                              <Button variant="secondary" size="sm" onClick={() => handleMarkConversion(selectedCampaignId, e.contactId)}>
                                Mark converted
                              </Button>
                              <Button variant="danger-ghost" size="sm" onClick={() => setUnsubscribeTarget({ contactId: e.contactId, email })}>
                                Unsubscribe
                              </Button>
                            </div>
                          </Td>
                        </TableRow>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={unsubscribeTarget !== null}
        title="Unsubscribe this contact?"
        description={`This adds ${unsubscribeTarget?.email ?? "this contact"} to the global suppression list and stops every campaign they're enrolled in. You can undo this later from the "Suppressed contacts" list on the Leads screen.`}
        confirmLabel="Unsubscribe"
        danger
        onConfirm={handleUnsubscribe}
        onCancel={() => setUnsubscribeTarget(null)}
      />
    </div>
  );
}
