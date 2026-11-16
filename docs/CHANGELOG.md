# Changelog

> **Role:** what changed in each version and what it means when upgrading · **Audience:** anyone running or upgrading EANyra

Versions follow what a user of EANyra can observe: **patch** = no visible
change (fixes, docs, internals); **minor** = new capability, existing setups
keep working; **major** = an existing setup, configuration or integration may
need action. History before 2.0.0 lives only in commit messages (`v1.x.y …`).

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
