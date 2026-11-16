# Roadmap

This roadmap separates confirmed defects from improvements. Items are based on
the current repository state, not on the older README.

## Priority 0: Completed

- [x] Restored broken MCP entry points, centralized runtime configuration, and
  repaired all stale npm scripts.

## Priority 1: Data Correctness

- [x] **Persist the first observed GitHub README SHA.** Baselines live in
  `source_state`; quiet repositories get a one-time baseline read.
- [x] **Clarify and fix GitHub commit ownership.** Commit collection now filters
  the GitHub commits endpoint by the configured account author.
- [x] **Fix Twitter reply detection.** Network-response extraction now uses
  Twitter's reply metadata, with DOM parsing retained as a fallback.
- [ ] **Complete Twitter reply discovery.** Reply classification works, but the
  profile timeline omits known thread parts. Authenticated verification showed
  that conversation discovery recovers all 25 known posts, including 20
  replies, while live `from:<username>` search returned no authored posts.
  Exhaustive historical reply discovery remains unproven.
- [x] **Preserve LinkedIn media URLs.** `MediaUrl` is stored in `media_urls`.
- [x] **Support multiple accounts with the same username on different
  platforms.** Composite `(platform, username)` identity, migration preserving
  child records, and platform-aware account sync are implemented.
- [x] **Define multi-account LinkedIn import behavior.** Each LinkedIn account
  can name its own export file with `import_file`; accounts without it still
  share `Shares.csv`.
- [x] **Resolve `used_for_content` semantics.** CLI export now records
  `exported_at`; `used_for_content` is reserved for confirmed publication.
- [x] **Correct scraper run metrics.** `posts_saved` and `signals_saved` are
  stored separately, plus per-account outcomes in `scraper_run_accounts`.
- [x] **Make account/project sync reconcile deletions.** Removed accounts and
  deleted project YAML files are archived without deleting historical data.
  Explicit `archive: true` is supported in account JSON and project YAML.
- [x] **Exclude example project YAML from context sync.** Project discovery
  ignores templates beginning with `_` and any `.example.yaml` files. Reusable
  templates and the original examples are committed under `instance_example/`;
  real project YAML under `instance/` is gitignored.
- [x] **Preserve all authored context in Markdown exports.** `example_post`,
  `posting_frequency` (legacy `frequency`) and platform `avoid` are exported.
- [x] **Update full duplicate records where appropriate.** `PostRepository`
  refreshes mutable content, links, media, flags, engagement, and scrape time.

## Priority 2: Reliability and Security

- [x] **Replace startup schema alteration with versioned migrations.**
  Startup schema creation and upgrades now run exclusively through idempotent
  versioned migrations.
- [ ] **Add automated tests.** Minimum coverage should include CSV parsing,
  model/repository deduplication, context sync, export selection, MCP tools,
  GitHub mapping, and Twitter DOM parsing fixtures.
- [ ] **Add linting and formatting checks.** There is currently no repeatable
  code-quality command in `package.json`.
- [x] **Validate account configuration.** Reject missing usernames, unsupported
  platforms, duplicate account keys, and malformed JSON with actionable
  messages.
- [ ] **Validate author context YAML.** Add schemas and actionable errors for
  top-level files and projects, including types, project slug/filename
  agreement, status values, and malformed URLs.
- [ ] **Validate normalized records before persistence.** For example,
  LinkedIn rows without a stable `platform_id` should be skipped explicitly
  rather than reaching a database constraint error.
- [x] **Improve scheduler concurrency behavior.** A database-scoped file lock
  prevents overlapping scheduler, CLI, and MCP collection. Crash recovery of
  stale lock files remains manual.
- [x] **Handle orphaned `running` scraper runs.** The next run (holding the
  scrape lock) marks them failed; jobs with a dead worker PID are recovered.
- [x] **Improve freshness reporting.** `scraper_status` reports age since the
  last successful collection, per-platform freshness and accounts needing
  attention with their last error.
- [ ] **Review browser anti-detection patches.** Browser API monkey-patching can
  break page behavior and may not reduce detection risk. Keep only measured,
  tested changes.
- [ ] **Add explicit shutdown/cleanup to MCP transports and SQLite connections.**
- [ ] **Review HTTP MCP deployment security.** Before binding beyond localhost,
  add authentication, origin policy, request limits, and session lifecycle
  tests.

## Priority 3: Maintainability

- [x] **Remove or migrate legacy Twitter MCP tools.**
  The unregistered `src/core/mcp/tools/twitter.js` was removed; the unified
  `posts_*` and `accounts_list` tools cover Twitter.
- [x] **Generate supported-platform metadata from one registry.**
  `platforms/catalog.js` plus one collector per platform; the orchestrator no
  longer switches on platform.
- [x] **Reduce duplicate browser stealth logic.** Interactive login now uses a
  normal headful browser without scraper-specific API patches.
- [ ] **Remove unused configuration and helpers or connect them to behavior.**
  Examples include `TWITTER.homeUrl`, parts of cookie configuration, and
  generic image/file helpers that are not used by the pipeline.
- [ ] **Normalize user-facing naming.** The package and CLI use `eanyra`, some
  examples use `nyra`, and messages still describe the product as an
  X-only monitoring tool.
- [ ] **Add a documented Node.js engine requirement** to `package.json`.
- [ ] **Add structured logging levels and optional quiet/debug modes.**
- [ ] **Document database backup and recovery procedures.**

## Planned Features

- [x] **Telegram text publishing.** Explicitly enabled channels, Bot API identity
  lookup and admin checks, durable prepare/publish/get workflow and duplicate
  suppression. Twitter remains collection-only.

- [x] **Agent-triggered collection.** MCP background jobs with platform/account
  selection and a Telegram message reader. See [MCP_GUIDE.md](MCP_GUIDE.md).
- [x] **Telegram backfill checkpoints.** Reaching the page cap stores the
  unread interval in `source_state` and later runs read it; nothing is skipped.
- [x] **Separate brand identities.** Personas carry per-brand context; each
  account names its own X/Telegram/GitHub login (`session`) and Telegram
  channels their bot (`bot`). Sessions are isolated during collection.
- [x] **Encrypted credentials.** Master-password vault (scrypt + AES-256-GCM)
  for all logins and tokens, Windows DPAPI "remember on this PC", migration and
  purge of plaintext `.env`/cookie/profile copies.
- [x] **Local web server.** `eanyra serve` on 127.0.0.1: account/session health,
  collection jobs, posts and signals, context sync, and approval of
  AI-prepared Telegram drafts.
- [x] **Embed the MCP HTTP transport in `eanyra serve`** (`--mcp`, Bearer
  token in the vault, browsers refused).
- [x] **Unified drafts for all platforms.** AI prepares posts per persona and
  platform; X/LinkedIn stay manual-publish (compose link + mark published),
  Telegram publishes after approval.
- [x] **Durable job queue.** Collection jobs live in the `jobs` table and
  survive MCP restarts; `scraper_jobs_list` shows them.
- [ ] **Move remaining MCP queries into services** (posts, signals, context) as
  the web server needs them.
- [ ] **Encrypt the database and context at rest** (SQLCipher or equivalent).

- [x] **Posting-gap analysis.** `content_plan_get` and the web content plan.
- [ ] **Proactive reminders.** Notify (e.g. Telegram bot message to the author)
  when an account becomes overdue.
- [x] **Twitter network-response extraction with DOM fallback.** Intercept
  already-loaded GraphQL responses to obtain exact metrics, complete text, and
  richer metadata while preserving browser navigation and human-paced
  scrolling.
- [x] **Manual signal ingestion.** `signal_add` (MCP) and the web idea form.
- [x] **Signal-to-post attribution.** Drafts keep their source `signal_ids`;
  publication marks them used.
- [x] **Link published drafts to collected posts** and report engagement per
  draft, signal type and author (`content_performance_get`, web «Що працює»).
- [ ] **Incremental LinkedIn import management.** Track import files, account
  ownership, and import history explicitly.
- [ ] **Optional community feedback sources.** Evaluate Discord and similar
  sources as signals after manual signal ingestion and attribution are stable.
- [x] **Per-platform health and run metrics.**
- [ ] **Container and remote MCP deployment documentation** after transport
  security and lifecycle are tested.

## Completed Foundations

- [x] Telegram QR login with automatic refresh, hidden 2FA prompt, cancellation
  cleanup and direct root `.env` session persistence; phone login remains optional.

- [x] Instance-specific settings, context and runtime data isolated under
  `instance/`, with safe initialization, legacy migration and external selection.

- [x] Commander-based CLI and UTC cron scheduler.
- [x] Unified `posts` table for published social content.
- [x] Unified `signals` table for GitHub activity and future sources.
- [x] Twitter/X Playwright collection with persistent sessions.
- [x] GitHub REST collection for releases, commits, repositories, and README
  metadata.
- [x] LinkedIn CSV post import.
- [x] Telegram MTProto polling for channel posts.
- [x] YAML author context and project synchronization.
- [x] Markdown export for AI-assisted content sessions.
- [x] Intended unified MCP tool design with stdio and HTTP transport code.
- [x] Centralized runtime configuration and complete `instance_example/.env.example`.
- [x] Working MCP startup imports and cross-platform configured export paths.
- [x] Repaired npm scripts: working export, context sync, platform scrape, and
  cookie import commands; removed the nonexistent migration entry point.
