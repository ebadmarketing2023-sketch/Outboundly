import { useEffect, useState } from "react";
import type { AccountSummary, DraftSummary, SendDraftResponse } from "../../ipc-boundary/contracts.js";
import {
  AccountStatusBadge,
  Avatar,
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  ErrorBanner,
  Field,
  Input,
  Modal,
  PageHeader,
  PlusIcon,
  Select,
  SendIcon,
  Textarea,
  useToast
} from "../components/index.js";
import { formatDateTime } from "../lib/format.js";

/**
 * The Phase 1 "minimal" compose UI (Task 9): plain To/Subject/Body fields exercising the real
 * pipeline end-to-end (Draft Lifecycle -> Rendering -> MIME -> Gmail Compatibility Layer ->
 * Gmail send). A rich Tiptap-based editor (Section 22) is a later increment — this screen exists
 * to validate the pipeline, not to be the final compose experience.
 */
export function ComposeScreen(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<DraftSummary | null>(null);
  const [sendResult, setSendResult] = useState<SendDraftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const toast = useToast();

  const [showSmtpImapModal, setShowSmtpImapModal] = useState(false);
  const [smtpImapEmail, setSmtpImapEmail] = useState("");
  const [smtpImapDisplayName, setSmtpImapDisplayName] = useState("");
  const [smtpImapUsername, setSmtpImapUsername] = useState("");
  const [smtpImapPassword, setSmtpImapPassword] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState(true);

  useEffect(() => {
    window.outboundly
      .listAccounts()
      .then((list) => {
        setAccounts(list);
        if (list.length > 0 && !selectedAccountId) setSelectedAccountId(list[0]!.id);
      })
      .catch((err) => setError(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Settings module (Section 3: "signatures-by-account") -- prefill a brand-new, still-untouched
  // draft's body with the selected account's signature. Only applies before any real drafting has
  // started, so it never clobbers in-progress edits or a loaded existing draft.
  useEffect(() => {
    if (draft || body.trim() !== "") return;
    const signature = accounts.find((a) => a.id === selectedAccountId)?.signatureText;
    if (signature) setBody(`\n\n${signature}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, accounts]);

  async function handleConnectGoogle(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const account = await window.outboundly.connectGoogleAccount();
      setAccounts((prev) => [...prev, account]);
      setSelectedAccountId(account.id);
      toast.showToast(`Connected ${account.emailAddress}.`, "success");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectMicrosoft(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const account = await window.outboundly.connectMicrosoftAccount();
      setAccounts((prev) => [...prev, account]);
      setSelectedAccountId(account.id);
      toast.showToast(`Connected ${account.emailAddress}.`, "success");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectSmtpImap(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const account = await window.outboundly.connectSmtpImapAccount({
        emailAddress: smtpImapEmail,
        displayName: smtpImapDisplayName || undefined,
        username: smtpImapUsername || smtpImapEmail,
        password: smtpImapPassword,
        smtpHost,
        smtpPort: Number(smtpPort),
        smtpSecure,
        imapHost,
        imapPort: Number(imapPort),
        imapSecure
      });
      setAccounts((prev) => [...prev, account]);
      setSelectedAccountId(account.id);
      setShowSmtpImapModal(false);
      toast.showToast(`Connected ${account.emailAddress}.`, "success");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDraft(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const toList = to
        .split(",")
        .map((addr) => addr.trim())
        .filter(Boolean);

      if (draft) {
        const updated = await window.outboundly.autosaveDraft({ draftId: draft.id, subject, body });
        setDraft(updated);
      } else {
        const created = await window.outboundly.createDraft({ accountId: selectedAccountId, subject, to: toList, body });
        setDraft(created);
      }
      toast.showToast("Draft saved.", "success");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSend(): Promise<void> {
    if (!draft) {
      setError("Save the draft before sending.");
      return;
    }
    setConfirmSendOpen(false);
    setError(null);
    setBusy(true);
    setSendResult(null);
    try {
      const result = await window.outboundly.sendDraft({ draftId: draft.id });
      setSendResult(result);
      toast.showToast(result.sent ? "Message sent." : "Send was blocked — see the report below.", result.sent ? "success" : "error");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader title="Compose" description="Write and send a message through one of your connected accounts." />

      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "var(--space-6)" }}>
        <CardHeader title="Sending account" />
        {accounts.length === 0 ? (
          <p style={{ fontSize: "13.5px", color: "var(--color-text-secondary)", marginBottom: "var(--space-4)" }}>
            No accounts connected yet — connect one below to start composing.
          </p>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "var(--space-4)" }}>
            {selectedAccount && <Avatar name={selectedAccount.displayName ?? selectedAccount.emailAddress} />}
            <Select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} style={{ maxWidth: 360 }}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress}
                  {a.status === "reauth_required" ? " (reconnect needed)" : ""}
                </option>
              ))}
            </Select>
            {selectedAccount && selectedAccount.status !== "connected" && <AccountStatusBadge status={selectedAccount.status} />}
          </div>
        )}
        {selectedAccount?.status === "reauth_required" && (
          <p style={{ fontSize: "13px", color: "var(--color-warning-text, var(--color-text-secondary))", marginBottom: "var(--space-4)" }}>
            This account's authentication is failing — sends will not go through until you reconnect it using the
            buttons below.
          </p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Button variant="secondary" size="sm" disabled={busy} onClick={handleConnectGoogle}>
            Sign in with Google
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={handleConnectMicrosoft}>
            Sign in with Microsoft
          </Button>
          <Button variant="secondary" size="sm" icon={<PlusIcon size={14} />} disabled={busy} onClick={() => setShowSmtpImapModal(true)}>
            Other (SMTP/IMAP)
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Message" />
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <Field label="To">
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com, another@example.com" />
          </Field>
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
          </Field>
          <Field label="Body">
            <Textarea rows={11} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message..." />
          </Field>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "var(--space-5)" }}>
          <Button variant="secondary" loading={busy && !draft} disabled={!selectedAccountId} onClick={handleSaveDraft}>
            {draft ? "Save draft" : "Create draft"}
          </Button>
          <Button variant="primary" icon={<SendIcon size={15} />} disabled={!draft} onClick={() => setConfirmSendOpen(true)}>
            Send
          </Button>
          {draft && (
            <span style={{ fontSize: "12.5px", color: "var(--color-text-tertiary)" }}>
              Saved (v{draft.autosaveVersion}) · {formatDateTime(draft.lastSavedAt)}
            </span>
          )}
        </div>
      </Card>

      {sendResult && <SendResultCard result={sendResult} />}

      <Modal open={showSmtpImapModal} onClose={() => setShowSmtpImapModal(false)} title="Connect an SMTP/IMAP account" width={460}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <Field label="Email address">
            <Input value={smtpImapEmail} onChange={(e) => setSmtpImapEmail(e.target.value)} />
          </Field>
          <Field label="Display name (optional)">
            <Input value={smtpImapDisplayName} onChange={(e) => setSmtpImapDisplayName(e.target.value)} />
          </Field>
          <Field label="Username (defaults to email)">
            <Input value={smtpImapUsername} onChange={(e) => setSmtpImapUsername(e.target.value)} />
          </Field>
          <Field label="Password">
            <Input type="password" value={smtpImapPassword} onChange={(e) => setSmtpImapPassword(e.target.value)} />
          </Field>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <Field label="SMTP host">
                <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
              </Field>
            </div>
            <div style={{ width: 80 }}>
              <Field label="Port">
                <Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
              </Field>
            </div>
            <div style={{ paddingBottom: "8px" }}>
              <Checkbox checked={smtpSecure} onChange={setSmtpSecure} label="TLS" />
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <Field label="IMAP host">
                <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
              </Field>
            </div>
            <div style={{ width: 80 }}>
              <Field label="Port">
                <Input value={imapPort} onChange={(e) => setImapPort(e.target.value)} />
              </Field>
            </div>
            <div style={{ paddingBottom: "8px" }}>
              <Checkbox checked={imapSecure} onChange={setImapSecure} label="TLS" />
            </div>
          </div>
          <Button variant="primary" loading={busy} onClick={handleConnectSmtpImap} style={{ marginTop: "var(--space-2)" }}>
            Connect
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmSendOpen}
        title="Send this message?"
        description={`This will send the message to ${to || "the recipient(s) you entered"} right now.`}
        confirmLabel="Send"
        busy={busy}
        onConfirm={handleSend}
        onCancel={() => setConfirmSendOpen(false)}
      />
    </div>
  );
}

function SendResultCard({ result }: { result: SendDraftResponse }): JSX.Element {
  return (
    <Card style={{ marginTop: "var(--space-6)" }}>
      <CardHeader
        title="Send result"
        actions={<Badge tone={result.sent ? "success" : "danger"}>{result.sent ? "Sent" : "Blocked"}</Badge>}
      />
      {result.sent && result.providerMessageId && (
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginBottom: "var(--space-4)" }}>
          Provider message id: <code style={{ fontFamily: "var(--font-mono)" }}>{result.providerMessageId}</code>
        </p>
      )}

      <ReportSection title="Gmail Compatibility" score={result.compatibilityReport.score} findings={result.compatibilityReport.findings} />
      {result.deliverabilityReport && (
        <ReportSection title="Deliverability" score={result.deliverabilityReport.score} findings={result.deliverabilityReport.findings} />
      )}
    </Card>
  );
}

function ReportSection({
  title,
  score,
  findings
}: {
  title: string;
  score: number;
  findings: { ruleId: string; severity: string; category?: string; message: string; explanation: string; recommendedFix?: string }[];
}): JSX.Element {
  const tone: BadgeTone = score >= 85 ? "success" : score >= 60 ? "warning" : "danger";
  return (
    <div style={{ marginTop: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "var(--space-2)" }}>
        <h3 style={{ fontSize: "13.5px", fontWeight: 600 }}>{title}</h3>
        <Badge tone={tone}>Score {score}</Badge>
      </div>
      {findings.length === 0 ? (
        <p style={{ fontSize: "13px", color: "var(--color-text-tertiary)" }}>No issues found.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {findings.map((f, i) => (
            <div key={`${f.ruleId}-${i}`} style={{ padding: "var(--space-3)", background: "var(--color-surface-hover)", borderRadius: "var(--radius-md)" }}>
              <div style={{ fontSize: "13px", fontWeight: 600 }}>[{f.severity}] {f.message}</div>
              <div style={{ fontSize: "12.5px", color: "var(--color-text-secondary)", marginTop: "2px" }}>{f.explanation}</div>
              {f.recommendedFix && (
                <div style={{ fontSize: "12.5px", color: "var(--color-text-primary)", marginTop: "2px" }}>
                  <em>Fix: {f.recommendedFix}</em>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
