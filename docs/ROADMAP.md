# Roadmap

This roadmap separates confirmed defects from improvements. Items are based on
the current repository state, not on the older README.

## Priority 0: Completed

- [x] Restored broken MCP entry points, centralized runtime configuration, and
  repaired all stale npm scripts.

## Priority 1: Data Correctness

- [ ] **Persist the first observed GitHub README SHA.** README change detection
  only reads prior `readme_change` signals. The first SHA is never stored, so
  later changes cannot reliably be detected.
- [x] **Clarify and fix GitHub commit ownership.** Commit collection now filters
  the GitHub commits endpoint by the configured account author.
- [x] **Fix Twitter reply detection.** Network-response extraction now uses
  Twitter's reply metadata, with DOM parsing retained as a fallback.
- [ ] **Complete Twitter reply discovery.** Reply classification works, but the
  profile timeline omits known thread parts. Authenticated verification showed
  that conversation discovery recovers all 25 known posts, including 20
  replies, while live `from:<username>` search returned no authored posts.
  Exhaustive historical reply discovery remains unproven.
- [ ] **Preserve LinkedIn media URLs.** `MediaUrl` is parsed from `Shares.csv`
  but is discarded when building the normalized post.
- [x] **Support multiple accounts with the same username on different
  platforms.** Composite `(platform, username)` identity, migration preserving
  child records, and platform-aware account sync are implemented.
- [ ] **Define multi-account LinkedIn import behavior.** Every LinkedIn account
  currently reads the same `Shares.csv`; global post deduplication means the
  first account can claim all imported rows.
- [x] **Resolve `used_for_content` semantics.** CLI export now records
  `exported_at`; `used_for_content` is reserved for confirmed publication.
- [ ] **Correct scraper run metrics.** `scraper_runs.posts_saved` also counts
  saved signals. Rename it or store post and signal counts separately.
- [x] **Make account/project sync reconcile deletions.** Removed accounts and
  deleted project YAML files are archived without deleting historical data.
  Explicit `archive: true` is supported in account JSON and project YAML.
- [x] **Exclude example project YAML from context sync.** Project discovery
  ignores templates beginning with `_` and any `.example.yaml` files. Reusable
  templates and the original examples are committed under `instance_example/`;
  real project YAML under `instance/` is gitignored.
- [ ] **Preserve all authored context in Markdown exports.** The exporter omits
  `voice.example_post` and checks platform `frequency` while the documented
  field and examples use `posting_frequency`.
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
- [ ] **Handle orphaned `running` scraper runs.** A hard process termination can
  leave runs permanently marked as running.
- [ ] **Improve freshness reporting.** `scraper_status` calculates age from the
  latest finished run, even when it failed; report last successful collection
  and per-platform freshness.
- [ ] **Review browser anti-detection patches.** Browser API monkey-patching can
  break page behavior and may not reduce detection risk. Keep only measured,
  tested changes.
- [ ] **Add explicit shutdown/cleanup to MCP transports and SQLite connections.**
- [ ] **Review HTTP MCP deployment security.** Before binding beyond localhost,
  add authentication, origin policy, request limits, and session lifecycle
  tests.

## Priority 3: Maintainability

- [ ] **Remove or migrate legacy Twitter MCP tools.**
  `src/core/mcp/tools/twitter.js` is unregistered and queries obsolete columns
  such as `tweet_id`, `retweets`, and `is_retweet`.
- [ ] **Generate supported-platform metadata from one registry.** Platform IDs
  and enums are duplicated across CLI validation, the orchestrator, MCP
  schemas, and documentation.
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
- [ ] **Telegram backfill checkpoints.** Persist pagination progress so reaching
  the page cap cannot skip an older unread interval.
- [ ] **Separate brand identities.** Per-brand author context and independent
  login sessions, beyond the current list of monitored accounts.

- [ ] **Posting-gap analysis and proactive reminders.** Compare recent
  publishing activity with per-platform `posting_frequency` and expose the
  result to agents; add notification delivery only after the analysis contract
  is stable.
- [x] **Twitter network-response extraction with DOM fallback.** Intercept
  already-loaded GraphQL responses to obtain exact metrics, complete text, and
  richer metadata while preserving browser navigation and human-paced
  scrolling.
- [ ] **Manual signal ingestion.** Add CLI/MCP workflows for notes, articles,
  ideas, and other non-GitHub signal sources already supported by the generic
  `signals` schema.
- [ ] **Signal-to-post attribution.** Track which published posts came from
  which signals instead of relying on one timestamp flag.
- [ ] **Incremental LinkedIn import management.** Track import files, account
  ownership, and import history explicitly.
- [ ] **Optional community feedback sources.** Evaluate Discord and similar
  sources as signals after manual signal ingestion and attribution are stable.
- [ ] **Per-platform health and run metrics.**
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
