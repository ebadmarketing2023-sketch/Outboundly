import { useEffect, useState } from "react";
import type { ContactSummary, ImportContactsCsvResponse } from "../../ipc-boundary/contracts.js";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
  Table,
  TableRow,
  Td,
  Textarea,
  Th,
  UploadIcon,
  UsersIcon,
  useToast
} from "../components/index.js";

/**
 * The Phase 4 "minimal" Leads UI (Section 5.5): paste-a-CSV import and a plain contact list —
 * proves the CSV import pipeline end-to-end. A file picker, column-mapping UI, and CSV export
 * are later increments.
 */
export function LeadsScreen(): JSX.Element {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [csvText, setCsvText] = useState("email,first_name,last_name,company\nlead@example.com,Ada,Lovelace,Analytical Engines");
  const [importResult, setImportResult] = useState<ImportContactsCsvResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function refreshContacts(): void {
    window.outboundly
      .listContacts()
      .then(setContacts)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refreshContacts();
  }, []);

  async function handleImport(): Promise<void> {
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const result = await window.outboundly.importContactsCsv({ csvText });
      setImportResult(result);
      refreshContacts();
      toast.showToast(`Imported ${result.imported} contact(s).`, result.skipped.length > 0 ? "info" : "success");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Leads" description="Import contacts from a CSV and manage your lead list." />

      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "var(--space-6)" }}>
        <CardHeader title="Import contacts from CSV" description="First row must be a header: email, first_name, last_name, company." />
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
          <CardHeader title={`Contacts (${contacts.length})`} />
        </div>
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-8)" }}>
            <Spinner size={22} />
          </div>
        ) : contacts.length === 0 ? (
          <EmptyState icon={<UsersIcon size={20} />} title="No contacts yet" description="Import a CSV above to add your first leads." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Contact</Th>
                <Th>Company</Th>
                <Th>Source</Th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => {
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
                  </TableRow>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
