# EANyra

Multi-platform social media monitoring pipeline designed primarily for AI agents.

EANyra scrapes selected accounts across platforms (Twitter/X via Playwright, GitHub via REST API), stores all data in SQLite, and exposes it through an MCP server — so an AI agent can query posts, GitHub activity, stats, and scraper health directly from the database. This eliminates token waste on live scraping and gives the agent structured, reliable data on demand.

The pipeline is equally useful outside of AI contexts: as a data source for scripts, dashboards, or any automation that needs a local feed of social/code activity.

---

## How it works

```
Twitter/X  ──►  TwitterScraper (Playwright)  ──►  posts
                                                        \
GitHub     ──►  GithubScraper (REST API)    ──►  github_events  ──►  pot.sqlite
                                                                           │
                                                                    MCP Server
                                                               (src/core/mcp/server.js)
                                                                           │
                                                                    AI Agent
                                                              (OpenClaw / Claude Desktop)

src/context/*.yaml  ──►  eanyra context sync  ──►  pot.sqlite
  (edited by hand)                                       │
                                                  context_get()
                                                  (MCP tool)
```

The scraper runs on a schedule and keeps the database fresh. The MCP server is a lightweight read-only layer on top — it exposes typed tools that the agent calls directly, with no browser, no live scraping, and no wasted tokens.

User context (voice, bio, platform rules, projects) is stored as YAML files and synced into the DB on demand. The agent always reads context from DB — never from files directly.

---

## Project structure

```
EANyra/
├── package.json
├── .env                        # Runtime config (copy from .env.example)
├── .env.example                # All available env variables with defaults
├── README.md
├── data/                       # Runtime data — gitignored
│   ├── nyra/                   # Playwright persistent context (cookies, session)
│   └── pot.sqlite              # SQLite database
└── src/
    ├── context/                        # User context — YAML source of truth
    │   ├── voice.yaml                  # Tone, style, likes/dislikes, taboo
    │   ├── bio.yaml                    # Bio per platform
    │   ├── platforms.yaml              # Content rules per platform
    │   └── projects/
    │       ├── eanyra.yaml             # Project description, angles, posting rules
    │       └── _template.yaml          # Copy this to add a new project
    ├── core/
    │   ├── cli/
    │   │   ├── index.js                # Entry point — Commander CLI
    │   │   └── contextCommands.js      # `eanyra context` sub-commands
    │   ├── orchestrator/
    │   │   └── ScraperOrchestrator.js  # Routes accounts to the correct platform scraper
    │   ├── scheduler/
    │   │   └── Scheduler.js            # node-cron wrapper
    │   ├── browser/
    │   │   └── Browser.js              # Playwright persistent context + anti-detection
    │   ├── teapot/                     # Database layer (kept as "teapot")
    │   │   ├── database.js             # Sequelize singleton
    │   │   ├── models/
    │   │   │   ├── index.js            # registerModels() — associations live here
    │   │   │   ├── Account.js          # Shared across platforms (has `platform` field)
    │   │   │   ├── Post.js             # Twitter posts
    │   │   │   ├── GithubEvent.js      # GitHub events (releases, commits, repos, README)
    │   │   │   ├── ScraperRun.js
    │   │   │   ├── UserContext.js      # Key/value store for YAML context
    │   │   │   └── Project.js          # Project metadata from projects/*.yaml
    │   │   └── repositories/
    │   │       ├── AccountRepository.js
    │   │       ├── PostRepository.js
    │   │       ├── GithubEventRepository.js
    │   │       ├── ScraperRunRepository.js
    │   │       └── UserContextRepository.js  # YAML → DB sync logic
    │   └── mcp/
    │       ├── server.js               # Entry point, tool registration
    │       ├── db.js                   # SQLite query layer for MCP tools
    │       └── tools/
    │           ├── twitter.js          # Post/account query tools
    │           ├── status.js           # Scraper health tool
    │           └── context.js          # context_get() tool
    ├── platforms/
    │   ├── twitter/
    │   │   ├── index.js            # Platform module interface (factory + re-exports)
    │   │   ├── TwitterScraper.js   # DOM-based tweet extractor (Playwright)
    │   │   └── humanBehavior.js    # Realistic mouse/scroll helpers
    │   └── github/
    │       ├── index.js            # Platform module interface (factory + re-exports)
    │       ├── GithubScraper.js    # Activity collector (REST API, no browser)
    │       └── client.js           # GitHub REST API v3 wrapper
    ├── config/
    │   ├── app.config.js               # All configuration with documented defaults
    │   └── accounts.json               # Monitored accounts list (all platforms)
    └── shared/
        ├── utils.js                    # Logging, sleep, jitter, file helpers
        └── message.js                  # CLI/MCP user-facing messages
```

### Directory purposes

| Path | Purpose |
|------|---------|
| `src/context/` | YAML source of truth for user context. Edit by hand; sync to DB via `eanyra context sync`. Versioned in git. |
| `src/core/mcp/` | MCP server exposing DB data to AI agents via typed tools. |
| `src/config/` | Environment config and exported constants. Single source of truth for all tuneable values. |
| `src/core/browser/` | Playwright persistent context management and anti-detection patches. Only used by Twitter. |
| `src/platforms/twitter/` | Twitter/X extraction via Playwright DOM scraping. `index.js` exposes the standard platform interface; `TwitterScraper.js` handles extraction; `humanBehavior.js` handles mouse/scroll simulation. |
| `src/platforms/github/` | GitHub activity collection via REST API. `client.js` wraps the API; `GithubScraper.js` collects releases, commit batches, new repos, and README changes. No browser required. |
| `src/core/cli/` | Commander-based CLI entry point (`eanyra start`, `eanyra scrape [platform]`, `eanyra context`). |
| `src/core/orchestrator/` | Reads all active accounts, filters by platform, dispatches to the right scraper. |
| `src/core/scheduler/` | `node-cron` wrapper for scheduled execution. |
| `src/shared/` | Reusable utilities shared across the project. |
| `src/core/teapot/` | Database layer: Sequelize wrapper, model definitions, repository classes. |

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in GITHUB_TOKEN (and Twitter credentials if needed)
cp .env.example .env

# 3. Twitter only: log in once (opens a real Chrome window — complete login manually)
npm run login

# 4. Run a single scrape to verify everything works
npm run scrape

# 5. Sync user context into the database
eanyra context sync

# 6. Start the daily daemon
npm start
```

---

## CLI

EANyra ships a `eanyra` binary (registered in `package.json` → `bin`).
After `npm install` you can run it directly via `npx eanyra` or, after `npm link`, globally as `eanyra`.

```
Usage: eanyra [command]

Commands:
  start                   Start the daemon — scrapes on the configured cron schedule
  scrape [platform]       Run a single scrape then exit
  context sync            Read src/context/ YAML files and sync into the database
  context show            Print current context from the database (what the agent sees)
  context show -k <key>   Print a single context key (voice, bio, platforms, project.eanyra)

Options:
  -v, --version           Print version and exit
  -h, --help              Display help
```

### Examples

```bash
# Daemon mode (same as npm start)
eanyra start

# Scrape all platforms once and exit
eanyra scrape

# Scrape only Twitter/X and exit
eanyra scrape twitter

# Scrape only GitHub and exit
eanyra scrape github

# Sync context after editing any YAML file
eanyra context sync

# Inspect what the agent currently sees
eanyra context show
eanyra context show -k voice
eanyra context show -k project.eanyra
```

### npm scripts (convenience wrappers)

| Script | Equivalent | Description |
|--------|-----------|-------------|
| `npm start` | `eanyra start` | Start the cron daemon |
| `npm run dev` | `node --watch … start` | Daemon with auto-restart on file change |
| `npm run scrape` | `eanyra scrape` | Single run, all platforms |
| `npm run scrape:twitter` | `eanyra scrape twitter` | Single run, Twitter/X only |
| `npm run login` | — | Open browser for manual Twitter login |

---

## Platform module interface

Each platform lives under `src/platforms/<name>/` and exposes a standard interface via its `index.js`:

```js
// Stable string key — used in CLI commands and DB records
export const PLATFORM_ID = 'twitter'; // or 'github'

// Human-readable label for logs and help text
export const displayName = 'Twitter / X';

// Factory — creates a scraper instance without exposing the constructor
export function createScraper(...args) { … }

// Re-exports of public classes
export { TwitterScraper } from './TwitterScraper.js';
```

`ScraperOrchestrator` dispatches to platforms via a `switch` on `account.platform`. Adding a new platform means:
1. Create `src/platforms/<name>/index.js` with `createScraper()` + `PLATFORM_ID`
2. Add a `case` in `ScraperOrchestrator.#scrapeAccount()`
3. Add the platform string to `VALID_PLATFORMS` in `cli/index.js`

---

## Multi-platform account management

All monitored accounts live in `src/config/accounts.json`, regardless of platform. The `platform` field controls which scraper runs for each account. Omitting `platform` defaults to `'twitter'`.

```json
[
  { "username": "elonmusk",  "display_name": "Elon Musk",    "platform": "twitter", "active": true },
  { "username": "sama",      "display_name": "Sam Altman",   "platform": "twitter", "active": true },
  { "username": "torvalds",  "display_name": "Linus Torvalds","platform": "github", "active": true }
]
```

On every run, `AccountRepository.syncFromConfig()` upserts this list into the `accounts` table. Set `"active": false` to pause an account without deleting its data.

---

## GitHub module

### Setup

1. Generate a Personal Access Token at https://github.com/settings/tokens
   - Required scopes: `read:user`, `public_repo`
2. Add to `.env`:
   ```env
   GITHUB_TOKEN=ghp_your_token_here
   ```
3. Add GitHub accounts to `accounts.json` with `"platform": "github"`
4. Run `eanyra scrape github` to verify

### What gets collected

| Event type | Description |
|------------|-------------|
| `release` | A published release/tag on any repo (draft releases skipped) |
| `commit_batch` | Commits grouped by calendar week — one DB row per repo per week; stores count + up to 10 commit messages |
| `new_repo` | A public repo created within the lookback window |
| `readme_change` | README sha changed since the previous run |

All events are stored in the `github_events` table. Deduplication is handled by a unique constraint on `event_id` — the stable key format is `<type>:<owner>/<repo>:<detail>`, e.g. `commit_batch:torvalds/linux:2025-W03`.

### README change detection

`GithubEventRepository.getReadmeShas()` returns a map of `"username/repo" → last known README sha`, loaded from the most recent `readme_change` events in the DB. `GithubScraper` compares this against the current README sha from the API on each run. No sha stored = first time seen = no event emitted (avoids false positives on first scrape).

### Rate limits

GitHub allows 5 000 requests/hour with a PAT. For typical usage (10–20 accounts, daily runs) this limit is not a concern.

### Configurable parameters

All GitHub parameters are in `app.config.js` under `GITHUB` and can be overridden via `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | Personal Access Token (required) |
| `GITHUB_LOOKBACK_DAYS` | `8` | How many days back to look for events |
| `GITHUB_REPOS_PER_ACCOUNT` | `30` | Max repos inspected per account (sorted by push date) |
| `GITHUB_RELEASES_PER_REPO` | `10` | Max releases fetched per repo |
| `GITHUB_COMMITS_PER_REPO` | `100` | Max commits fetched per repo within the lookback window |
| `GITHUB_COMMIT_MESSAGES_PER_BATCH` | `10` | Max commit messages stored in a `commit_batch` body |

---

## Scrape depth — Twitter only

The orchestrator automatically detects whether a Twitter account has been scraped before:

| Condition | Posts target | Behaviour |
|-----------|-------------|-----------|
| No posts in DB yet | `INITIAL_POSTS_PER_ACCOUNT` (default 200) | Deep scroll — collects historical posts |
| Posts already exist | `POSTS_PER_ACCOUNT` (default 20) | Shallow scroll — catches today's activity |

All posts are upserted by `tweet_id` so re-runs never create duplicates. GitHub events use the same pattern via `event_id`.

---

## Human-behaviour simulation (Twitter only)

The Twitter scraper is designed to look like a person casually browsing several profiles.
All behaviour is implemented in `humanBehavior.js` and wired into `TwitterScraper.js`.

**Per-run (orchestrator level):**
- **0–3 min random "wake-up" pause** before the first Twitter account
- **5–15 min random gap** between consecutive Twitter accounts
- GitHub accounts have no inter-account delay (REST API, no bot detection pressure)

**Per-account (scraper level):**
- **`simulatePageLanding()`** — called once after the first tweet appears: moves the mouse from the top-left corner, pauses 2–5 s as if reading the profile header, performs a small initial scroll, and occasionally hovers over the tweet area
- **Bézier-curve mouse movement** before each scroll (not a straight line)
- **Reading pause** of 1.5–4 s before every scroll step
- **±15–35% jitter** on scroll distance (never the same pixel value twice)
- **~15% chance** of a small upward correction scroll (humans overshoot)
- **Occasional idle micro-movements** while the page settles

All delays are configurable via `.env` — see `.env.example`.

---

## Anti-detection (Browser.js)

Beyond human behaviour, the browser context patches several fingerprint vectors:

| Layer | What is patched | Why |
|-------|----------------|-----|
| Chromium args | `--disable-blink-features=AutomationControlled` | Removes the main CDP automation flag |
| `navigator.webdriver` | Returns `false` | Most basic bot check |
| `navigator.plugins` | Returns 3 realistic plugins | Headless Chrome has 0 plugins |
| `navigator.languages` | `['en-US', 'en']` | Consistency with locale setting |
| `Permissions API` | Returns `"prompt"` for notifications/geolocation | Headless silently denies all |
| Canvas fingerprint | ±1 bit of per-session noise | Breaks deterministic SwiftShader hash |
| WebGL renderer | `"Intel Iris OpenGL Engine"` | Hides `"Google SwiftShader"` headless tell |
| `window.chrome` | Minimal chrome object present | Missing in headless, checked by detectors |
| `screen.availWidth/Height` | Matches `window.innerWidth/Height` | Headless mismatch |
| Network routing | Blocks analytics/telemetry domains | Reduces bot-signal telemetry to Twitter |

**Viewport** is fixed (not randomised per run) because a persistent context must look consistent across sessions — a changing viewport is itself a fingerprint anomaly.

---

## Database schema

### `accounts`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| username | STRING | Account handle (unique) |
| display_name | STRING | Human-readable label |
| platform | STRING | `'twitter'` or `'github'` (default: `'twitter'`) |
| is_active | BOOLEAN | Soft toggle |
| last_scraped_at | DATE | Timestamp of last successful scrape |

### `posts` (Twitter)

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| tweet_id | STRING | Twitter's own ID (unique — prevents duplicates) |
| account_id | INTEGER | FK → accounts |
| text | TEXT | Full post text |
| lang | STRING | Language code (`en`, `uk`, …) |
| posted_at | DATE | Original publication timestamp |
| likes | INTEGER | Like count at time of scrape |
| retweets | INTEGER | Retweet count |
| replies | INTEGER | Reply count |
| views | INTEGER | View/impression count (if available) |
| media_urls | TEXT | JSON array of photo/video URLs |
| is_retweet | BOOLEAN | Is this a retweet? |
| is_reply | BOOLEAN | Is this a reply? |
| raw_url | STRING | Direct link to the tweet |
| scraped_at | DATE | When this record was captured |

### `github_events` (GitHub)

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| event_id | STRING(256) | Stable unique key — prevents duplicates across runs |
| account_id | INTEGER | FK → accounts |
| username | STRING | GitHub login |
| repo | STRING | Repository name (short, no owner prefix) |
| event_type | ENUM | `release` / `commit_batch` / `new_repo` / `readme_change` |
| title | STRING | Human-readable summary |
| body | TEXT | Release notes, commit messages, etc. |
| url | STRING | Direct link to the event on GitHub |
| occurred_at | DATE | When the event happened |
| metadata | TEXT | JSON — event-type-specific extra fields (tag, sha, week, count…) |
| scraped_at | DATE | When this record was captured |

`event_id` format: `<type>:<owner>/<repo>:<detail>`
Examples: `release:torvalds/linux:12345678`, `commit_batch:torvalds/linux:2025-W03`, `readme_change:torvalds/linux:<new_sha>`

### `scraper_runs`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| started_at | DATE | Run start time |
| finished_at | DATE | Run end time |
| status | ENUM | `running` / `success` / `partial` / `failed` |
| accounts_processed | INTEGER | Successfully scraped accounts |
| posts_saved | INTEGER | Newly inserted records (posts + events combined) |
| error_message | TEXT | Top-level error if failed or partial |

### `user_context`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| key | STRING(128) | Unique identifier: `voice`, `bio`, `platforms`, `project.<slug>` |
| value | TEXT | JSON-serialised content of the corresponding YAML section |
| synced_at | DATE | Timestamp of last sync from YAML |

### `projects`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| slug | STRING(64) | Unique identifier (from `slug` field in YAML or filename) |
| name | STRING | Human-readable project name |
| status | ENUM | `active` / `paused` / `archived` |
| description | TEXT | Full project description |
| tech_stack | TEXT | JSON array of tech stack items |
| links | TEXT | JSON object `{ github, website, ... }` |
| content_angles | TEXT | JSON array of content angle strings |
| posting_rules | TEXT | JSON array of posting rule strings |
| synced_at | DATE | Timestamp of last sync from YAML |

---

## Environment variables

See `.env.example` for the full list with defaults. Key variables:

```env
# Scheduling
CRON_SCHEDULE=0 8 * * *               # When to run (UTC). Default: 08:00 daily
RUN_ON_STARTUP=false                   # Run once immediately on process start

# Twitter / Browser
BROWSER_HEADLESS=true                  # false to watch the browser (debug only)
POSTS_PER_ACCOUNT=20                   # Daily top-up depth
INITIAL_POSTS_PER_ACCOUNT=200          # First-run harvest depth
SCROLL_DELAY_MS=2500                   # Base delay (ms) between scroll steps
MIN_DELAY_BETWEEN_ACCOUNTS_MS=300000   # 5 min
MAX_DELAY_BETWEEN_ACCOUNTS_MS=900000   # 15 min
MAX_SCROLL_ATTEMPTS=30                 # Max scroll passes before giving up on a profile

# GitHub
GITHUB_TOKEN=ghp_...                   # Personal Access Token (read:user, public_repo)
GITHUB_LOOKBACK_DAYS=8                 # How many days back to collect events
GITHUB_REPOS_PER_ACCOUNT=30            # Max repos inspected per account
GITHUB_RELEASES_PER_REPO=10            # Max releases per repo
GITHUB_COMMITS_PER_REPO=100            # Max commits per repo within the lookback window
GITHUB_COMMIT_MESSAGES_PER_BATCH=10    # Max messages stored in a commit_batch body
```

---

## MCP server — agent integration

The MCP server lets an AI agent query EANyra's database directly using structured tools. The agent never touches Twitter or GitHub — it reads from SQLite, getting clean structured data instantly.

### Setup

Add to your OpenClaw / Claude Desktop config (replace paths with absolute paths on your machine):

```json
{
  "mcpServers": {
    "eanyra": {
      "command": "node",
      "args": ["/absolute/path/to/EANyra/src/core/mcp/server.js"],
      "env": {
        "DB_PATH": "/absolute/path/to/EANyra/data/pot.sqlite"
      }
    }
  }
}
```

Restart the gateway — the agent discovers all tools automatically.

### Available tools

| Tool | Description |
|------|-------------|
| `twitter_get_recent_posts` | Latest posts, optionally filtered by account, time window, type |
| `twitter_search_posts` | Full-text search across post content |
| `twitter_get_trending_posts` | Top posts ranked by likes / retweets / views |
| `twitter_get_account_stats` | Aggregated engagement stats per account |
| `twitter_list_accounts` | All monitored accounts with last scrape time |
| `twitter_get_scraper_status` | Scraper health, last run result, data freshness |
| `context_get` | Full user context: voice, bio, platform rules, active projects. Always call before generating content. |

### Extending with new tools

To add a new tool to the same MCP server, create `src/core/mcp/tools/yourskill.js` following the pattern in `twitter.js` (export a named array, each item has `name`, `description`, `inputSchema`, `handler`), then register it in `server.js`:

```js
import { yourSkillTools } from './tools/yourskill.js';
const allTools = [...twitterTools, ...statusTools, ...contextTools, ...yourSkillTools];
```

Restart the gateway — new tools appear automatically.

---

## Authentication

### Twitter

EANyra uses a Playwright **persistent browser context** — cookies and session data are stored automatically in `data/nyra/` after the first login. No credentials are stored in code.

1. Run `npm run login`
2. A real Chrome window opens — log in manually (2FA is fine)
3. Once the feed fully loads, press `ENTER` in the terminal

The session typically lasts several weeks. Re-run `npm run login` when it expires.

### GitHub

Generate a Personal Access Token at https://github.com/settings/tokens with scopes `read:user` and `public_repo`. Add it to `.env` as `GITHUB_TOKEN`. The token is read by `app.config.js` and passed to `GithubClient` at runtime — never written to the DB.

---

## User context

User context is the information the AI agent needs to generate content that sounds like you — not generic AI output. It covers tone, platform rules, bio, and active projects.

### Design

YAML files in `src/context/` are the source of truth. They are:
- Edited by hand like a config file, not like code
- Versioned in git — changes are visible in diffs
- Never read directly by the agent

On `eanyra context sync`, `UserContextRepository` reads all YAML files and upserts them into two SQLite tables: `user_context` (flat key/value) and `projects` (one row per project). The MCP tool `context_get()` reads exclusively from the DB.

```
src/context/*.yaml  →  UserContextRepository.sync()  →  user_context + projects tables
                                                                    ↑
                                                           context_get() MCP tool
```

### YAML files

#### `voice.yaml`

Tone, style preferences, and taboos. The most important file — the agent uses this to calibrate the writing style of every post.

```yaml
tone: "Технічний але без снобізму. Практик, не теоретик."
likes:
  - "Конкретні числа (5 хвилин, 200 постів)"
  - "Behind the scenes думки"
dislikes:
  - "Корпоративні кліше"
  - 'Зайва скромність ("просто маленький проект")'
example_post: |
  Витратив 3 дні на anti-detection браузер і з'ясував що Twitter
  банить не по UA, а по canvas fingerprint...
taboo:
  - "Не публікувати непідтверджені факти як факти"
```

#### `bio.yaml`

Short and full bio per platform. Used when the agent drafts profile descriptions or intro posts.

```yaml
twitter:
  short: "Будую інструменти для медійки."
  full: null
linkedin:
  short: "..."
  full: |
    Multi-line full bio here.
```

#### `platforms.yaml`

Content rules per platform: max length, language, style, allowed formats, things to avoid, posting frequency.

```yaml
twitter:
  max_length: 280
  language: "uk"
  style: "Короткий удар. Одна думка — один твіт."
  formats:
    - "Інсайт з конкретним числом"
    - "Thread: реліз → 3-4 твіти з різних кутів"
  avoid:
    - "Твіти без конкретики"
  posting_frequency: "3-5 разів на тиждень"
```

#### `projects/<slug>.yaml`

One file per project. The `slug` field (or filename if omitted) becomes the DB key `project.<slug>`.

```yaml
slug: "eanyra"
name: "EANyra"
status: "active"          # active | paused | archived
description: |
  Multi-platform monitoring pipeline для AI-агентів.
tech_stack:
  - "Node.js (ESM)"
  - "Playwright"
  - "GitHub REST API"
content_angles:
  - "Anti-detection: canvas fingerprint, не UA"
  - "MCP як шар між агентом і даними"
posting_rules:
  - "На реліз — 3-4 пости, не всі одразу"
  - "Технічні інсайти > анонси фіч"
```

To add a new project — copy `projects/_template.yaml`, rename to `<slug>.yaml`, fill in the fields, run `eanyra context sync`.

### Implementation notes

- `UserContextRepository` handles all YAML reading and DB upserts. Used only by the CLI — never by the MCP server directly.
- `UserContext` model — table `user_context`, columns: `key` (unique string), `value` (JSON TEXT), `synced_at`.
- `Project` model — table `projects`. JSON columns stored as TEXT, deserialized automatically via Sequelize getters/setters.
- Both models are registered in `src/core/teapot/models/index.js` and created automatically by `sequelize.sync()` on first run.
- The MCP `context_get()` tool uses raw SQL via `db.js` — consistent with other MCP tools, no Sequelize dependency in the MCP process.

---

## Roadmap

### Done

#### MCP server
Read-only MCP server (`src/core/mcp/`) exposing all scraped data to AI agents via structured tools. See [MCP server — agent integration](#mcp-server--agent-integration) above.

#### CLI foundation
Commander-based CLI (`src/core/cli/index.js`) with `eanyra start`, `eanyra scrape [platform]`, and `eanyra context` commands. Binary registered in `package.json → bin`.

#### Platform module interface
Each platform under `src/platforms/<name>/` exposes `createScraper()`, `PLATFORM_ID`, `displayName`. `ScraperOrchestrator` dispatches via `account.platform` — adding a new platform requires no changes outside of the orchestrator's switch and the CLI's `VALID_PLATFORMS` array.

#### User context system
YAML files in `src/context/` synced into SQLite via `eanyra context sync`. The agent reads context via the `context_get()` MCP tool.

#### Multi-platform account management
`accounts.json` is the single source of truth for all platforms. The `platform` field on each account entry controls which scraper runs. `Account.js` carries the `platform` column (default: `'twitter'`). Platform filtering in `ScraperOrchestrator.run({ platform })` is fully implemented.

#### GitHub module
REST API-based scraper (`src/platforms/github/`) collecting releases, weekly commit batches, new repos, and README changes. `GithubEvent` model + `GithubEventRepository` with README sha tracking for change detection. Integrated into the orchestrator as `case 'github'`. CLI: `eanyra scrape github`.

---

### Next: Twitter network interception module

**Goal:** replace DOM-based tweet extraction with GraphQL response interception.

**Why:** Twitter/X is a React SPA — all post data arrives via internal GraphQL endpoints (`UserTweets`, `UserByScreenName`). Intercepting these responses gives access to exact numeric fields and data not present in the DOM at all.

**What changes and what stays the same:**
- `page.goto()` and all human-behaviour scrolling **stays** — the browser must navigate and scroll normally to trigger the GraphQL requests
- `page.on('response', ...)` listener is added alongside the scroll loop
- `TwitterScraper.js` DOM extraction becomes a **fallback** in case the interceptor yields nothing
- No new HTTP requests — the interceptor only reads data the browser already received

**Fields gained over DOM parsing:**

| Field | DOM | Network |
|-------|-----|---------|
| Like count | Parsed from "1.2K" string | Exact integer |
| Retweet count | Parsed from "1.2K" string | Exact integer |
| Bookmark count | Not available | Available |
| `conversation_id` | Not available | Available |
| `possibly_sensitive` | Not available | Available |
| Full text (>280 chars) | Sometimes truncated | Always complete |
| Media — original URL | Thumbnail src | Original upload URL |

**Planned files:**

```
src/platforms/twitter/
├── TwitterScraper.js         # Existing — becomes coordinator + DOM fallback
├── NetworkInterceptor.js     # New — registers response listener, parses GraphQL JSON
├── tweetMapper.js            # New — maps raw GraphQL shape → RawPost (shared type)
└── humanBehavior.js          # Unchanged
```

**Implementation steps:**

1. Run with `BROWSER_HEADLESS=false`, open DevTools → Network, filter by `UserTweets` — save a real response JSON to understand the shape
2. Write `NetworkInterceptor.js` — registers on `page`, collects parsed tweets into a `Map<tweet_id, RawPost>` as responses arrive
3. Write `tweetMapper.js` — pure function that converts the nested GraphQL result into the existing `RawPost` type so nothing downstream changes
4. Update `TwitterScraper.js` — instantiate interceptor before `goto()`, scroll as usual, then call `interceptor.collect()` instead of DOM extraction; fall back to DOM if the map is empty
5. Validate against DB: run both approaches on the same account and diff the results