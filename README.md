# Outboundly
Modern desktop email outreach platform combining authentic composition with powerful campaign automation, deliverability diagnostics, and multi-account management.

## Status

- **Phase 1 (done):** a single-provider (Google), single-account compose/send loop proving the
  core Draft Lifecycle → Rendering Engine → MIME pipeline → Gmail Compatibility Layer → Gmail
  API send path described in `docs/ARCHITECTURE.md`.
- **Phase 2 (in progress, this slice done):** the Conversation Engine (Section 11) — reply
  detection via the Message-ID/References header graph, not a flat thread table — wired to Gmail
  inbox sync, Sent Mail Synchronization (every sent message is now recorded so replies have
  something to attach to), and a minimal Unified Inbox UI (thread list, archive, star, manual
  "Sync now"). Microsoft/SMTP-IMAP adapters and database-at-rest encryption are still open for
  this phase.

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

> **Native module note:** `better-sqlite3` is a native addon and must be built against whichever
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
