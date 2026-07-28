import { useEffect, useState } from "react";
import type { ContactSummary, ImportContactsCsvResponse } from "../../ipc-boundary/contracts.js";

/**
 * The Phase 4 "minimal" Leads UI (Section 5.5): paste-a-CSV import and a plain contact list —
 * proves the CSV import pipeline end-to-end. A file picker, column-mapping UI, and CSV export
 * are later increments.
 */
export function LeadsScreen(): JSX.Element {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [csvText, setCsvText] = useState("email,first_name,last_name,company\nlead@example.com,Ada,Lovelace,Analytical Engines");
  const [importResult, setImportResult] = useState<ImportContactsCsvResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refreshContacts(): void {
    window.outboundly
      .listContacts()
      .then(setContacts)
      .catch((err) => setError(String(err)));
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
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 800, margin: "2rem auto" }}>
      <h1>Outboundly — Leads (Phase 4)</h1>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2>Import contacts from CSV</h2>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={6}
          style={{ width: "100%", fontFamily: "monospace" }}
        />
        <div style={{ marginTop: "0.5rem" }}>
          <button onClick={handleImport} disabled={busy}>
            {busy ? "Importing..." : "Import"}
          </button>
        </div>

        {error && (
          <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
            <strong>Error:</strong> {error}
          </p>
        )}

        {importResult && (
          <p>
            Imported {importResult.imported} contact(s).
            {importResult.skipped.length > 0 && ` Skipped ${importResult.skipped.length}:`}
            {importResult.skipped.length > 0 && (
              <ul>
                {importResult.skipped.map((s, i) => (
                  <li key={i}>
                    Row {s.row}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </p>
        )}
      </section>

      <section>
        <h2>Contacts ({contacts.length})</h2>
        {contacts.length === 0 && <p>No contacts yet.</p>}
        {contacts.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                <th>Email</th>
                <th>Name</th>
                <th>Company</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td>{c.email}</td>
                  <td>{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td>{c.company ?? "—"}</td>
                  <td>{c.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
