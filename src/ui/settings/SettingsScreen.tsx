import { useEffect, useState } from "react";
import type { AccountSummary, AppPreferencesSummary, BusinessHoursProfileSummary } from "../../ipc-boundary/contracts.js";
import {
  AccountStatusBadge,
  Avatar,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DownloadIcon,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  TableRow,
  Td,
  Textarea,
  Th,
  UploadIcon,
  useToast
} from "../components/index.js";

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
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<AccountSummary | null>(null);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const toast = useToast();

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
    try {
      const text = signatureDrafts[accountId] ?? "";
      const updated = await window.outboundly.updateAccountSignature({ accountId, signatureText: text.trim() === "" ? undefined : text });
      setAccounts((prev) => prev.map((a) => (a.id === accountId ? updated : a)));
      toast.showToast("Signature saved.", "success");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveDefaultBusinessHours(profileId: string): Promise<void> {
    setError(null);
    try {
      const updated = await window.outboundly.updateAppPreferences({ defaultBusinessHoursProfileId: profileId || undefined });
      setPreferences(updated);
      toast.showToast("Default saved.", "success");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSaveDefaultAccount(accountId: string): Promise<void> {
    setError(null);
    try {
      const updated = await window.outboundly.updateAppPreferences({ defaultSendingAccountId: accountId || undefined });
      setPreferences(updated);
      toast.showToast("Default saved.", "success");
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDisconnect(): Promise<void> {
    if (!disconnectTarget) return;
    setDisconnectBusy(true);
    try {
      const updated = await window.outboundly.disconnectAccount({ accountId: disconnectTarget.id });
      setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      toast.showToast(`${disconnectTarget.emailAddress} disconnected.`, "success");
    } catch (err) {
      toast.showToast(String(err), "error");
    } finally {
      setDisconnectBusy(false);
      setDisconnectTarget(null);
    }
  }

  async function handleExportBackup(): Promise<void> {
    setError(null);
    if (exportPassphrase.trim() === "") {
      toast.showToast("Enter a passphrase for the backup first.", "error");
      return;
    }
    setBackupBusy(true);
    try {
      const result = await window.outboundly.exportBackup({ passphrase: exportPassphrase });
      if (result.exported) {
        toast.showToast(`Backup exported to ${result.filePath}. Keep the passphrase safe.`, "success");
        setExportPassphrase("");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreBackup(): Promise<void> {
    setConfirmRestoreOpen(false);
    setError(null);
    setBackupBusy(true);
    try {
      const result = await window.outboundly.restoreBackup({ passphrase: restorePassphrase });
      if (!result.restored) setBackupBusy(false); // user cancelled the file picker -- otherwise the app is about to restart
    } catch (err) {
      setError(String(err));
      setBackupBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader title="Settings" description="Sending defaults, signatures, and backup & restore." />

      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "var(--space-6)" }} padding="none">
        <div style={{ padding: "var(--space-6) var(--space-6) 0" }}>
          <CardHeader
            title="Connected accounts"
            description="Disconnecting revokes this app's local access to the account -- it can no longer send or sync until you reconnect. Nothing else about the account is deleted."
          />
        </div>
        {accounts.length === 0 ? (
          <p style={{ fontSize: "13.5px", color: "var(--color-text-secondary)", padding: "0 var(--space-6) var(--space-6)" }}>
            No accounts connected yet — connect one from the Compose screen.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Provider</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <TableRow key={a.id}>
                  <Td>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <Avatar name={a.displayName ?? a.emailAddress} size={24} />
                      {a.emailAddress}
                    </div>
                  </Td>
                  <Td>{a.provider}</Td>
                  <Td>
                    <AccountStatusBadge status={a.status} />
                  </Td>
                  <Td>
                    {a.status !== "disconnected" && (
                      <Button variant="danger-ghost" size="sm" onClick={() => setDisconnectTarget(a)}>
                        Disconnect
                      </Button>
                    )}
                  </Td>
                </TableRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card style={{ marginBottom: "var(--space-6)" }}>
        <CardHeader title="Sending defaults" description="Pre-fills the Campaigns screen's create-campaign form — doesn't change any existing campaign." />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
          <Field label="Default business hours profile">
            <Select value={preferences.defaultBusinessHoursProfileId ?? ""} onChange={(e) => handleSaveDefaultBusinessHours(e.target.value)}>
              <option value="">None</option>
              {businessHoursProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default sending account">
            <Select value={preferences.defaultSendingAccountId ?? ""} onChange={(e) => handleSaveDefaultAccount(e.target.value)}>
              <option value="">None</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.emailAddress}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card style={{ marginBottom: "var(--space-6)" }}>
        <CardHeader title="Signatures by account" />
        {accounts.length === 0 ? (
          <p style={{ fontSize: "13.5px", color: "var(--color-text-secondary)" }}>No accounts connected yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
            {accounts.map((a) => (
              <div key={a.id}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "8px" }}>
                  <Avatar name={a.displayName ?? a.emailAddress} size={24} />
                  <strong style={{ fontSize: "13.5px" }}>{a.emailAddress}</strong>
                </div>
                <Textarea
                  value={signatureDrafts[a.id] ?? ""}
                  onChange={(e) => setSignatureDrafts((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  rows={3}
                  placeholder={"Best,\nYour name"}
                />
                <div style={{ marginTop: "8px" }}>
                  <Button variant="secondary" size="sm" onClick={() => handleSaveSignature(a.id)}>
                    Save signature
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Backup & restore"
          description="Backups are encrypted with a passphrase you choose here, separate from this app's own at-rest encryption key. Losing the passphrase means the backup can't be restored."
        />
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <Field label="Backup passphrase">
                <Input type="password" value={exportPassphrase} onChange={(e) => setExportPassphrase(e.target.value)} />
              </Field>
            </div>
            <Button variant="primary" icon={<DownloadIcon size={15} />} loading={backupBusy} onClick={handleExportBackup}>
              Export backup...
            </Button>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <Field label="Backup's passphrase">
                <Input
                  type="password"
                  value={restorePassphrase}
                  onChange={(e) => setRestorePassphrase(e.target.value)}
                />
              </Field>
            </div>
            <Button
              variant="secondary"
              icon={<UploadIcon size={15} />}
              loading={backupBusy}
              disabled={restorePassphrase.trim() === ""}
              onClick={() => setConfirmRestoreOpen(true)}
            >
              Restore from backup...
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmRestoreOpen}
        title="Restore from backup?"
        description="Restoring replaces all current data in this app with the backup's contents, and the app will restart. This cannot be undone."
        confirmLabel="Restore"
        danger
        busy={backupBusy}
        onConfirm={handleRestoreBackup}
        onCancel={() => setConfirmRestoreOpen(false)}
      />

      <ConfirmDialog
        open={disconnectTarget !== null}
        title="Disconnect this account?"
        description={`${disconnectTarget?.emailAddress ?? "This account"} will no longer be able to send or sync until you reconnect it (sign in again from the Compose screen). Its message history, drafts, and campaigns are kept.`}
        confirmLabel="Disconnect"
        danger
        busy={disconnectBusy}
        onConfirm={handleDisconnect}
        onCancel={() => setDisconnectTarget(null)}
      />
    </div>
  );
}
