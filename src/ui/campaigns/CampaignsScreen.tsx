import { useEffect, useRef, useState } from "react";
import type {
  AccountSummary,
  BusinessHoursProfileSummary,
  CampaignDashboardEntrySummary,
  CampaignSummary,
  ContactSummary,
  EnrollmentSummary,
  LeadImportBatchSummary,
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
  Modal,
  PageHeader,
  PlusIcon,
  RefreshIcon,
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
import { defaultTimezone, timezoneAbbreviation, US_CANADA_PAKISTAN_TIMEZONES } from "./timezones.js";
import { formatDate, formatDateTime } from "../lib/format.js";

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

/** Renders a campaign's rotation pool (Critical Improvement: which account(s) a campaign actually
 * sends from, visible right on the dashboard row) as a comma-joined list of email addresses --
 * usually just one, but a campaign's sendingAccountIds can hold more than one for round-robin
 * rotation (Section 16.3's Provider Selector). Falls back to the bare id for an account that's
 * since been disconnected/removed from the visible accounts list, rather than silently dropping it. */
function describeSendingAccounts(sendingAccountIds: string[], accounts: AccountSummary[]): string {
  if (sendingAccountIds.length === 0) return "—";
  return sendingAccountIds.map((id) => accounts.find((a) => a.id === id)?.emailAddress ?? id).join(", ");
}

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

  const [accountLimitDrafts, setAccountLimitDrafts] = useState<
    Record<string, { daily: string; hourly: string; minDelay: string; maxDelay: string }>
  >({});

  const [bhpName, setBhpName] = useState("");
  const [bhpTimezone, setBhpTimezone] = useState(defaultTimezone);
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

  const [campaignDashboard, setCampaignDashboard] = useState<CampaignDashboardEntrySummary[]>([]);
  const [leadImportBatches, setLeadImportBatches] = useState<LeadImportBatchSummary[]>([]);
  const [enrollCsvTarget, setEnrollCsvTarget] = useState<CampaignDashboardEntrySummary | null>(null);
  const [enrollBatchId, setEnrollBatchId] = useState("");
  const [enrollCsvText, setEnrollCsvText] = useState("");
  const [enrollCsvFilename, setEnrollCsvFilename] = useState("");
  const [enrollCsvBusy, setEnrollCsvBusy] = useState(false);
  const enrollCsvFileInputRef = useRef<HTMLInputElement>(null);
  const [editCampaignTarget, setEditCampaignTarget] = useState<CampaignDashboardEntrySummary | null>(null);
  const [editCampaignName, setEditCampaignName] = useState("");
  const [editCampaignBusinessHoursProfileId, setEditCampaignBusinessHoursProfileId] = useState("");
  const [editCampaignBusy, setEditCampaignBusy] = useState(false);
  const [deleteCampaignTarget, setDeleteCampaignTarget] = useState<CampaignDashboardEntrySummary | null>(null);
  const [deleteCampaignBusy, setDeleteCampaignBusy] = useState(false);
  const [dashboardRefreshBusy, setDashboardRefreshBusy] = useState(false);
  const [deleteTemplateTarget, setDeleteTemplateTarget] = useState<TemplateSummary | null>(null);
  const [deleteTemplateBusy, setDeleteTemplateBusy] = useState(false);
  const [deleteSequenceTarget, setDeleteSequenceTarget] = useState<SequenceSummary | null>(null);
  const [deleteSequenceBusy, setDeleteSequenceBusy] = useState(false);

  function refreshAll(): Promise<void> {
    const accountsPromise = window.outboundly
      .listAccounts()
      .then((list) => {
        setAccounts(list);
        setAccountLimitDrafts((prev) => {
          const next = { ...prev };
          for (const a of list) {
            if (!next[a.id]) {
              next[a.id] = {
                daily: a.dailySendLimit?.toString() ?? "",
                hourly: a.hourlySendLimit?.toString() ?? "",
                minDelay: a.minSendDelaySeconds?.toString() ?? "",
                maxDelay: a.maxSendDelaySeconds?.toString() ?? ""
              };
            }
          }
          return next;
        });
      })
      .catch((err) => setError(String(err)));
    return Promise.all([
      accountsPromise,
      window.outboundly.listContacts().then(setContacts).catch((err) => setError(String(err))),
      window.outboundly.listLeadImportBatches().then(setLeadImportBatches).catch((err) => setError(String(err))),
      window.outboundly.listTemplates().then(setTemplates).catch((err) => setError(String(err))),
      window.outboundly.listSequences().then(setSequences).catch((err) => setError(String(err))),
      window.outboundly.listCampaigns().then(setCampaigns).catch((err) => setError(String(err))),
      window.outboundly.listBusinessHoursProfiles().then(setBusinessHoursProfiles).catch((err) => setError(String(err))),
      refreshCampaignDashboard()
    ]).then(() => undefined);
  }

  function refreshCampaignDashboard(): Promise<void> {
    return window.outboundly.listCampaignDashboard().then(setCampaignDashboard).catch((err) => setError(String(err)));
  }

  // Critical Improvement: replies/completion/queue counts on this dashboard are live-computed
  // (Section 21.1's rollup worker only recomputes every few minutes), but nothing on this screen
  // re-fetches on its own once mounted -- a reply that lands, or a background send that completes,
  // while the user is sitting here looking at it just never appears until they navigate away and
  // back. A manual refresh gives an explicit, immediate way to pull the latest without that.
  async function handleRefreshDashboard(): Promise<void> {
    setDashboardRefreshBusy(true);
    try {
      await refreshAll();
    } finally {
      setDashboardRefreshBusy(false);
    }
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
    const draft = accountLimitDrafts[accountId] ?? { daily: "", hourly: "", minDelay: "", maxDelay: "" };
    const minDelayTrimmed = draft.minDelay.trim();
    const maxDelayTrimmed = draft.maxDelay.trim();
    if (minDelayTrimmed === "" !== (maxDelayTrimmed === "")) {
      toast.showToast("Set both a minimum and maximum send delay, or leave both blank.", "error");
      return;
    }
    if (minDelayTrimmed !== "" && Number(minDelayTrimmed) > Number(maxDelayTrimmed)) {
      toast.showToast("Minimum send delay can't be greater than the maximum.", "error");
      return;
    }
    try {
      const updated = await window.outboundly.updateAccountLimits({
        accountId,
        dailySendLimit: draft.daily.trim() === "" ? undefined : Number(draft.daily),
        hourlySendLimit: draft.hourly.trim() === "" ? undefined : Number(draft.hourly),
        minSendDelaySeconds: minDelayTrimmed === "" ? undefined : Number(minDelayTrimmed),
        maxSendDelaySeconds: maxDelayTrimmed === "" ? undefined : Number(maxDelayTrimmed)
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

  async function handleSetCampaignStatus(campaignId: string, status: "running" | "paused", successMessage: string): Promise<void> {
    setError(null);
    try {
      await window.outboundly.setCampaignStatus({ campaignId, status });
      refreshAll();
      toast.showToast(successMessage, "success");
    } catch (err) {
      setError(String(err));
    }
  }

  function handleOpenEditCampaign(entry: CampaignDashboardEntrySummary): void {
    setEditCampaignTarget(entry);
    setEditCampaignName(entry.name);
    const campaign = campaigns.find((c) => c.id === entry.id);
    setEditCampaignBusinessHoursProfileId(campaign?.businessHoursProfileId ?? "");
  }

  async function handleSaveEditCampaign(): Promise<void> {
    if (!editCampaignTarget) return;
    setEditCampaignBusy(true);
    try {
      await window.outboundly.updateCampaign({
        campaignId: editCampaignTarget.id,
        name: editCampaignName,
        businessHoursProfileId: editCampaignBusinessHoursProfileId
      });
      refreshAll();
      toast.showToast("Campaign updated.", "success");
      setEditCampaignTarget(null);
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setEditCampaignBusy(false);
    }
  }

  async function handleConfirmDeleteCampaign(): Promise<void> {
    if (!deleteCampaignTarget) return;
    setDeleteCampaignBusy(true);
    try {
      await window.outboundly.deleteCampaign({ campaignId: deleteCampaignTarget.id });
      if (selectedCampaignId === deleteCampaignTarget.id) setSelectedCampaignId("");
      refreshAll();
      toast.showToast("Campaign deleted.", "success");
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setDeleteCampaignBusy(false);
      setDeleteCampaignTarget(null);
    }
  }

  async function handleConfirmDeleteTemplate(): Promise<void> {
    if (!deleteTemplateTarget) return;
    setDeleteTemplateBusy(true);
    try {
      await window.outboundly.deleteTemplate({ templateId: deleteTemplateTarget.id });
      refreshAll();
      toast.showToast("Template deleted.", "success");
    } catch (err) {
      // A template still used by a sequence step is rejected, not silently broken -- the
      // repository's own error message ("used by N sequence step(s)...") surfaces here as-is.
      toast.showToast(String(err), "error");
    } finally {
      setDeleteTemplateBusy(false);
      setDeleteTemplateTarget(null);
    }
  }

  async function handleConfirmDeleteSequence(): Promise<void> {
    if (!deleteSequenceTarget) return;
    setDeleteSequenceBusy(true);
    try {
      await window.outboundly.deleteSequence({ sequenceId: deleteSequenceTarget.id });
      refreshAll();
      toast.showToast("Sequence deleted.", "success");
    } catch (err) {
      // A sequence still bound to a campaign is rejected, not silently broken -- the repository's
      // own error message ("used by N campaign(s)...") surfaces here as-is.
      toast.showToast(String(err), "error");
    } finally {
      setDeleteSequenceBusy(false);
      setDeleteSequenceTarget(null);
    }
  }

  function handleOpenEnrollCsv(entry: CampaignDashboardEntrySummary): void {
    setEnrollCsvTarget(entry);
    setEnrollBatchId("");
    setEnrollCsvText("");
    setEnrollCsvFilename("");
  }

  function handleEnrollCsvFileChosen(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        setEnrollBatchId("");
        setEnrollCsvText(text);
        setEnrollCsvFilename(file.name);
      })
      .catch((err) => toast.showToast(String(err), "error"));
    e.target.value = "";
  }

  function refreshAfterEnrollment(campaignId: string): void {
    window.outboundly.listContacts().then(setContacts).catch((err) => setError(String(err)));
    window.outboundly.listLeadImportBatches().then(setLeadImportBatches).catch((err) => setError(String(err)));
    if (campaignId === selectedCampaignId) {
      window.outboundly.listEnrollments({ campaignId }).then(setEnrollments);
    }
    refreshCampaignDashboard();
  }

  async function handleSubmitEnrollCsv(): Promise<void> {
    if (!enrollCsvTarget) return;
    setEnrollCsvBusy(true);
    try {
      if (enrollBatchId) {
        const result = await window.outboundly.enrollContactsFromBatch({ campaignId: enrollCsvTarget.id, batchId: enrollBatchId });
        toast.showToast(`Enrolled ${result.enrolled}. Skipped ${result.skipped.length}.`, "success");
      } else {
        const result = await window.outboundly.enrollContactsFromCsv({
          campaignId: enrollCsvTarget.id,
          csvText: enrollCsvText,
          filename: enrollCsvFilename || undefined
        });
        toast.showToast(
          `Imported ${result.imported} lead(s), enrolled ${result.enrolled}. Skipped ${result.importSkipped.length + result.enrollSkipped.length}.`,
          "success"
        );
      }
      refreshAfterEnrollment(enrollCsvTarget.id);
      setEnrollCsvTarget(null);
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setEnrollCsvBusy(false);
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
      <PageHeader
        title="Campaigns"
        description="Sending accounts, business hours, templates, sequences, and enrollment monitoring."
        actions={
          <Button variant="secondary" icon={<RefreshIcon size={15} />} loading={dashboardRefreshBusy} onClick={handleRefreshDashboard}>
            Refresh
          </Button>
        }
      />

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
            <CardHeader
              title="Sending accounts & limits"
              description="Daily/hourly caps are enforced by the Rate Limiter — leave blank for no limit. Send delay is a randomized wait (re-rolled after every send) this account's next send must respect, across every campaign — leave both blank to disable pacing."
            />
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
                  <Th>Send delay (seconds)</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const draft = accountLimitDrafts[a.id] ?? { daily: "", hourly: "", minDelay: "", maxDelay: "" };
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
                      <Td>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                          <Input
                            type="number"
                            min={0}
                            placeholder="Min"
                            value={draft.minDelay}
                            onChange={(e) => setAccountLimitDrafts((prev) => ({ ...prev, [a.id]: { ...draft, minDelay: e.target.value } }))}
                            style={{ width: "4.5rem" }}
                          />
                          <span style={{ color: "var(--color-text-tertiary)" }}>–</span>
                          <Input
                            type="number"
                            min={0}
                            placeholder="Max"
                            value={draft.maxDelay}
                            onChange={(e) => setAccountLimitDrafts((prev) => ({ ...prev, [a.id]: { ...draft, maxDelay: e.target.value } }))}
                            style={{ width: "4.5rem" }}
                          />
                        </div>
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
            <Field label="Timezone">
              <Select value={bhpTimezone} onChange={(e) => setBhpTimezone(e.target.value)}>
                {(["United States", "Canada", "Pakistan"] as const).map((country) => (
                  <optgroup key={country} label={country}>
                    {US_CANADA_PAKISTAN_TIMEZONES.filter((z) => z.country === country).map((z) => (
                      <option key={z.value} value={z.value}>
                        {z.regionLabel} ({timezoneAbbreviation(z)})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
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
                <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--space-3) var(--space-4)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)", fontSize: "13.5px", fontWeight: 550 }}>
                  {t.name}
                  <Button variant="danger-ghost" size="sm" icon={<TrashIcon size={14} />} onClick={() => setDeleteTemplateTarget(t)}>
                    Delete
                  </Button>
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
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "var(--space-3) var(--space-4)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)", fontSize: "13.5px" }}>
                  <strong>{s.name}</strong>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <span style={{ color: "var(--color-text-secondary)" }}>
                      {s.stepCount} step{s.stepCount === 1 ? "" : "s"}
                    </span>
                    <Button variant="danger-ghost" size="sm" icon={<TrashIcon size={14} />} onClick={() => setDeleteSequenceTarget(s)}>
                      Delete
                    </Button>
                  </div>
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

            {campaignDashboard.length === 0 ? (
              <EmptyState icon={<MegaphoneIcon size={20} />} title="No campaigns yet" description="Create your first campaign above." />
            ) : (
              <div style={{ overflowX: "auto" }}>
                <Table>
                  <thead>
                    <tr>
                      <Th>Name</Th>
                      <Th>Status</Th>
                      <Th>Sending account</Th>
                      <Th align="right">Total leads</Th>
                      <Th align="right">Sent</Th>
                      <Th align="right">Remaining</Th>
                      <Th align="right">Replies</Th>
                      <Th align="right">Reply rate</Th>
                      <Th align="right">Completion</Th>
                      <Th>Last activity</Th>
                      <Th>Created</Th>
                      <Th align="right">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaignDashboard.map((c) => (
                      <TableRow
                        key={c.id}
                        onClick={() => setSelectedCampaignId(c.id)}
                        style={{ background: c.id === selectedCampaignId ? "var(--color-primary-light)" : undefined }}
                      >
                        <Td style={{ fontWeight: 600 }}>{c.name}</Td>
                        <Td>
                          <StatusBadge status={c.status} />
                        </Td>
                        <Td>{describeSendingAccounts(c.sendingAccountIds, accounts)}</Td>
                        <Td align="right">{c.totalLeads}</Td>
                        <Td align="right">{c.emailsSent}</Td>
                        <Td align="right">{c.emailsRemaining}</Td>
                        <Td align="right">{c.replies}</Td>
                        <Td align="right">{c.replyRatePercent === undefined ? "—" : `${c.replyRatePercent}%`}</Td>
                        <Td align="right">{c.completionPercent}%</Td>
                        <Td>{c.lastActivityAt ? formatDateTime(c.lastActivityAt) : "—"}</Td>
                        <Td>{formatDate(c.createdAt)}</Td>
                        <Td align="right">
                          <div style={{ display: "flex", gap: "0.4rem", justifyContent: "flex-end", flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                            {c.status === "draft" && (
                              <Button variant="secondary" size="sm" onClick={() => handleSetCampaignStatus(c.id, "running", "Campaign started.")}>
                                Start
                              </Button>
                            )}
                            {c.status === "running" && (
                              <Button variant="secondary" size="sm" onClick={() => handleSetCampaignStatus(c.id, "paused", "Campaign paused.")}>
                                Pause
                              </Button>
                            )}
                            {c.status === "paused" && (
                              <Button variant="secondary" size="sm" onClick={() => handleSetCampaignStatus(c.id, "running", "Campaign resumed.")}>
                                Resume
                              </Button>
                            )}
                            <Button variant="secondary" size="sm" onClick={() => handleOpenEnrollCsv(c)}>
                              Enroll leads (CSV)
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleOpenEditCampaign(c)}>
                              Edit
                            </Button>
                            <Button variant="danger-ghost" size="sm" icon={<TrashIcon size={14} />} onClick={() => setDeleteCampaignTarget(c)}>
                              Delete
                            </Button>
                          </div>
                        </Td>
                      </TableRow>
                    ))}
                  </tbody>
                </Table>
              </div>
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

      <Modal
        open={editCampaignTarget !== null}
        onClose={() => setEditCampaignTarget(null)}
        title="Edit campaign"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditCampaignTarget(null)} disabled={editCampaignBusy}>
              Cancel
            </Button>
            <Button variant="primary" loading={editCampaignBusy} disabled={!editCampaignName || !editCampaignBusinessHoursProfileId} onClick={handleSaveEditCampaign}>
              Save
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <Field label="Campaign name">
            <Input value={editCampaignName} onChange={(e) => setEditCampaignName(e.target.value)} />
          </Field>
          <Field label="Business hours">
            <Select value={editCampaignBusinessHoursProfileId} onChange={(e) => setEditCampaignBusinessHoursProfileId(e.target.value)}>
              <option value="">Select profile...</option>
              {businessHoursProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <p style={{ fontSize: "12.5px", color: "var(--color-text-tertiary)" }}>
            The sequence and sending account can't be changed once a campaign exists -- pause this one and create a new campaign instead.
          </p>
        </div>
      </Modal>

      <Modal
        open={enrollCsvTarget !== null}
        onClose={() => setEnrollCsvTarget(null)}
        title={`Enroll leads — ${enrollCsvTarget?.name ?? ""}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEnrollCsvTarget(null)} disabled={enrollCsvBusy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={enrollCsvBusy}
              disabled={!enrollBatchId && !enrollCsvText.trim()}
              onClick={handleSubmitEnrollCsv}
            >
              {enrollBatchId ? "Enroll" : "Import & enroll"}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <p style={{ fontSize: "12.5px", color: "var(--color-text-tertiary)" }}>
            This campaign only ever sends to the leads chosen here -- not your whole global contacts list. Each import is its
            own isolated batch of leads for this campaign.
          </p>

          {leadImportBatches.length > 0 && (
            <Field label="Use a previous import">
              <Select
                value={enrollBatchId}
                onChange={(e) => {
                  setEnrollBatchId(e.target.value);
                  if (e.target.value) {
                    setEnrollCsvText("");
                    setEnrollCsvFilename("");
                  }
                }}
              >
                <option value="">Upload a new CSV instead...</option>
                {leadImportBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.filename} ({b.contactCount}) — {formatDateTime(b.importedAt)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {!enrollBatchId && (
            <>
              <input ref={enrollCsvFileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={handleEnrollCsvFileChosen} />
              <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
                <Button variant="secondary" size="sm" onClick={() => enrollCsvFileInputRef.current?.click()}>
                  Choose file...
                </Button>
                <div style={{ flex: "1 1 200px" }}>
                  <Field label="Import label">
                    <Input value={enrollCsvFilename} onChange={(e) => setEnrollCsvFilename(e.target.value)} placeholder="e.g. leads-march.csv" />
                  </Field>
                </div>
              </div>
              <Field label="CSV contents">
                <Textarea
                  value={enrollCsvText}
                  onChange={(e) => setEnrollCsvText(e.target.value)}
                  rows={8}
                  placeholder="email,first_name,last_name,company"
                  style={{ fontFamily: "var(--font-mono)", fontSize: "12.5px" }}
                />
              </Field>
            </>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteCampaignTarget !== null}
        title="Delete this campaign?"
        description={`"${deleteCampaignTarget?.name ?? "This campaign"}" will be deleted along with its enrollments. Any of its emails still waiting to send will be cancelled -- emails already sent, and their reply/analytics history, are kept. This can't be undone.`}
        confirmLabel="Delete"
        danger
        busy={deleteCampaignBusy}
        onConfirm={handleConfirmDeleteCampaign}
        onCancel={() => setDeleteCampaignTarget(null)}
      />

      <ConfirmDialog
        open={deleteTemplateTarget !== null}
        title="Delete this template?"
        description={`"${deleteTemplateTarget?.name ?? "This template"}" will be deleted. This can't be undone. If it's still used by a sequence step, deletion is blocked until it's removed from that sequence.`}
        confirmLabel="Delete"
        danger
        busy={deleteTemplateBusy}
        onConfirm={handleConfirmDeleteTemplate}
        onCancel={() => setDeleteTemplateTarget(null)}
      />

      <ConfirmDialog
        open={deleteSequenceTarget !== null}
        title="Delete this sequence?"
        description={`"${deleteSequenceTarget?.name ?? "This sequence"}" and its steps will be deleted. This can't be undone. If it's still used by a campaign, deletion is blocked until that campaign is deleted.`}
        confirmLabel="Delete"
        danger
        busy={deleteSequenceBusy}
        onConfirm={handleConfirmDeleteSequence}
        onCancel={() => setDeleteSequenceTarget(null)}
      />
    </div>
  );
}
