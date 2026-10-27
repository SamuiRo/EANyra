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

- Node.js 20+; Node.js 22 is recommended
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

Edit `.env` and `instance/accounts.json`, then initialize the data sources you
need:

```bash
# Twitter/X only: recommended session setup
npm run import-cookies   # reads instance/data/imports/cookies.json

# Best-effort alternative; X may reject automated-browser login
npm run login

# LinkedIn only: place Shares.csv in instance/data/imports/

# Telegram only: configure TELEGRAM_API_ID / TELEGRAM_API_HASH, then create a session
npm run login:telegram

# Collect all configured platforms once
npm run scrape

# Sync author context from instance/context/*.yaml into SQLite
npm run context:sync

# Generate a Markdown context export without marking records as used
npm run export:dry

# Start the scheduled daemon
npm start
```

The same commands work in Windows PowerShell. When upgrading an existing
checkout with settings under `src/` and root `.env`/`data/`, stop the daemon
and run migration **before** initializing a new instance:

```powershell
npm run instance:migrate
```

## Account Configuration

The root `.env` contains credentials and runtime settings. Editable accounts,
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

On each scrape, configured accounts are upserted into SQLite. Set
`"archive": true` to explicitly archive an account. Accounts removed from the
JSON file are also archived during the next sync. Archived accounts remain in
SQLite with their historical posts and signals, but are inactive.

## Platform Setup

### Twitter/X

Twitter collection uses a persistent Playwright Chromium profile.

```bash
npm run import-cookies
npm run scrape:twitter
```

Export the `x.com` cookies from your normal browser to
`instance/data/imports/cookies.json` and run `npm run import-cookies`, or pass
another file with `npm run import-cookies -- <file>`. The default location is
`BROWSER_COOKIES_IMPORT_PATH`. The cookie file must contain `auth_token`.
Session data is stored in `instance/data/nyra/`. A gitignored fallback copy is stored at
`BROWSER_COOKIES_PATH` and restored automatically if X clears the cookie from
the persistent browser profile. Re-import only when the fallback token itself
is no longer accepted by X.

**Several X profiles.** Add one `"platform": "twitter"` entry per profile to
`accounts.json`; all of them are collected through the same imported session.
A run collects other platforms first, then X profiles starting with the least
recently collected one, pausing `MIN/MAX_DELAY_BETWEEN_ACCOUNTS_MS` between X
profiles only. If X redirects to login, the remaining X profiles are skipped
instead of each waiting for its pause. Collect a subset with
`npm run nyra -- scrape twitter --account first_profile second_profile` or the
MCP `scraper_run` `accounts` argument. The optional per-account
`"session": "default"` field is reserved for separate X logins in the future;
only `default` is accepted today.

`npm run login` remains available as a best-effort helper. It opens an
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

Add a token to `.env`:

```env
GITHUB_TOKEN=github_pat_...
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

Import is idempotent. Engagement metrics are not present in LinkedIn's export,
so imported posts use zero or null values for those fields.

### Telegram

Telegram collection uses GramJS/MTProto polling. Add credentials to `.env`:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_SESSION=your_saved_string_session
```

Run `npm run login:telegram` for QR login, following the same GramJS flow as
Inemuri. On your phone, open Telegram > Settings > Devices > Link Desktop Device
and scan the QR displayed in the terminal. The QR refreshes automatically; no
SMS or verification code is required. If 2FA is enabled, enter its password in
the terminal's hidden prompt.

After Telegram confirms authorization, the command saves `TELEGRAM_SESSION`
directly to the root `.env` without printing it or changing other keys. Restart
running MCP/daemon processes to load the saved session. Run this command in an
interactive terminal; Ctrl+C cancels login and closes the connection.

Phone/code login remains available:

```powershell
npm run login:telegram -- --phone
```

Both login methods require your own `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.
Bot API posting does not require this user session.

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

## CLI

Use `npm run nyra -- <command>` when the `eanyra` binary is not globally linked.

| Command | Purpose |
|---|---|
| `npm start` | Start the cron daemon |
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
| `npm run login` | Best-effort interactive Twitter/X login |
| `npm run login:telegram` | QR login and automatic session save to root `.env` |
| `npm run login:telegram -- --phone` | Alternative login by phone and verification code |
| `npm run import-cookies [-- <file>]` | Recommended: import browser cookies into the persistent session (default `instance/data/imports/cookies.json`) |

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
