import { useEffect, useMemo, useRef, useState } from "react";
import type { ContactSummary, ImportContactsCsvResponse, LeadImportBatchSummary, SuppressionEntrySummary } from "../../ipc-boundary/contracts.js";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  TableRow,
  Td,
  Textarea,
  Th,
  TrashIcon,
  UploadIcon,
  UsersIcon,
  useToast
} from "../components/index.js";
import { formatDateTime } from "../lib/format.js";

const ALL_BATCHES = "all";
const NO_BATCH = "__none__";

/**
 * The Leads UI (Section 5.5, Critical Improvement #3): CSV import (either a real file or pasted
 * text), grouped by the CSV import batch it came from with a switcher and per-group search, and a
 * per-lead delete action. A contact never imported via CSV (e.g. created from an inbound reply)
 * has no batch and only shows up under "All contacts."
 */
export function LeadsScreen(): JSX.Element {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [batches, setBatches] = useState<LeadImportBatchSummary[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string>(ALL_BATCHES);
  const [searchQuery, setSearchQuery] = useState("");
  const [csvText, setCsvText] = useState("email,first_name,last_name,company\nlead@example.com,Ada,Lovelace,Analytical Engines");
  const [csvFilename, setCsvFilename] = useState("");
  const [importResult, setImportResult] = useState<ImportContactsCsvResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suppressionEntries, setSuppressionEntries] = useState<SuppressionEntrySummary[]>([]);
  const [suppressionLoading, setSuppressionLoading] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<SuppressionEntrySummary | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContactSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteBatchTarget, setDeleteBatchTarget] = useState<LeadImportBatchSummary | null>(null);
  const [deleteBatchBusy, setDeleteBatchBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  function refreshContacts(): void {
    window.outboundly
      .listContacts()
      .then(setContacts)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  function refreshBatches(): void {
    window.outboundly.listLeadImportBatches().then(setBatches).catch((err) => setError(String(err)));
  }

  function refreshSuppressionEntries(): void {
    window.outboundly
      .listSuppressionEntries()
      .then(setSuppressionEntries)
      .catch((err) => setError(String(err)))
      .finally(() => setSuppressionLoading(false));
  }

  useEffect(() => {
    refreshContacts();
    refreshBatches();
    refreshSuppressionEntries();
  }, []);

  async function handleRemoveSuppression(): Promise<void> {
    if (!removeTarget) return;
    setRemovingBusy(true);
    try {
      await window.outboundly.removeSuppressionEntry({ email: removeTarget.email });
      refreshSuppressionEntries();
      toast.showToast(`${removeTarget.email} removed from the suppression list.`, "success");
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setRemovingBusy(false);
      setRemoveTarget(null);
    }
  }

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    file
      .text()
      .then((text) => {
        setCsvText(text);
        setCsvFilename(file.name);
      })
      .catch((err) => setError(String(err)));
    e.target.value = "";
  }

  async function handleImport(): Promise<void> {
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const result = await window.outboundly.importContactsCsv({ csvText, filename: csvFilename || undefined });
      setImportResult(result);
      refreshContacts();
      refreshBatches();
      setSelectedBatchId(result.batchId);
      toast.showToast(`Imported ${result.imported} contact(s).`, result.skipped.length > 0 ? "info" : "success");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await window.outboundly.deleteContact({ contactId: deleteTarget.id });
      refreshContacts();
      refreshBatches();
      toast.showToast(`${deleteTarget.email} deleted.`, "success");
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  }

  async function handleConfirmDeleteBatch(): Promise<void> {
    if (!deleteBatchTarget) return;
    setDeleteBatchBusy(true);
    try {
      await window.outboundly.deleteLeadImportBatch({ batchId: deleteBatchTarget.id });
      setSelectedBatchId(ALL_BATCHES);
      refreshContacts();
      refreshBatches();
      toast.showToast(`"${deleteBatchTarget.filename}" deleted.`, "success");
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setDeleteBatchBusy(false);
      setDeleteBatchTarget(null);
    }
  }

  const visibleContacts = useMemo(() => {
    const byBatch =
      selectedBatchId === ALL_BATCHES
        ? contacts
        : selectedBatchId === NO_BATCH
          ? contacts.filter((c) => !c.importBatchId)
          : contacts.filter((c) => c.importBatchId === selectedBatchId);
    const query = searchQuery.trim().toLowerCase();
    if (!query) return byBatch;
    return byBatch.filter((c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ").toLowerCase();
      return c.email.toLowerCase().includes(query) || name.includes(query) || (c.company ?? "").toLowerCase().includes(query);
    });
  }, [contacts, selectedBatchId, searchQuery]);

  const uncategorizedCount = contacts.filter((c) => !c.importBatchId).length;

  return (
    <div>
      <PageHeader title="Leads" description="Import contacts from a CSV and manage your lead list." />

      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "var(--space-6)" }}>
        <CardHeader title="Import contacts from CSV" description="Choose a CSV file, or paste/edit its contents below. First row must be a header: email, first_name, last_name, company." />
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center", marginBottom: "var(--space-3)", flexWrap: "wrap" }}>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={handleFileChosen} />
          <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
            Choose file...
          </Button>
          <div style={{ flex: "1 1 220px" }}>
            <Field label="Import label (shown as the group name)">
              <Input value={csvFilename} onChange={(e) => setCsvFilename(e.target.value)} placeholder="e.g. leads-march.csv" />
            </Field>
          </div>
        </div>
        <Textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={6} style={{ fontFamily: "var(--font-mono)", fontSize: "12.5px" }} />
        <div style={{ marginTop: "var(--space-4)" }}>
          <Button variant="primary" icon={<UploadIcon size={15} />} loading={busy} onClick={handleImport}>
            Import
          </Button>
        </div>

        {importResult && (
          <div style={{ marginTop: "var(--space-4)", fontSize: "13px", color: "var(--color-text-secondary)" }}>
            <p>
              Imported <strong style={{ color: "var(--color-text-primary)" }}>{importResult.imported}</strong> contact(s).
              {importResult.skipped.length > 0 && ` Skipped ${importResult.skipped.length}:`}
            </p>
            {importResult.skipped.length > 0 && (
              <ul style={{ marginTop: "6px", paddingLeft: "1.1rem" }}>
                {importResult.skipped.map((s, i) => (
                  <li key={i}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card padding="none">
        <div style={{ padding: "var(--space-6) var(--space-6) 0" }}>
          <CardHeader title={`Contacts (${visibleContacts.length} of ${contacts.length})`} />
        </div>
        <div style={{ display: "flex", gap: "var(--space-3)", padding: "0 var(--space-6) var(--space-4)", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 240px" }}>
            <Field label="Group (by CSV import)">
              <Select value={selectedBatchId} onChange={(e) => setSelectedBatchId(e.target.value)}>
                <option value={ALL_BATCHES}>All contacts ({contacts.length})</option>
                {batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.filename} ({b.contactCount}) — {formatDateTime(b.importedAt)}
                  </option>
                ))}
                {uncategorizedCount > 0 && <option value={NO_BATCH}>Not imported via CSV ({uncategorizedCount})</option>}
              </Select>
            </Field>
          </div>
          <div style={{ flex: "1 1 240px" }}>
            <Field label="Search">
              <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Name, email, or company..." />
            </Field>
          </div>
          {selectedBatchId !== ALL_BATCHES && selectedBatchId !== NO_BATCH && (
            <Button
              variant="danger-ghost"
              size="sm"
              icon={<TrashIcon size={14} />}
              onClick={() => {
                const batch = batches.find((b) => b.id === selectedBatchId);
                if (batch) setDeleteBatchTarget(batch);
              }}
            >
              Delete this import
            </Button>
          )}
        </div>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-8)" }}>
            <Spinner size={22} />
          </div>
        ) : visibleContacts.length === 0 ? (
          <EmptyState icon={<UsersIcon size={20} />} title="No contacts found" description="Import a CSV above, or adjust the group/search filter." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Contact</Th>
                <Th>Company</Th>
                <Th>Source</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visibleContacts.map((c) => {
                const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
                return (
                  <TableRow key={c.id}>
                    <Td>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                        <Avatar name={name || c.email} size={26} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 550 }}>{name || "—"}</div>
                          <div style={{ fontSize: "12.5px", color: "var(--color-text-tertiary)" }}>{c.email}</div>
                        </div>
                      </div>
                    </Td>
                    <Td>{c.company ?? "—"}</Td>
                    <Td>
                      <Badge tone="neutral">{c.source}</Badge>
                    </Td>
                    <Td align="right">
                      <Button variant="danger-ghost" size="sm" icon={<TrashIcon size={14} />} onClick={() => setDeleteTarget(c)}>
                        Delete
                      </Button>
                    </Td>
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card padding="none" style={{ marginTop: "var(--space-6)" }}>
        <div style={{ padding: "var(--space-6) var(--space-6) 0" }}>
          <CardHeader
            title={`Suppressed contacts (${suppressionEntries.length})`}
            description="Unsubscribed, bounced, or manually suppressed emails. These are never enrolled or sent to by any campaign. Removing an entry only restores future eligibility here — it does not resend or alter any past message."
          />
        </div>
        {suppressionLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-8)" }}>
            <Spinner size={22} />
          </div>
        ) : suppressionEntries.length === 0 ? (
          <EmptyState icon={<UsersIcon size={20} />} title="No suppressed contacts" description="Contacts who unsubscribe or bounce will show up here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Reason</Th>
                <Th>Suppressed since</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {suppressionEntries.map((entry) => (
                <TableRow key={entry.id}>
                  <Td>{entry.email}</Td>
                  <Td>
                    <Badge tone="neutral">{entry.reason}</Badge>
                  </Td>
                  <Td>{formatDateTime(entry.createdAt)}</Td>
                  <Td>
                    <Button variant="danger-ghost" size="sm" icon={<TrashIcon size={14} />} onClick={() => setRemoveTarget(entry)}>
                      Remove
                    </Button>
                  </Td>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove from suppression list?"
        description={`${removeTarget?.email ?? "This contact"} will become eligible for campaign enrollment and sends again. This only changes local eligibility — it does not send anything, and has no effect on how any provider (e.g. Gmail) files future mail into folders like Promotions.`}
        confirmLabel="Remove"
        danger
        busy={removingBusy}
        onConfirm={handleRemoveSuppression}
        onCancel={() => setRemoveTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this lead?"
        description={`${deleteTarget?.email ?? "This contact"} will be removed from the Leads list. Any campaign they're actively enrolled in will stop sending to them; past message history and analytics are preserved.`}
        confirmLabel="Delete"
        danger
        busy={deleteBusy}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={deleteBatchTarget !== null}
        title="Delete this entire import?"
        description={`Every contact from "${deleteBatchTarget?.filename ?? "this import"}" (${deleteBatchTarget?.contactCount ?? 0} contact(s)) will be removed from the Leads list. Any campaign they're actively enrolled in will stop sending to them; past message history and analytics are preserved. This can't be undone.`}
        confirmLabel="Delete import"
        danger
        busy={deleteBatchBusy}
        onConfirm={handleConfirmDeleteBatch}
        onCancel={() => setDeleteBatchTarget(null)}
      />
    </div>
  );
}
