import { useRef, useState, useEffect } from "react";
import type {
  AccountSummary,
  BusinessHoursProfileSummary,
  CampaignDashboardEntrySummary,
  CampaignSummary,
  ContactSummary,
  CreateCampaignWizardLeadsSource,
  EnrollmentSummary,
  LeadImportBatchSummary
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

const DEFAULT_BODY = "Hi {{first_name}},\n\nJust checking in.\n\nBest,\nMe";

const WIZARD_STEP_LABELS = ["Details", "Leads", "Content", "Review"];

type SectionKey = "accounts" | "campaigns";

interface WizardContentGroupDraft {
  subjectText: string;
  bodyText: string;
  weight: string;
}

interface WizardFollowUpDraft {
  bodyText: string;
  delayDays: string;
  delayHours: string;
}

/** Renders a campaign's rotation pool (Critical Improvement: which account(s) a campaign actually
 * sends from, visible right on the dashboard row) as a comma-joined list of email addresses --
 * usually just one, but a campaign's sendingAccountIds can hold more than one for round-robin
 * rotation (Section 16.3's Provider Selector). Falls back to the bare id for an account that's
 * since been disconnected/removed from the visible accounts list, rather than silently dropping it. */
function describeSendingAccounts(sendingAccountIds: string[], accounts: AccountSummary[]): string {
  if (sendingAccountIds.length === 0) return "—";
  return sendingAccountIds.map((id) => accounts.find((a) => a.id === id)?.emailAddress ?? id).join(", ");
}

function newContentGroupDraft(): WizardContentGroupDraft {
  return { subjectText: "", bodyText: DEFAULT_BODY, weight: "100" };
}

function newFollowUpDraft(): WizardFollowUpDraft {
  return { bodyText: "", delayDays: "3", delayHours: "0" };
}

/**
 * The Campaign UI (Section 14): sending-account limits, a single guided campaign-creation wizard,
 * and enrollment monitoring. Everything a campaign needs to launch (schedule, leads, first-touch
 * template/subject groups, optional follow-ups) is gathered in one flow instead of requiring
 * separate Business Hours/Template/Sequence entities to be created up front -- this screen creates
 * those underlying rows itself, behind the scenes (see createCampaignFromWizard), so the rest of
 * the app keeps working against the exact same schema unchanged.
 */
export function CampaignsScreen(): JSX.Element {
  const [section, setSection] = useState<SectionKey>("campaigns");
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [businessHoursProfiles, setBusinessHoursProfiles] = useState<BusinessHoursProfileSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const [accountLimitDrafts, setAccountLimitDrafts] = useState<
    Record<string, { daily: string; hourly: string; minDelay: string; maxDelay: string }>
  >({});

  const [defaultSendingAccountId, setDefaultSendingAccountId] = useState("");

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

  // Campaign-creation wizard state (Section 5.6) -- nothing here is persisted until "Launch
  // campaign" on the final step; the underlying business-hours profile/templates/sequence are
  // created together at that point by createCampaignFromWizard.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardName, setWizardName] = useState("");
  const [wizardAccountIds, setWizardAccountIds] = useState<Set<string>>(new Set());
  const [wizardTimezone, setWizardTimezone] = useState(defaultTimezone);
  const [wizardDays, setWizardDays] = useState<Set<string>>(new Set(["monday", "tuesday", "wednesday", "thursday", "friday"]));
  const [wizardStart, setWizardStart] = useState("09:00");
  const [wizardEnd, setWizardEnd] = useState("17:00");
  const [wizardLeadsMode, setWizardLeadsMode] = useState<"csv" | "batch">("csv");
  const [wizardBatchId, setWizardBatchId] = useState("");
  const [wizardCsvText, setWizardCsvText] = useState("");
  const [wizardCsvFilename, setWizardCsvFilename] = useState("");
  const wizardCsvFileInputRef = useRef<HTMLInputElement>(null);
  const [wizardContentGroups, setWizardContentGroups] = useState<WizardContentGroupDraft[]>([newContentGroupDraft()]);
  const [wizardFollowUps, setWizardFollowUps] = useState<WizardFollowUpDraft[]>([]);

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
    // Settings module (Section 3: "sending defaults") -- pre-fills the wizard's sending account
    // only, once the wizard is actually opened (see handleOpenWizard).
    window.outboundly
      .getAppPreferences()
      .then((prefs) => {
        if (prefs.defaultSendingAccountId) setDefaultSendingAccountId(prefs.defaultSendingAccountId);
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

  function handleOpenWizard(): void {
    setWizardStep(0);
    setWizardName("");
    setWizardAccountIds(defaultSendingAccountId ? new Set([defaultSendingAccountId]) : new Set());
    setWizardTimezone(defaultTimezone);
    setWizardDays(new Set(["monday", "tuesday", "wednesday", "thursday", "friday"]));
    setWizardStart("09:00");
    setWizardEnd("17:00");
    setWizardLeadsMode("csv");
    setWizardBatchId("");
    setWizardCsvText("");
    setWizardCsvFilename("");
    setWizardContentGroups([newContentGroupDraft()]);
    setWizardFollowUps([]);
    setWizardOpen(true);
  }

  function closeWizard(): void {
    setWizardOpen(false);
  }

  function toggleWizardDay(day: string): void {
    setWizardDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  function toggleWizardAccount(accountId: string): void {
    setWizardAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function handleWizardCsvFileChosen(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        setWizardCsvText(text);
        setWizardCsvFilename(file.name);
      })
      .catch((err) => toast.showToast(String(err), "error"));
    e.target.value = "";
  }

  function updateContentGroup(index: number, patch: Partial<WizardContentGroupDraft>): void {
    setWizardContentGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }

  function addContentGroup(): void {
    setWizardContentGroups((prev) => [...prev, newContentGroupDraft()]);
  }

  function removeContentGroup(index: number): void {
    setWizardContentGroups((prev) => prev.filter((_, i) => i !== index));
  }

  function updateFollowUp(index: number, patch: Partial<WizardFollowUpDraft>): void {
    setWizardFollowUps((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function addFollowUp(): void {
    setWizardFollowUps((prev) => [...prev, newFollowUpDraft()]);
  }

  function removeFollowUp(index: number): void {
    setWizardFollowUps((prev) => prev.filter((_, i) => i !== index));
  }

  const wizardDetailsValid = Boolean(
    wizardName.trim() && wizardAccountIds.size > 0 && wizardTimezone && wizardDays.size > 0 && wizardStart && wizardEnd
  );
  const wizardLeadsValid = wizardLeadsMode === "batch" ? Boolean(wizardBatchId) : Boolean(wizardCsvText.trim());
  const wizardContentValid =
    wizardContentGroups.length > 0 &&
    wizardContentGroups.every((g) => g.subjectText.trim() && g.bodyText.trim() && Number(g.weight) > 0) &&
    wizardFollowUps.every((f) => f.bodyText.trim());

  function canAdvanceFromStep(step: number): boolean {
    if (step === 0) return wizardDetailsValid;
    if (step === 1) return wizardLeadsValid;
    if (step === 2) return wizardContentValid;
    return true;
  }

  async function handleLaunchWizard(): Promise<void> {
    setWizardBusy(true);
    try {
      const leadsSource: CreateCampaignWizardLeadsSource =
        wizardLeadsMode === "batch"
          ? { type: "batch", batchId: wizardBatchId }
          : { type: "csv", csvText: wizardCsvText, filename: wizardCsvFilename || undefined };

      const result = await window.outboundly.createCampaignFromWizard({
        name: wizardName,
        sendingAccountIds: [...wizardAccountIds],
        timezone: wizardTimezone,
        days: [...wizardDays],
        start: wizardStart,
        end: wizardEnd,
        contentGroups: wizardContentGroups.map((g) => ({
          subjectText: g.subjectText,
          bodyText: g.bodyText,
          weight: Number(g.weight) || 1
        })),
        followUpSteps: wizardFollowUps.map((f) => ({
          bodyText: f.bodyText,
          delayDays: Number(f.delayDays) || 0,
          delayHours: Number(f.delayHours) || 0
        })),
        leadsSource
      });

      await window.outboundly.setCampaignStatus({ campaignId: result.campaign.id, status: "running" });

      const skippedCount = result.enrollSkipped.length + (result.importSkipped?.length ?? 0);
      toast.showToast(`Campaign launched. Enrolled ${result.enrolled} lead(s)${skippedCount > 0 ? `, skipped ${skippedCount}` : ""}.`, "success");
      closeWizard();
      refreshAll();
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setWizardBusy(false);
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

  const totalWeight = wizardContentGroups.reduce((sum, g) => sum + (Number(g.weight) || 0), 0);

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Sending accounts and campaign creation, sequencing, and enrollment monitoring."
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

      {section === "campaigns" && (
        <>
          <Card style={{ marginBottom: "var(--space-6)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--space-4)" }}>
              <CardHeader title="Campaigns" description="Create a campaign with the guided wizard — everything it needs to launch is gathered in one flow." />
              <Button variant="primary" icon={<PlusIcon size={15} />} onClick={handleOpenWizard}>
                Create campaign
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

      <Modal
        open={wizardOpen}
        onClose={closeWizard}
        title={`Create campaign — ${WIZARD_STEP_LABELS[wizardStep]} (${wizardStep + 1}/${WIZARD_STEP_LABELS.length})`}
        width={720}
        footer={
          <>
            <Button variant="secondary" onClick={closeWizard} disabled={wizardBusy}>
              Cancel
            </Button>
            {wizardStep > 0 && (
              <Button variant="secondary" onClick={() => setWizardStep((s) => s - 1)} disabled={wizardBusy}>
                Back
              </Button>
            )}
            {wizardStep < WIZARD_STEP_LABELS.length - 1 ? (
              <Button variant="primary" disabled={!canAdvanceFromStep(wizardStep)} onClick={() => setWizardStep((s) => s + 1)}>
                Next
              </Button>
            ) : (
              <Button variant="primary" loading={wizardBusy} disabled={!wizardDetailsValid || !wizardLeadsValid || !wizardContentValid} onClick={handleLaunchWizard}>
                Launch campaign
              </Button>
            )}
          </>
        }
      >
        {wizardStep === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <Field label="Campaign name">
              <Input value={wizardName} onChange={(e) => setWizardName(e.target.value)} placeholder="e.g. Q3 outbound" />
            </Field>
            <Field label="Sending accounts">
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {accounts.map((a) => (
                  <Checkbox
                    key={a.id}
                    checked={wizardAccountIds.has(a.id)}
                    onChange={() => toggleWizardAccount(a.id)}
                    label={`${a.emailAddress}${a.status === "reauth_required" ? " (reconnect needed)" : ""}${a.status === "disconnected" ? " (disconnected)" : ""}`}
                  />
                ))}
              </div>
              <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginTop: "var(--space-2)" }}>
                Selecting more than one adds capacity by rotating between them -- each lead still gets every email in its
                sequence from the same account, so a reply thread never switches senders mid-conversation.
              </p>
            </Field>
            <Field label="Timezone">
              <Select value={wizardTimezone} onChange={(e) => setWizardTimezone(e.target.value)}>
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
            <Field label="Sending days">
              <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
                {WEEKDAYS.map((day) => (
                  <Checkbox key={day} checked={wizardDays.has(day)} onChange={() => toggleWizardDay(day)} label={WEEKDAY_LABELS[day]} />
                ))}
              </div>
            </Field>
            <div style={{ display: "flex", gap: "1rem" }}>
              <Field label="Sending hours from">
                <Input type="time" value={wizardStart} onChange={(e) => setWizardStart(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="time" value={wizardEnd} onChange={(e) => setWizardEnd(e.target.value)} />
              </Field>
            </div>
          </div>
        )}

        {wizardStep === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <p style={{ fontSize: "12.5px", color: "var(--color-text-tertiary)" }}>
              This campaign only ever sends to the leads chosen here -- not your whole global contacts list. Each import is its
              own isolated batch of leads for this campaign.
            </p>

            {leadImportBatches.length > 0 && (
              <Field label="Use a previous import">
                <Select
                  value={wizardLeadsMode === "batch" ? wizardBatchId : ""}
                  onChange={(e) => {
                    if (e.target.value) {
                      setWizardLeadsMode("batch");
                      setWizardBatchId(e.target.value);
                    } else {
                      setWizardLeadsMode("csv");
                      setWizardBatchId("");
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

            {wizardLeadsMode === "csv" && (
              <>
                <input ref={wizardCsvFileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={handleWizardCsvFileChosen} />
                <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", flexWrap: "wrap" }}>
                  <Button variant="secondary" size="sm" onClick={() => wizardCsvFileInputRef.current?.click()}>
                    Choose file...
                  </Button>
                  <div style={{ flex: "1 1 200px" }}>
                    <Field label="Import label">
                      <Input value={wizardCsvFilename} onChange={(e) => setWizardCsvFilename(e.target.value)} placeholder="e.g. leads-march.csv" />
                    </Field>
                  </div>
                </div>
                <Field label="CSV contents">
                  <Textarea
                    value={wizardCsvText}
                    onChange={(e) => setWizardCsvText(e.target.value)}
                    rows={8}
                    placeholder="email,first_name,last_name,company"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "12.5px" }}
                  />
                </Field>
              </>
            )}
          </div>
        )}

        {wizardStep === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
            <div>
              <CardHeader
                title="First email"
                description="Add more than one template/subject group to split-test — each group's subject only ever goes out with that same group's template, never mixed with another group's."
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {wizardContentGroups.map((group, index) => (
                  <div key={index} style={{ padding: "var(--space-3)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)" }}>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
                      <strong style={{ fontSize: "12.5px", paddingBottom: "8px", whiteSpace: "nowrap" }}>Group {index + 1}</strong>
                      <div style={{ flex: 1 }}>
                        <Field label="Subject line">
                          <Input value={group.subjectText} onChange={(e) => updateContentGroup(index, { subjectText: e.target.value })} />
                        </Field>
                      </div>
                      <div style={{ width: 90 }}>
                        <Field label="Weight %">
                          <Input
                            type="number"
                            min={1}
                            value={group.weight}
                            onChange={(e) => updateContentGroup(index, { weight: e.target.value })}
                          />
                        </Field>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<TrashIcon size={14} />}
                        disabled={wizardContentGroups.length === 1}
                        onClick={() => removeContentGroup(index)}
                      />
                    </div>
                    <Field label="Template body">
                      <Textarea value={group.bodyText} onChange={(e) => updateContentGroup(index, { bodyText: e.target.value })} rows={4} />
                    </Field>
                    {totalWeight > 0 && (
                      <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)", marginTop: "var(--space-2)" }}>
                        ~{Math.round(((Number(group.weight) || 0) / totalWeight) * 100)}% of first-touch emails
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: "var(--space-3)" }}>
                <Button variant="secondary" size="sm" icon={<PlusIcon size={14} />} onClick={addContentGroup}>
                  Add another template/subject group
                </Button>
              </div>
            </div>

            <div>
              <CardHeader
                title="Follow-ups (optional)"
                description={`Sent as a reply ("Re: ...") to the first email -- no separate subject or split-testing needed.`}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {wizardFollowUps.map((step, index) => (
                  <div key={index} style={{ padding: "var(--space-3)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)" }}>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
                      <strong style={{ fontSize: "12.5px", paddingBottom: "8px", whiteSpace: "nowrap" }}>Follow-up {index + 1}</strong>
                      <div style={{ width: 90 }}>
                        <Field label="Days after">
                          <Input type="number" min={0} value={step.delayDays} onChange={(e) => updateFollowUp(index, { delayDays: e.target.value })} />
                        </Field>
                      </div>
                      <div style={{ width: 90 }}>
                        <Field label="Hours">
                          <Input type="number" min={0} max={23} value={step.delayHours} onChange={(e) => updateFollowUp(index, { delayHours: e.target.value })} />
                        </Field>
                      </div>
                      <Button variant="ghost" size="sm" icon={<TrashIcon size={14} />} onClick={() => removeFollowUp(index)} />
                    </div>
                    <Field label="Template body">
                      <Textarea value={step.bodyText} onChange={(e) => updateFollowUp(index, { bodyText: e.target.value })} rows={3} />
                    </Field>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: "var(--space-3)" }}>
                <Button variant="secondary" size="sm" icon={<PlusIcon size={14} />} onClick={addFollowUp}>
                  Add follow-up step
                </Button>
              </div>
            </div>
          </div>
        )}

        {wizardStep === 3 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", fontSize: "13.5px" }}>
            <div>
              <strong>{wizardName}</strong>
              <p style={{ color: "var(--color-text-secondary)" }}>
                {[...wizardAccountIds].map((id) => accounts.find((a) => a.id === id)?.emailAddress ?? id).join(", ")} · {wizardTimezone} ·{" "}
                {wizardStart}–{wizardEnd} · {[...wizardDays].map((d) => WEEKDAY_LABELS[d]).join(", ")}
              </p>
            </div>
            <div>
              <strong>Leads</strong>
              <p style={{ color: "var(--color-text-secondary)" }}>
                {wizardLeadsMode === "batch"
                  ? leadImportBatches.find((b) => b.id === wizardBatchId)?.filename ?? "Selected import batch"
                  : wizardCsvFilename || "Pasted CSV"}
              </p>
            </div>
            <div>
              <strong>
                First email — {wizardContentGroups.length} template/subject group{wizardContentGroups.length === 1 ? "" : "s"}
              </strong>
              <ul style={{ color: "var(--color-text-secondary)", marginLeft: "1.2rem" }}>
                {wizardContentGroups.map((g, i) => (
                  <li key={i}>
                    "{g.subjectText}" — {totalWeight > 0 ? Math.round(((Number(g.weight) || 0) / totalWeight) * 100) : 0}%
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>Follow-ups</strong>
              <p style={{ color: "var(--color-text-secondary)" }}>
                {wizardFollowUps.length === 0
                  ? "None"
                  : wizardFollowUps.map((f, i) => `#${i + 1}: ${f.delayDays}d ${f.delayHours}h after the previous step`).join(" · ")}
              </p>
            </div>
            <p style={{ fontSize: "12.5px", color: "var(--color-text-tertiary)" }}>
              Launching enrolls the leads above and starts sending immediately, within the schedule set on the first step.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
