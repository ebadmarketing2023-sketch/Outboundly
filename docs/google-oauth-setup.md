# Google OAuth setup for local development (Phase 1)

Outboundly is designed so an end user never sees a Client ID or Client Secret (Section 13.1 of
`docs/ARCHITECTURE.md`) — the application is meant to ship with its own registered OAuth client.
This repository does not (and should not) commit real OAuth credentials, so to run or test the
Google sign-in flow locally you need to create your own **development** OAuth client once.

This is a one-time setup step, separate from the multi-week Google app **verification** process
described in Section 13.5 of the architecture doc — verification is only required before
distributing the app publicly with sensitive/restricted scopes. For local development, a project
in "Testing" publishing status with yourself added as a test user is enough.

## 1. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project
   (or reuse an existing one you control).
2. Under **APIs & Services → Library**, enable the **Gmail API**.

## 2. Configure the OAuth consent screen

1. Under **APIs & Services → OAuth consent screen**, choose **External** (unless you have a
   Google Workspace org and want **Internal**).
2. Fill in the required app name/support email fields. You can leave the app in **Testing**
   status — this skips Google's verification review entirely for development.
3. Under **Test users**, add the Gmail address(es) you'll sign in with while developing. Only
   accounts on this list can complete the OAuth flow while the app is unverified.
4. Add the scopes this app requests:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile` (needed so Google returns the account's
     profile name for the `From` header's display name — without it, sent mail shows only a
     bare address instead of "Your Name <you@gmail.com>")

   If you already created your OAuth consent screen before this scope was added, go back and add
   it now, then reconnect the account in the app (Sign in with Google again) to pick up the name.

## 3. Create an OAuth Client ID

1. Under **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**. (This is what makes the PKCE + loopback-redirect flow in
   `src/adapters/providers/google/oauth-flow.ts` work without a real client secret — see
   Section 13.4 of the architecture doc for why a desktop app's "secret" isn't treated as
   confidential.)
3. Copy the generated **Client ID** (and Client Secret, though Google's installed-app flow does
   not depend on it being kept secret).

## 4. Run Outboundly with your credentials

```bash
npm install
npm run build
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
GOOGLE_CLIENT_SECRET="your-client-secret" \
npm run electron:dev
```

Click **Sign in with Google** in the compose screen. This opens your system browser to Google's
consent screen (PKCE, loopback redirect on an ephemeral local port — Section 13.2); after you
approve, the browser tab shows a plain confirmation page and the app receives the tokens.

## Known limitation in headless/CI environments

Token storage uses the OS-native credential store (macOS Keychain / Windows Credential Manager /
Linux Secret Service) via `@napi-rs/keyring` (`src/adapters/credential-vault/native-keychain-token-vault.ts`),
per Section 23's requirement that OAuth tokens never touch the SQL database. **This requires a
real desktop session with a working keychain/Secret Service daemon.** In a headless container
(no D-Bus session bus, no logged-in desktop session — which is exactly this development
sandbox), storing or retrieving tokens will fail with an `AccessDenied`-style error.

This is intentional: the production code path does not silently fall back to a less secure
storage mechanism just because the keychain is unavailable (Section 23 is treated as a hard
requirement, not a best-effort). `src/adapters/credential-vault/in-memory-token-vault.ts` exists
only for automated tests and is never wired into the Electron app itself.

To fully exercise the live Google sign-in flow end-to-end, run `npm run electron:dev` on an
actual desktop (macOS, Windows, or Linux with a logged-in session and Secret Service running) —
not inside a headless container.
