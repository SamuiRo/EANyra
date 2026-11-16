# EANyra

EANyra is a local, multi-platform content intelligence pipeline for AI-assisted
content creation.

It collects:

- published posts from Twitter/X through Playwright;
- published LinkedIn posts from a LinkedIn CSV export;
- published Telegram channel posts through MTProto polling;
- GitHub activity through the GitHub REST API.

EANyra normalizes that data into SQLite, combines it with author context stored
as YAML, and exposes it through a CLI, Markdown exports, and an MCP server.

> Project status: active development. See [docs/ROADMAP.md](docs/ROADMAP.md)
> for known limitations and planned improvements.

## Data Flow

```text
Twitter/X profile -- Playwright scraper --+
LinkedIn export --- CSV importer ---------+--> posts ----+
Telegram channel -- MTProto polling ------+
GitHub API -------- REST collector ----------> signals --+--> SQLite
YAML context ------ context sync ------------------------+
                                                            |
                              +-----------------------------+------------------+
                              |                             |                  |
                           CLI queries                Markdown export      MCP tools
```

The central distinction is:

- **posts** are already-published content;
- **signals** are raw material that may become future content.

GitHub releases, commit batches, new repositories, and README changes are
signals. Twitter, LinkedIn, and Telegram publications are posts.

## Requirements

- Node.js 20.19+, 22.13+ or 24+ (see `engines` in `package.json`); Node.js 22 is recommended
- npm
- a GitHub Personal Access Token for GitHub collection
- a persistent Twitter/X login session for Twitter collection
- LinkedIn `Shares.csv` for LinkedIn import
- Telegram API credentials and a saved MTProto session for Telegram polling

## Quick Start

```bash
npm install
npm run instance:init
```

Edit `instance/accounts.json`, create the encrypted credentials vault, then
initialize the data sources you need:

```bash
# Encrypted storage for every login and token (master password)
npm run nyra -- vault init

# Twitter/X: one session per own account (recommended: cookie import)
npm run import-cookies -- --session brand-a --delete-source
npm run login -- --session brand-b      # best-effort; X may reject it

# GitHub / Telegram tokens and API keys (hidden prompts, stored encrypted)
npm run nyra -- secrets set github
npm run nyra -- secrets set telegram-api
npm run nyra -- secrets set telegram-bot

# LinkedIn only: place Shares.csv in instance/data/imports/

# Telegram user session (QR login)
npm run login:telegram

# Check that every account's login is configured
npm run nyra -- sessions

# Collect all configured platforms once
npm run scrape

# Sync author context from instance/context/*.yaml into SQLite
npm run context:sync

# Generate a Markdown context export without marking records as used
npm run export:dry

# Start the scheduled daemon
npm start

# Or: local web UI on http://127.0.0.1:3030 (add -- --schedule for cron runs)
npm run serve
```

The same commands work in Windows PowerShell. When upgrading an existing
checkout with settings under `src/` and root `.env`/`data/`, stop the daemon
and run migration **before** initializing a new instance:

```powershell
npm run instance:migrate
```

## Account Configuration

Credentials (X sessions, Telegram sessions and API keys, bot and GitHub tokens)
live in the encrypted vault `instance/secrets.vault`; the root `.env` holds
runtime settings. See [Accounts, sessions and encryption](docs/ACCOUNTS_AND_SECRETS.md)
for running several own accounts, the master password and migration from a
plaintext `.env`. Editable accounts,
context and data live in `instance/`: `accounts.json`, `context/`, and `data/`.
Source code contains no instance-specific files.
See [Instance layout and migration](docs/INSTANCE_GUIDE.md) for the complete
structure, path rules, and selecting another instance with `INSTANCE_DIR`.

`instance/accounts.json` is the input list for monitored accounts. It is
gitignored because it commonly contains personal account choices.

```json
[
  {
    "username": "example-twitter-user",
    "display_name": "Example",
    "platform": "twitter",
    "active": true
  },
  {
    "username": "example-github-user",
    "display_name": "Example",
    "platform": "github",
    "active": true
  },
  {
    "username": "example-linkedin-user",
    "display_name": "Example",
    "platform": "linkedin",
    "active": true
  },
  {
    "username": "example-telegram-channel",
    "display_name": "Example Telegram Channel",
    "platform": "telegram",
    "active": true
  }
]
```

Supported platform IDs are `twitter`, `github`, `linkedin`, and `telegram`. When
`platform` is omitted, it defaults to `twitter`.

Per-account login fields:

| Field | Platforms | Meaning |
|---|---|---|
| `session` | twitter, telegram, github | Which stored login collects this account (default `default`) |
| `bot` | telegram | Which stored bot publishes to this channel (default `default`) |
| `publish_transport` | telegram | `bot` or `mtproto` for this channel |
| `import_file` | linkedin | This account's export file in the imports folder (default `Shares.csv`) |

On each scrape, configured accounts are upserted into SQLite. Set
`"archive": true` to explicitly archive an account. Accounts removed from the
JSON file are also archived during the next sync. Archived accounts remain in
SQLite with their historical posts and signals, but are inactive.

## Platform Setup

### Twitter/X

Twitter collection runs one Playwright Chromium with an isolated context per
login session. Each session's cookies and local storage are loaded from the
encrypted vault and written back, refreshed, after the run; nothing is kept in
a plaintext browser profile.

```bash
npm run import-cookies -- --session brand-a --delete-source
npm run scrape:twitter
```

Export the `x.com` cookies of one account from your normal browser to
`instance/data/imports/cookies.json` (or pass another file:
`npm run import-cookies -- <file> --session <name>`). The file must contain
`auth_token`. `--delete-source` removes the plaintext export afterwards.

**Several own X accounts.** Give each account its own login:

```json
{ "username": "brand_a", "platform": "twitter", "session": "brand-a" },
{ "username": "brand_b", "platform": "twitter", "session": "brand-b" }
```

and import or log in once per session. A run collects other platforms first,
then X profiles grouped by session, least recently collected first. The long
`MIN/MAX_DELAY_BETWEEN_ACCOUNTS_MS` pause applies only between profiles that
share one login; switching logins waits `MIN/MAX_DELAY_BETWEEN_SESSIONS_MS`
(default 30-120 s). If X rejects one login, only that session's profiles are
skipped. Collect a subset with
`npm run nyra -- scrape twitter --account brand_a brand_b` or the MCP
`scraper_run` `accounts` argument. `npm run nyra -- sessions` shows each
session's state and how many days its `auth_token` stays valid.

`npm run login -- --session <name>` remains available as a best-effort helper. It opens an
installed Chrome browser without scraper-specific patches, but X may reject
login from any Playwright-controlled browser.

The first run for an account targets `INITIAL_POSTS_PER_ACCOUNT`; later runs
target `POSTS_PER_ACCOUNT`. Extraction prefers intercepted profile timeline
GraphQL responses for exact metrics and complete text, with DOM parsing
retained as a fallback. The scraper clicks the combined Posts + Replies tab,
uses live `from:<username>` search when needed, and inspects known conversation
roots to recover thread parts omitted from profile timelines. X may still omit
records from every web dataset. The target is a combined chronological limit,
not a required minimum. Returning fewer records is normal when X exposes fewer
entries.

### GitHub

Store a token in the vault (one per session if accounts need different tokens):

```bash
npm run nyra -- secrets set github            # session "default"
npm run nyra -- secrets set github work       # referenced by "session": "work"
```

Then configure a GitHub account and run:

```bash
npm run nyra -- scrape github
```

GitHub collection creates signals for recent releases, weekly commit batches,
new repositories, and README changes. See the known README tracking limitation
in [docs/ROADMAP.md](docs/ROADMAP.md).

### LinkedIn

Request a LinkedIn data export and place these files in `instance/data/imports/`:

```text
Shares.csv     required for posts
Profile.csv    optional; parsed for logging only
```

Then run:

```bash
npm run nyra -- scrape linkedin
```

For several LinkedIn accounts, give each its own export file name with
`"import_file": "Shares-brand-a.csv"`; otherwise they share `Shares.csv`.

The easiest way to bring a new export in:

```bash
npm run nyra -- linkedin import ~/Downloads/Shares.csv --account brand-a
npm run nyra -- linkedin history
```

The command checks that the file is a LinkedIn `Shares.csv`, copies it to the
account's import file and imports it. Every import is recorded (file hash,
rows, new posts, conflicts); an unchanged file is skipped on later runs. Posts
that already belong to another account are not reassigned and are reported
(two accounts pointing at one export). A missing export is a warning that
does not mark the account as fresh; an unreadable file is an error and shows
up in problem alerts. Export timestamps are read as UTC.

Import is idempotent. Engagement metrics are not present in LinkedIn's export,
so imported posts use zero or null values for those fields.

### Telegram

Telegram collection uses GramJS/MTProto polling. Store your API keys from
my.telegram.org in the vault:

```bash
npm run nyra -- secrets set telegram-api
```

Run `npm run login:telegram` (or `-- --session <name>` for another Telegram
account) for QR login, following the same GramJS flow as
Inemuri. On your phone, open Telegram > Settings > Devices > Link Desktop Device
and scan the QR displayed in the terminal. The QR refreshes automatically; no
SMS or verification code is required. If 2FA is enabled, enter its password in
the terminal's hidden prompt.

After Telegram confirms authorization, the command stores the session in the
encrypted vault without printing it (without a vault: in the root `.env`).
Restart running MCP/daemon processes to load the saved session. Run this command in an
interactive terminal; Ctrl+C cancels login and closes the connection.

Phone/code login remains available:

```powershell
npm run login:telegram -- --phone
```

Both login methods require your own Telegram API id and hash.
Bot API posting does not require this user session. Each publish-enabled
channel can name its bot with `"bot": "<name>"` (stored with
`npm run nyra -- secrets set telegram-bot <name>`).

Configure channel usernames in `accounts.json` without `@`:

```json
{
  "username": "example_channel",
  "display_name": "Example Channel",
  "platform": "telegram",
  "active": true
}
```

The first run for a new Telegram account imports the latest
`TELEGRAM_INITIAL_POSTS_PER_ACCOUNT` posts, default `20`, and then uses the
newest imported post as the future polling baseline. Later daily runs poll
recent history pages, re-read a small overlap window, and persist only new
messages through the same post upsert path used by other publishing platforms.

## AI Content Workflow

The agent (any MCP client) and the web UI share one loop:

```text
content_plan_get ─► context_get(persona) ─► signals_get ─► posts_get(sample) ─► draft_create
        ▲                                                                         │
        └──── signals marked used ◄── published (Telegram auto / X, LinkedIn manual) ◄── review in web UI
```

| Tool | Purpose |
|---|---|
| `content_plan_get` | Which accounts are overdue/due vs. `platforms.<platform>.posting_frequency` (e.g. `"3 posts per week"`, `"daily"`, `"щодня"`), with waiting drafts and unused signals |
| `signal_add` | Save an idea, link or note as material, optionally for one persona |
| `draft_create` / `draft_update` / `drafts_list` / `draft_get` | Drafts per platform and account; persona derived from the account; source `signal_ids` |
| `draft_prepare_telegram` | Turn a Telegram draft into an outbox request; publishing still needs `telegram_post_publish` and approval |
| `draft_mark_published` | Record a post the author published themselves; marks its signals used |
| `content_performance_get` | How published drafts performed vs. the account's median post, by signal type and AI vs. author |

After each collection, published drafts are linked to the collected post by
their URL, so engagement flows back to the draft and to the signals it used.

MCP prompts (prompt menu of the MCP client): `write_post`, `content_week`,
`repurpose_signal`, `performance_review`. X and LinkedIn are never published
by the agent.

## Problem Alerts

EANyra writes to you only when something is wrong, via a Telegram bot and/or
a Discord webhook:

- a login is missing, logged out or expired (X, Telegram, GitHub, bot);
- an X login cookie expires within `auth_expiring_days` (default 3);
- accounts whose collection failed (grouped by the same error);
- an account not collected for `stale_hours` (default 48);
- the whole collection run failed;
- a Telegram post whose delivery is uncertain.

Checks run after every collection (CLI, scheduler, MCP, web). One digest per
check; an unchanged problem is repeated at most every `repeat_hours` (24), and
a problem that disappears is reported once as resolved.

```bash
# Telegram: open your bot, press Start, then
npm run nyra -- notify telegram-chat
# Discord: paste the webhook URL into the hidden prompt (stored in the vault)
npm run nyra -- notify discord
npm run nyra -- notify test        # send a test message
npm run nyra -- notify status      # channels + problems right now (sends nothing)
```

Settings live in `instance/notifications.json` (no secrets; example in
`instance_example/notifications.json.example`). The web overview shows the
same status and a test button.

## Backup and Restore

```bash
npm run backup                                   # → instance/backups/eanyra-<time>/
npm run backup -- --out D:/Backups/eanyra-today  # prefer another disk or cloud folder
npm run instance:restore -- <backup-dir>         # verify and show what would change
npm run instance:restore -- <backup-dir> --yes   # restore (stop collection, MCP, web UI first)
```

A backup holds an online, integrity-checked snapshot of `pot.sqlite`
(`VACUUM INTO`, safe while collection runs), the encrypted `secrets.vault`,
`accounts.json`, `notifications.json`, `context/` and a `manifest.json` with
SHA-256 of every file. `.env` is copied only with `--include-env`, because it
may still contain plaintext settings. Restore verifies every hash first,
refuses while a collection holds the scrape lock, and moves the current files
(including SQLite `-wal`/`-shm`, which must not survive a database swap) to
`instance/backups/pre-restore-<time>/`. The vault still needs the same master
password; run `npm run nyra -- vault remember` again on a new PC or user.

## Web UI

`npm run serve` starts a local web interface on `http://127.0.0.1:3030`
(`WEB_PORT`, `--port`). Log in with the master password; it also unlocks the
vault for collection and publishing. Without a vault the terminal prints a
one-time access token.

- **Контент:** publishing plan per persona and account (cadence from
  `posting_frequency` vs. real posts), AI and manual drafts with edit, approve,
  discard; X/LinkedIn drafts open the official compose dialog with the text
  filled in and are then marked published with their URL; Telegram drafts are
  published after confirmation.
- **Огляд:** collection health, freshness per platform, accounts needing
  attention with their last error, recent runs with per-account outcomes,
  one-click collection per platform or for everything.
- **Акаунти:** accounts, personas and the state of every login session;
  context sync after editing YAML.
- **Пости / Сигнали:** browse and search collected posts by persona,
  platform and engagement; unused signals; add ideas and links as signals.
- **Telegram:** drafts prepared by the AI (MCP) or in the form; publish only
  after an explicit confirmation.
- **Задачі:** collection jobs from MCP, the browser and the scheduler.

The browser calls the same tools as the AI agent (`core/mcp/toolRegistry.js`),
with the same validation. `npm run serve -- --schedule` also runs cron
collection in the same process, and `npm run serve -- --mcp` exposes the MCP
server at `/mcp` for AI clients (Bearer token from
`npm run nyra -- mcp token`; browser origins refused), so the agent and the
UI share one process, one job table and the unlocked vault. The server binds to loopback only, checks the
Host header, requires a same-origin custom header on every POST, uses
HttpOnly SameSite=Strict session cookies, throttles failed logins and sends a
strict Content-Security-Policy.

## Stopping Safely

Press Ctrl+C once in `npm run scrape`, `npm start`, `npm run serve` or the MCP
server: collection finishes the current account, saves refreshed X logins to
the vault, records the run as partial and releases the lock; long pauses
between X profiles are cut short. Press Ctrl+C again to force. A running job
can also be stopped with the MCP tool `scraper_job_stop` or the Stop button on
the web «Задачі» tab. The remaining accounts are collected on the next run.

Console output: `LOG_LEVEL=debug|info|warn|error|silent`, or `--quiet` /
`--debug` on any `npm run nyra -- <command>`.

## CLI

Use `npm run nyra -- <command>` (the npm shortcut for the `eanyra` binary)
when `eanyra` is not globally linked; both run the same CLI.

| Command | Purpose |
|---|---|
| `npm start` | Start the cron daemon |
| `npm run backup [-- --out <dir>] [--include-env]` | Snapshot database, vault, accounts, alerts and context |
| `npm run instance:restore -- <dir> [--yes]` | Verify and restore a backup |
| `npm run lint` / `npm run check` | ESLint / lint + tests |
| `npm run serve [-- --schedule] [--mcp] [--port <n>]` | Local web UI on 127.0.0.1, optionally with cron collection and MCP at `/mcp` |
| `npm run nyra -- mcp token [--rotate]` | Create/show/rotate the Bearer token for MCP at `/mcp` |
| `npm run nyra -- notify telegram-chat` / `discord` | Enable problem alerts via a Telegram bot or a Discord webhook |
| `npm run nyra -- notify status` / `test` / `check` / `off <channel>` | Inspect, test, run or disable alerts |
| `npm run scrape` | Collect all active configured accounts once |
| `npm run scrape:twitter` | Collect Twitter/X accounts once |
| `npm run scrape:github` | Collect GitHub accounts once |
| `npm run scrape:linkedin` | Import LinkedIn accounts once |
| `npm run scrape:telegram` | Poll Telegram accounts once |
| `npm run nyra -- scrape <platform>` | Collect one platform once |
| `npm run context:sync` | Sync YAML author context into SQLite |
| `npm run nyra -- context show` | Print all context currently stored in SQLite |
| `npm run nyra -- context show -k <key>` | Print one context key |
| `npm run export` | Generate a Markdown content export |
| `npm run export:dry` | Generate an export without marking records used |
| `npm run login [-- --session <name>]` | Best-effort interactive Twitter/X login into one session |
| `npm run login:telegram [-- --session <name>]` | Telegram QR login, session stored in the vault |
| `npm run login:telegram -- --phone` | Alternative login by phone and verification code |
| `npm run import-cookies [-- <file>] [--session <name>] [--delete-source]` | Recommended: import browser cookies into one X session (default file `instance/data/imports/cookies.json`) |
| `npm run nyra -- vault init` | Create the encrypted vault and import plaintext secrets |
| `npm run nyra -- vault status` | Show stored secrets (names only) and plaintext leftovers |
| `npm run nyra -- vault migrate [--purge]` | Import plaintext `.env` secrets, cookie cache and X profile; `--purge` deletes the plaintext copies |
| `npm run nyra -- vault remember` / `forget` | Let background processes on this PC unlock the vault (Windows DPAPI) |
| `npm run nyra -- vault change-password` | Re-encrypt with a new master password |
| `npm run nyra -- secrets set <github\|telegram-bot\|telegram-api> [name]` | Store a token or API keys (hidden prompt) |
| `npm run nyra -- secrets list` / `delete <kind> <name>` | List or remove stored secrets |
| `npm run nyra -- sessions` | Which login each account uses and whether it is configured or expired |

Important export options:

| Option | Meaning |
|---|---|
| `--days <n>` | Date window for recent records; default `7` |
| `--sections <list>` | Any of `context,projects,posts,signals` |
| `--platform <name>` | Filter posts, bio, and platform rules by one platform |
| `--platforms <list>` | Filter posts, bio, and platform rules by a comma-separated platform list |
| `--unused-only` | Include only records not exported before |
| `--no-mark` | Do not update `exported_at` timestamps |
| `--out <path>` | Write to a custom file |

Exports are written to `instance/data/exports/` by default.
For custom options, use `node src/core/cli/index.js export [options]` or the
globally linked `eanyra export [options]` command.

For example, generate one export for Twitter/X and Telegram:

```bash
npm run nyra -- export --platforms twitter,telegram
```

Platform filters do not remove voice, active projects, or signals. Those are
shared source material rather than platform-specific publishing records.

## Author Context

Context files are the editable source of truth:

```text
instance/context/
  voice.yaml
  bio.yaml
  platforms.yaml
  projects/*.yaml
```

All real instance files are gitignored. Versioned examples and the project
template live in `instance_example/`; `npm run instance:init` copies missing
files without overwriting your edits. Edit the files in `instance/context/`,
then sync:

```bash
npm run nyra -- context sync
```

The sync writes top-level context into `user_context` and project metadata into
both `projects` and `user_context`.

**Personas.** When accounts serve different purposes (for example a business
brand and an anime account), group them into personas in
`instance/context/personas/<slug>.yaml`. A persona lists its accounts across
platforms (`twitter/...`, `linkedin/...`, `telegram/...`) and has its own voice,
bio, platform rules and projects on top of the global files. MCP agents call
`context_get` with the target account or persona and filter posts with
`persona`, so each account gets its own context.

See the [Author Context Guide](docs/CONTEXT_GUIDE.md) for every supported field,
writing guidance, sync semantics, and current validation limitations.
To delegate creation of one project file to an AI agent, give it the
[AI Project Context Instructions](docs/PROJECT_CONTEXT_PROMPT.md).

## MCP Server

The intended MCP entry point is:

```bash
node src/core/mcp/start.js
```

It supports local stdio and Streamable HTTP transports:

```env
MCP_TRANSPORT=stdio
MCP_HOST=127.0.0.1
MCP_PORT=3001
DB_PATH=data/pot.sqlite
```

The registered MCP API is designed to expose:

- `context_get`, `export_get`;
- `posts_get`, `posts_search`, `posts_stats`, `accounts_list`;
- `signals_get`, `signals_mark_used`;
- `scraper_status`;
- `scraper_run`, `scraper_job_get` for background collection;
- `telegram_messages_get` for channel messages, including forwards and replies;
- `telegram_publisher_info`, `telegram_publish_targets`;
- `telegram_post_prepare`, `telegram_post_publish`, `telegram_post_get` for
  explicit Telegram publishing with durable draft and delivery state.

Configuration loads `.env` and resolves relative runtime paths from
the selected instance even when an MCP client starts elsewhere. Use `npm run mcp` for a
terminal launch. See [MCP and multiple accounts](docs/MCP_GUIDE.md) for connection
configuration and agent workflows, and [the implementation audit](docs/REVIEW_2026-10-24.md)
for remaining limitations.

HTTP transport is restricted to loopback addresses and rejects browser origins.
Each HTTP session has its own MCP server instance. Remote HTTP deployment needs
an authenticated transport design before it can be enabled.

The server reads all runtime paths, transport settings, routes, and query limits
from `src/config/app.config.js`.

## Configuration

Runtime configuration is centralized in `src/config/app.config.js`.
`instance_example/.env.example` documents every supported environment variable. The groups are:

- general: `NODE_ENV`;
- instance selection: `INSTANCE_DIR` in root `.env` or the process environment
  (default `<project>/instance`);
- runtime paths relative to the instance: `DATA_DIR`, `ACCOUNTS_CONFIG_PATH`, `CONTEXT_DIR`,
  `EXPORTS_DIR`;
- scheduler: `CRON_SCHEDULE`, `RUN_ON_STARTUP`;
- database: `DB_PATH`, `DB_POOL_*`;
- MCP: `MCP_TRANSPORT`, `MCP_HOST`, `MCP_PORT`, routes and query defaults;
- browser and Twitter/X: `BROWSER_*`, `TWITTER_*`;
- scraper behavior: `POSTS_PER_ACCOUNT`, `INITIAL_POSTS_PER_ACCOUNT`,
  `SCROLL_DELAY_MS`, account delay limits, scroll, stagnation, and timeout
  limits;
- Markdown export: `EXPORT_DEFAULT_DAYS`, `EXPORT_MAX_RECORDS`;
- GitHub: `GITHUB_TOKEN`, `GITHUB_LOOKBACK_DAYS`,
  `GITHUB_REPOS_PER_ACCOUNT`, release/commit limits;
- LinkedIn: `LINKEDIN_IMPORTS_DIR`, `LINKEDIN_SHARES_FILE`,
  `LINKEDIN_PROFILE_FILE`;
- Telegram: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`,
  `TELEGRAM_PUBLISH_TRANSPORT` (default `bot`), `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_FETCH_LIMIT`, `TELEGRAM_INITIAL_POSTS_PER_ACCOUNT`,
  `TELEGRAM_MAX_PAGES_PER_ACCOUNT`, and overlap options.

## Documentation

- [Instance layout](docs/INSTANCE_GUIDE.md): editable files, initialization,
  migration from the legacy layout, and isolated instance selection.
- [Accounts, sessions and encryption](docs/ACCOUNTS_AND_SECRETS.md): several
  own accounts, per-account logins, the master-password vault and unlocking.

- [Architecture](docs/ARCHITECTURE.md): module boundaries, runtime flows, data
  model, and extension points.
- [Author Context Guide](docs/CONTEXT_GUIDE.md): how to write and synchronize
  voice, biography, platform, and project YAML files.
- [AI Project Context Instructions](docs/PROJECT_CONTEXT_PROMPT.md): a
  self-contained handoff for creating or updating one verified project YAML.
- [Product Vision](docs/PRODUCT_VISION.md): durable product purpose, boundaries,
  and target agent workflows.
- [Roadmap](docs/ROADMAP.md): confirmed defects, risks, and planned
  improvements.
- [Code Style](docs/CODE_STYLE.md): source formatting, comments, and encoding
  conventions.
- [Twitter Scraping Status](docs/TWITTER_SCRAPING_STATUS.md): current
  implementation state, verified behavior, and unresolved reply discovery.
- [Agent skill](skills/eanyra/SKILL.md): intended AI-agent content workflow.

## Development Notes

The `node:test` suite covers parsers, repositories, migrations, export behavior,
account validation, collection jobs, and MCP stdio/HTTP integration. Run it with
`npm test`; HTTP integration needs local loopback networking. There is currently
no lint script or separate versioned migration command.
JavaScript syntax can be checked with:

```powershell
$files = rg --files -g '*.js'
foreach ($file in $files) { node --check $file }
```

EANyra uses Sequelize with SQLite and applies versioned schema migrations during
CLI startup. Runtime startup does not call `sequelize.sync()`. Back up
`instance/data/pot.sqlite` before schema-level development.

## License

See [LICENSE](LICENSE).
