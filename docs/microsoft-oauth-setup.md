# Microsoft OAuth setup for local development (Phase 2)

Like the Google flow (`docs/google-oauth-setup.md`), Outboundly is designed so an end user never
sees a Client ID (Section 13.1 of `docs/ARCHITECTURE.md`) — the application ships with its own
registered Azure AD application. This repository does not commit real credentials, so to test the
Microsoft sign-in flow locally you need to register your own **development** app once.

## 1. Register an app in Azure

1. Go to the [Azure Portal](https://portal.azure.com/) → **Microsoft Entra ID** → **App
   registrations** → **New registration**.
2. Name it anything (e.g. "Outboundly Dev").
3. Under **Supported account types**, choose **Accounts in any organizational directory and
   personal Microsoft accounts** (this matches the `common` authority the app requests by
   default — Outlook.com/Hotmail accounts and work/school accounts both need to be able to sign
   in).
4. Under **Redirect URI**, choose platform **Mobile and desktop applications** and add:
   ```
   http://127.0.0.1/callback
   ```
   This is the loopback-redirect pattern Outboundly's PKCE flow uses
   (`src/adapters/providers/microsoft/oauth-flow.ts`, mirroring the Google flow's shape). Azure
   deliberately ignores the port number on a loopback redirect URI, matching any
   `http://127.0.0.1:<random-port>/callback` the app's short-lived local HTTP listener happens to
   bind to — you do not need to register a specific port.
5. Click **Register**, then copy the **Application (client) ID** from the app's Overview page.

No client secret is needed — this is registered as a public client (native/desktop), the same
category Google's "Desktop app" client type maps to, and MSAL's PKCE flow doesn't depend on one
being kept confidential.

## 2. Add API permissions

1. Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:
   - `Mail.Send`
   - `Mail.ReadWrite`
2. `openid`, `profile`, `email`, and `offline_access` don't need to be added explicitly — MSAL
   Node includes them on every request automatically (verified against
   `@azure/msal-common`'s scope-building code, which always appends its `OIDC_DEFAULT_SCOPES`).
3. For a personal Microsoft account signing in as its own admin, delegated permissions here don't
   require a separate admin-consent step — the consent screen you see during sign-in covers it.

## 3. Run Outboundly with your credentials

```bash
npm install
npm run build
MICROSOFT_CLIENT_ID="your-application-client-id" \
npm run electron:dev
```

Click **Sign in with Microsoft** in the compose screen. This opens your system browser to
Microsoft's consent screen (PKCE, loopback redirect on an ephemeral local port — same shape as
Section 13.2's Google flow); after you approve, the browser tab shows a plain confirmation page
and the app receives MSAL's serialized token cache.

## Known limitation in headless/CI environments

Same as the Google flow: token storage goes through the OS-native credential store via
`@napi-rs/keyring`, which requires a real desktop session with a working keychain/Secret Service
daemon. See `docs/google-oauth-setup.md`'s "Known limitation" section — it applies identically
here, since both providers share the same `TokenVault` port.
