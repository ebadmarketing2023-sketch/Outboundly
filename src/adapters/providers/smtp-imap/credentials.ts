/**
 * Unlike Google/Microsoft (one shared app-wide OAuth client, per-account tokens only), a generic
 * SMTP/IMAP account has no shared app-level config at all — host/port/username/password *is* the
 * account's secret material. So the whole thing is JSON-encoded and handed to the generic
 * TokenVault under the account's id, mirroring how GmailProvider serializes its own StoredTokens
 * shape against the same opaque-string port (Section 13.3).
 */
export interface SmtpImapCredentials {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  username: string;
  password: string;
}

export function serializeSmtpImapCredentials(credentials: SmtpImapCredentials): string {
  return JSON.stringify(credentials);
}

export function deserializeSmtpImapCredentials(payload: string): SmtpImapCredentials {
  return JSON.parse(payload) as SmtpImapCredentials;
}
