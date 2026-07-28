import { useEffect, useState } from "react";
import type { AccountSummary, AppPreferencesSummary, BusinessHoursProfileSummary } from "../../ipc-boundary/contracts.js";

/**
 * The Phase 5 "minimal" Settings screen (Section 3: "User preferences, sending defaults,
 * signatures-by-account, business hours"). Business hours profiles themselves are authored on the
 * Campaigns screen (Section 5.7) -- this screen only lets a user pick one of the existing profiles
 * as a default, plus per-account signatures.
 */
export function SettingsScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [businessHoursProfiles, setBusinessHoursProfiles] = useState<BusinessHoursProfileSummary[]>([]);
  const [preferences, setPreferences] = useState<AppPreferencesSummary>({});
  const [signatureDrafts, setSignatureDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  function refresh(): void {
    window.outboundly
      .listAccounts()
      .then((list) => {
        setAccounts(list);
        setSignatureDrafts((prev) => {
          const next = { ...prev };
          for (const a of list) {
            if (next[a.id] === undefined) next[a.id] = a.signatureText ?? "";
          }
          return next;
        });
      })
      .catch((err) => setError(String(err)));
    window.outboundly.listBusinessHoursProfiles().then(setBusinessHoursProfiles).catch((err) => setError(String(err)));
    window.outboundly.getAppPreferences().then(setPreferences).catch((err) => setError(String(err)));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSaveSignature(accountId: string): Promise<void> {
    setError(null);
    setSavedMessage(null);
    try {
      const text = signatureDrafts[accountId] ?? "";
      const updated = await window.outboundly.updateAccountSignature({
        accountId,
        signatureText: text.trim() === "" ? undefined : text
      });
      setAccounts((prev) => prev.map((a) => (a.id === accountId ? updated : a)));
      setSavedMessage("Signature saved.");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveDefaultBusinessHours(profileId: string): Promise<void> {
    setError(null);
    try {
      const updated = await window.outboundly.updateAppPreferences({ defaultBusinessHoursProfileId: profileId || undefined });
      setPreferences(updated);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveDefaultAccount(accountId: string): Promise<void> {
    setError(null);
    try {
      const updated = await window.outboundly.updateAppPreferences({ defaultSendingAccountId: accountId || undefined });
      setPreferences(updated);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 700, margin: "2rem auto" }}>
      <h1>Outboundly — Settings (Phase 5)</h1>

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}
      {savedMessage && <p style={{ color: "green" }}>{savedMessage}</p>}

      <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>Sending defaults</h2>
        <p style={{ color: "#666", fontSize: "0.85rem" }}>
          Pre-fills the Campaigns screen's "create campaign" form -- doesn't change any existing campaign.
        </p>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          Default business hours profile:{" "}
          <select
            value={preferences.defaultBusinessHoursProfileId ?? ""}
            onChange={(e) => handleSaveDefaultBusinessHours(e.target.value)}
          >
            <option value="">None</option>
            {businessHoursProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "block" }}>
          Default sending account:{" "}
          <select value={preferences.defaultSendingAccountId ?? ""} onChange={(e) => handleSaveDefaultAccount(e.target.value)}>
            <option value="">None</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emailAddress}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section style={{ border: "1px solid #ddd", padding: "0.75rem" }}>
        <h2>Signatures by account</h2>
        {accounts.length === 0 && <p>No accounts connected yet.</p>}
        {accounts.map((a) => (
          <div key={a.id} style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem" }}>
              <strong>{a.emailAddress}</strong>
            </label>
            <textarea
              value={signatureDrafts[a.id] ?? ""}
              onChange={(e) => setSignatureDrafts((prev) => ({ ...prev, [a.id]: e.target.value }))}
              rows={3}
              style={{ width: "100%", marginBottom: "0.25rem" }}
              placeholder="Best,&#10;Your name"
            />
            <button onClick={() => handleSaveSignature(a.id)}>Save signature</button>
          </div>
        ))}
      </section>
    </div>
  );
}
