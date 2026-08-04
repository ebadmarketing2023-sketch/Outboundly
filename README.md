# Outboundly
Modern desktop email outreach platform combining authentic composition with powerful campaign automation, deliverability diagnostics, and multi-account management.

## Status

- **Phase 1 (done):** a single-provider (Google), single-account compose/send loop proving the
  core Draft Lifecycle → Rendering Engine → MIME pipeline → Gmail Compatibility Layer → Gmail
  API send path described in `docs/ARCHITECTURE.md`.
- **Phase 2 (done):** the Conversation Engine (Section 11) — reply detection via the
  Message-ID/References header graph, not a flat thread table — wired to Gmail inbox sync, Sent
  Mail Synchronization (every sent message is now recorded so replies have something to attach
  to), a minimal Unified Inbox UI (thread list, archive, star, manual "Sync now"), a second full
  MailProvider (Microsoft 365/Outlook.com via MSAL + Graph API,
  `src/adapters/providers/microsoft/`), a third: a universal SMTP/IMAP fallback
  (`src/adapters/providers/smtp-imap/`) for any mailbox that isn't Gmail or Microsoft, using
  nodemailer for sending and imapflow/mailparser for reading, and whole-database at-rest
  encryption (Section 23) via `better-sqlite3-multiple-ciphers`, keyed from the OS keychain
  (`src/adapters/persistence/database-key.ts`) — including an in-place migration path for
  installs that already have an unencrypted database on disk from before this shipped.
- **Phase 3 (done):** the safety-rail layer that has to exist before Phase 4 turns on campaign
  volume. A **Deliverability Engine** (`src/core/deliverability/`) runs as a blocking gate on
  every send (content-quality, sender-consistency, and delegated RFC/MIME rules) — this is what
  actually keeps outgoing mail out of spam, and it runs unconditionally, with no UI toggle — and
  an **Account Health Engine** (`src/core/account-health/`) scores each account from real signals
  only — reply rate and send volume from the Conversation Engine's own data, SPF/DKIM/DMARC from
  real DNS lookups (`src/adapters/dns/`), and a live authentication check, never a fabricated
  bounce rate or failure counter — exposed via its own minimal tab (Account Health).

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Getting started

```bash
npm install
npm run build   # compiles TypeScript, copies DB migrations, bundles the renderer
npm test        # unit + integration tests
```

To run the desktop app with a real Google account, see
[`docs/google-oauth-setup.md`](docs/google-oauth-setup.md) for how to create a development OAuth
client, then:

```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." npm run electron:dev
```

To sign in with a Microsoft 365/Outlook.com account instead, see
[`docs/microsoft-oauth-setup.md`](docs/microsoft-oauth-setup.md), then:

```bash
MICROSOFT_CLIENT_ID="..." npm run electron:dev
```

For any other mailbox, use the "Other (SMTP/IMAP)" option in the compose screen — it asks
directly for your SMTP/IMAP host, port, username, and password (an app-specific password, for
providers that require one) rather than an OAuth sign-in, since there's no shared app-wide OAuth
client for arbitrary mail servers.

> **Native module note:** `better-sqlite3-multiple-ciphers` (a drop-in, encryption-capable
> better-sqlite3 fork — see Section 23) is a native addon and must be built against whichever
> runtime is going to load it. `npm run electron:dev` automatically rebuilds it for Electron's
> Node ABI before launching. If you then go back to running `npm test`, rebuild it for plain
> Node.js first with `npm run rebuild:native:node` — otherwise the tests fail with a
> `NODE_MODULE_VERSION` mismatch error. This is a normal Electron + native-dependency wrinkle,
> not a bug in the app itself.

## Project layout

The codebase follows the hexagonal (ports & adapters) structure described in Section 4 of the
architecture doc: `src/core` holds pure, I/O-free domain logic; `src/ports` defines the
interfaces the core depends on; `src/adapters` holds concrete implementations (SQLite, Gmail
API, OS keychain); `src/application` holds use-case orchestration; `electron/` is the thin
Electron main-process/preload wiring; `src/ui` is the React renderer.
