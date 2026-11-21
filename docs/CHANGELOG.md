# Changelog

> **Role:** what changed in each version and what it means when upgrading · **Audience:** anyone running or upgrading EANyra

Versions follow what a user of EANyra can observe: **patch** = no visible
change (fixes, docs, internals); **minor** = new capability, existing setups
keep working; **major** = an existing setup, configuration or integration may
need action. History before 2.0.0 lives only in commit messages (`v1.x.y …`).

## 4.1.2 — 2026-11-21

### Changed

- Agent skill (`skills/eanyra/SKILL.md`, skill version 2.1.0): the quality
  checklist now also checks `platforms.<platform>.avoid` and every project
  `posting_rules` item (privacy, names that must not appear, required
  endings), and `style` per platform. A draft that breaks a posting rule is
  not delivered.

No action needed when upgrading from 4.1.x; re-copy the skill if you installed
it elsewhere.

## 4.1.1 — 2026-11-20

### Fixed

- LinkedIn import: the `Shares.csv` export wraps every line of a multi-line
  post in its own quotes, so imported texts read `line"\n"line`. The parser
  now strips that wrapper; single-line posts and ordinary quotes are left
  as they are.

Posts imported earlier keep the old text until a new export is imported
(an unchanged file is skipped).

## 4.1.0 — 2026-11-17

### Added

- Container: `Dockerfile` (Playwright image, non-root, instance on a volume),
  `compose.yaml` publishing the UI on `127.0.0.1:4450` only, `.dockerignore`
  keeping personal data out of the image. Inside a container
  (`EANYRA_CONTAINER=1`) the web server may bind `0.0.0.0`; the Host check
  still accepts loopback names only. Not yet built on a machine with Docker.
- [docs/DEPLOYMENT.md](DEPLOYMENT.md): one PC, other devices on the LAN through
  an SSH tunnel, container, and why a VPS is not supported as an exposed
  service.

No action needed when upgrading from 4.0.x.

## 4.0.2 — 2026-11-17

### Changed

- Accounts and secrets guide: when an X login has to be renewed (cookies are
  refreshed on every run, the `auth_token` lifetime is fixed), the PowerShell
  form of `vault migrate --purge`, and EFS versus BitLocker.

## 4.0.1 — 2026-11-17

### Changed

- README: Windows PowerShell drops the `--` separator for `npm` (`npm.ps1`);
  use `npm.cmd` or `node src/core/cli/index.js` for commands with flags.
- Web hints use `npm.cmd` where flags follow `--`; the EFS card explains that
  it is optional (the vault is already encrypted) and why to save the
  certificate.
- MCP guide: connecting Claude Code (stdio without a token, or HTTP).

## 4.0.0 — 2026-11-17

Every persona is self-contained; accounts are assigned to personas from the
account editor.

### Upgrade notes (action needed)

- **The shared `voice.yaml`, `bio.yaml` and `platforms.yaml` are no longer
  used.** A persona's voice, bio and platform rules come only from its own
  file. Open «Контекст» and press «Перенести в персони»: every persona gets
  what it did not set itself (only for the platforms of its accounts), the
  comments in the persona files stay, and the old files move to
  `context/.trash/`. Until then `context sync` warns.
- Accounts without a persona have no voice or posting target: `context_get`
  tells the AI to ask, and the content plan shows them without a target.
- `context_get` without arguments returns the personas and projects (no
  voice); the keys `voice`, `bio`, `platforms` are gone.
- `npm run export` takes `--persona <slug>` (the only persona is used when
  there is one).

### Added

- «Акаунти» → «Редагувати» → «Персона»: put an account into a persona or take
  it out; the persona files are edited with their comments kept.
- A persona may start without accounts (warning instead of an error).

### Changed

- Wider pages and a taller YAML editor that wraps long lines.
- New personas start from the shipped template with all sections.
- Fixed a stray «null» text on «Огляд».

## 3.0.0 — 2026-11-17

Set up everything from the browser: `npm install`, then `npm run serve`.

### Upgrade notes (action needed)

- **The web UI moved from port 3030 to 4450**: open `http://localhost:4450`.
  An AI client configured for `http://127.0.0.1:3030/mcp` (`serve --mcp`)
  must be changed to `http://localhost:4450/mcp`. To keep the old port set
  `WEB_PORT=3030` in the root `.env`.
- `.env.example` moved from `instance_example/` to the project root.

### Added

- First run in the browser: without a vault, log in with the one-time token
  from the terminal and create the encrypted vault on «Огляд» (master
  password, optional «remember on this PC»). Plaintext secrets from the root
  `.env` are imported as with `vault init`; the login switches to the master
  password without a restart.
- `npm run serve` creates a missing instance (empty `accounts.json`, context
  templates); no `instance:init` and no `.env` needed.
- `npm install` downloads Playwright's Chromium (`postinstall`).
- The startup message shows `http://localhost:4450` (both `localhost` and
  `127.0.0.1` work, as before).

### Changed

- Hints in the web UI point to the web tabs instead of terminal commands and
  file paths.

## 2.2.0 — 2026-11-17

### Added

- Web tab «Налаштування»: problem alerts (Telegram chat lookup for your bot,
  Discord webhook saved to the vault, rules, test message), LinkedIn
  `Shares.csv` upload with an immediate import and the import history,
  backups (create, list), Windows EFS status, vault remember/forget on this
  PC, master password change, MCP token create/rotate (shown once).

### Changed

- Web request bodies may be up to 5 MiB (was 1 MiB) so a LinkedIn export
  fits.

No action needed when upgrading from 2.1.0.

## 2.1.0 — 2026-11-17

### Added

- Web tab «Контекст»: edit `voice.yaml`, `bio.yaml`, `platforms.yaml`,
  projects and personas in the browser. Live validation with the same rules
  as `context sync` (errors block saving, warnings hint), comments kept,
  save syncs the context for the AI at once. New projects and personas start
  from the templates; deleting moves the file to `context/.trash/`.

No action needed when upgrading from 2.0.0.

## 2.0.0 — 2026-11-17

Multi-account work with your own logins, encrypted credentials, a local web
UI and an AI content loop.

### Upgrade notes (action needed)

- **Credentials move to an encrypted vault.** Run `npm run nyra -- vault init`
  once: it imports `TELEGRAM_SESSION`, `TELEGRAM_API_ID/HASH`,
  `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN` and the X login. After checking that
  collection works, remove the plaintext copies with
  `npm run nyra -- vault migrate --purge`. Without a vault only the `default`
  session from `.env` works (legacy mode).
- **X collection no longer uses the persistent browser profile**
  (`instance/data/nyra`); logins are stored per session in the vault. The
  profile is read once by `vault init` / `vault migrate`.
- **Background processes need the vault key**: run
  `npm run nyra -- vault remember` once so MCP and the scheduler can unlock it
  (Windows DPAPI), or unlock interactively.
- **Database migrations** (applied automatically on start): run health and
  jobs, drafts, feedback and checkpoints, LinkedIn import history. Back up
  first if you want a restore point (`npm run backup`).
- **LinkedIn post times** were read as local time; the next import corrects
  them to UTC.
- **Node.js** 20.19+, 22.13+ or 24+ is required (`engines`).
- `TWITTER_HOME_URL` was removed (unused).

### Added

- Per-account login sessions (`"session"` in `accounts.json`) for X, Telegram,
  GitHub and Discord; Telegram channels choose their publishing bot.
- Master-password vault (scrypt + AES-256-GCM), `vault` / `secrets` /
  `sessions` / `mcp token` CLI.
- Local web UI (`npm run serve`): overview, content plan and drafts, accounts
  and every login (cookies, X login window, Telegram QR + 2FA, tokens),
  posts, signals and ideas, Telegram drafts, jobs; optional scheduler and MCP
  at `/mcp` with a Bearer token.
- AI content loop: `content_plan_get`, drafts (`draft_*`), `signal_add`,
  `content_performance_get`, MCP prompts (`write_post`, `content_week`,
  `repurpose_signal`, `performance_review`).
- Problem alerts via Telegram bot or Discord webhook (`notify …`).
- Discord community questions and feedback as signals.
- LinkedIn import history, `linkedin import` / `history`.
- Telegram backfill checkpoints (no skipped history), durable jobs,
  per-account health, `scraper_job_stop`.
- `npm run backup` / `instance:restore`, Windows EFS encryption at rest
  (`instance:protect`), `LOG_LEVEL`, `--quiet` / `--debug`, ESLint.

### Fixed

- Malformed records no longer fail an account's whole batch; context YAML is
  validated with field-level errors.
- First GitHub README change is detected (baseline persisted).
- Markdown export keeps `example_post`, `posting_frequency`, `avoid`.
- Graceful Ctrl+C: X sessions are saved, runs finalized, locks released.
- 23 of 24 runtime dependency advisories (one accepted, see ROADMAP).
