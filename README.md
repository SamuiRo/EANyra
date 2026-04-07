# EANyra

Multi-platform social media monitoring pipeline designed primarily for AI agents.

EANyra collects activity across platforms — Twitter/X via Playwright, GitHub via REST API, LinkedIn via CSV import — stores everything in SQLite, and exposes it through an MCP server. An AI agent can query posts, GitHub activity, stats, and scraper health directly from the database without touching the live platforms. This eliminates token waste on live scraping and gives the agent structured, reliable data on demand.

The pipeline is equally useful outside of AI contexts: as a data source for scripts, dashboards, or any automation that needs a local feed of social/code activity.

---

## How it works

```
Twitter/X  ──►  TwitterScraper (Playwright)         ──►  posts
GitHub     ──►  GithubScraper (REST API)             ──►  github_events    ──►  pot.sqlite
LinkedIn   ──►  LinkedinImporter (CSV from disk)     ──►  linkedin_posts         │
                                                                            MCP Server
                                                                       (src/core/mcp/server.js)
                                                                                   │
                                                                            AI Agent
                                                                      (OpenClaw / Claude Desktop)

src/context/*.yaml  ──►  eanyra context sync  ──►  pot.sqlite
  (edited by hand)                                       │
                                                  context_get() (MCP tool)
```

Each platform has a different collection mechanism but the same downstream contract — all data ends up in SQLite and is queryable via MCP tools. The MCP server is a read-only layer that exposes typed tools; the agent never touches live platforms.

User context (voice, bio, platform rules, projects) lives in YAML files and is synced into the DB on demand. The agent always reads context from the DB — never from files directly.

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
│   ├── imports/                # LinkedIn CSV exports go here (Shares.csv, Profile.csv)
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
    │   │   │   ├── LinkedinPost.js     # LinkedIn posts imported from CSV
    │   │   │   ├── ScraperRun.js
    │   │   │   ├── UserContext.js      # Key/value store for YAML context
    │   │   │   └── Project.js          # Project metadata from projects/*.yaml
    │   │   └── repositories/
    │   │       ├── AccountRepository.js
    │   │       ├── PostRepository.js
    │   │       ├── GithubEventRepository.js
    │   │       ├── LinkedinPostRepository.js
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
    │   ├── github/
    │   │   ├── index.js            # Platform module interface (factory + re-exports)
    │   │   ├── GithubScraper.js    # Activity collector (REST API, no browser)
    │   │   └── client.js           # GitHub REST API v3 wrapper
    │   └── linkedin/
    │       ├── index.js            # Platform module interface (factory + re-exports)
    │       ├── LinkedinImporter.js # Reads CSVs from data/imports/, returns RawLinkedinPost[]
    │       └── csvParser.js        # Pure CSV parser for Shares.csv and Profile.csv
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
| `data/imports/` | Drop LinkedIn CSV exports here before running `eanyra scrape linkedin`. Gitignored. |
| `src/context/` | YAML source of truth for user context. Edit by hand; sync to DB via `eanyra context sync`. Versioned in git. |
| `src/core/mcp/` | MCP server exposing DB data to AI agents via typed tools. |
| `src/config/` | Environment config and exported constants. Single source of truth for all tuneable values. |
| `src/core/browser/` | Playwright persistent context management and anti-detection patches. Only used by Twitter. |
| `src/platforms/twitter/` | Twitter/X extraction via Playwright DOM scraping. |
| `src/platforms/github/` | GitHub activity collection via REST API. No browser required. |
| `src/platforms/linkedin/` | LinkedIn CSV import. No network calls — reads files from `data/imports/`. |
| `src/core/orchestrator/` | Reads all active accounts, filters by platform, dispatches to the right scraper. |
| `src/core/scheduler/` | `node-cron` wrapper for scheduled execution. |
| `src/shared/` | Reusable utilities shared across the project. |
| `src/core/teapot/` | Database layer: Sequelize wrapper, model definitions, repository classes. |

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in credentials
cp .env.example .env
# Required: GITHUB_TOKEN (for GitHub)
# Twitter: run npm run login after this step

# 3. Twitter only: log in once (opens a real Chrome window — complete login manually)
npm run login

# 4. Add accounts to src/config/accounts.json (see "Account management" below)

# 5. LinkedIn only: drop CSV exports into data/imports/ (see "LinkedIn module" below)

# 6. Run a single scrape to verify everything works
npm run scrape

# 7. Sync user context into the database
eanyra context sync

# 8. Start the daily daemon
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

# Scrape only Twitter/X
eanyra scrape twitter

# Scrape only GitHub
eanyra scrape github

# Import LinkedIn CSVs from data/imports/
eanyra scrape linkedin

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

## Account management

All monitored accounts live in `src/config/accounts.json`, regardless of platform. The `platform` field controls which scraper runs for each account. Omitting `platform` defaults to `'twitter'`.

```json
[
  { "username": "elonmusk",        "display_name": "Elon Musk",        "platform": "twitter",  "active": true },
  { "username": "torvalds",        "display_name": "Linus Torvalds",   "platform": "github",   "active": true },
  { "username": "your-li-handle",  "display_name": "Your Name",        "platform": "linkedin", "active": true }
]
```

For LinkedIn, `username` is a free-form identifier you choose — it's used to group records in the DB and doesn't need to match your actual LinkedIn URL slug. All posts imported from CSV will be attributed to this account.

On every run, `AccountRepository.syncFromConfig()` upserts this list into the `accounts` table. Set `"active": false` to pause an account without deleting its data.

---

## Twitter module

### Setup

1. Run `npm run login` — a real Chrome window opens, log in manually (2FA is fine)
2. Once the feed fully loads, press `ENTER` in the terminal
3. Add Twitter accounts to `accounts.json` with `"platform": "twitter"` (or no platform field — default is twitter)
4. Run `eanyra scrape twitter` to verify

The Playwright session (cookies, local storage) is stored in `data/nyra/` and reused on every run. Sessions typically last several weeks — re-run `npm run login` when expired.

### Scrape depth

The orchestrator automatically detects whether an account has been scraped before:

| Condition | Posts target | Behaviour |
|-----------|-------------|-----------|
| No posts in DB yet | `INITIAL_POSTS_PER_ACCOUNT` (default 200) | Deep scroll — collects historical posts |
| Posts already exist | `POSTS_PER_ACCOUNT` (default 20) | Shallow scroll — catches recent activity |

All posts are deduplicated by `tweet_id` — re-runs never create duplicates.

### Configurable parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTS_PER_ACCOUNT` | `20` | Daily top-up depth |
| `INITIAL_POSTS_PER_ACCOUNT` | `200` | First-run harvest depth |
| `SCROLL_DELAY_MS` | `2500` | Base delay (ms) between scroll steps |
| `MIN_DELAY_BETWEEN_ACCOUNTS_MS` | `300000` | Min pause between accounts (5 min) |
| `MAX_DELAY_BETWEEN_ACCOUNTS_MS` | `900000` | Max pause between accounts (15 min) |
| `MAX_SCROLL_ATTEMPTS` | `30` | Max scroll passes before giving up |

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

All events are stored in the `github_events` table, deduplicated by `event_id`. Format: `<type>:<owner>/<repo>:<detail>` — e.g. `commit_batch:torvalds/linux:2025-W03`.

README change detection works by storing the last known README sha from each `readme_change` event and comparing it on the next run. No sha stored = first time seen = no event emitted (avoids false positives on first scrape).

### Configurable parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | Personal Access Token (required) |
| `GITHUB_LOOKBACK_DAYS` | `8` | How many days back to look for events |
| `GITHUB_REPOS_PER_ACCOUNT` | `30` | Max repos inspected per account (sorted by push date) |
| `GITHUB_RELEASES_PER_REPO` | `10` | Max releases fetched per repo |
| `GITHUB_COMMITS_PER_REPO` | `100` | Max commits fetched per repo within the lookback window |
| `GITHUB_COMMIT_MESSAGES_PER_BATCH` | `10` | Max commit messages stored in a `commit_batch` body |

GitHub allows 5 000 requests/hour with a PAT. For typical usage (10–20 accounts, daily runs) this limit is not a concern.

---

## LinkedIn module

LinkedIn's API is heavily restricted, so this module works with **CSV exports** from your LinkedIn account. You export manually, drop the files into `data/imports/`, and run the import command. On subsequent runs only new posts (not yet in the DB) are inserted — re-importing the same CSV is safe.

### Setup

1. Export your data from LinkedIn:
   - Go to **linkedin.com → Me → Settings & Privacy → Data Privacy → Get a copy of your data**
   - Select **Posts** (and optionally **Profile**)
   - LinkedIn emails a download link — usually within 10 minutes
   - Unzip and place the files into `data/imports/`

2. The expected filenames (configurable via `.env`):
   ```
   data/imports/Shares.csv    ← posts
   data/imports/Profile.csv   ← profile metadata (optional)
   ```

3. Add yourself to `accounts.json`:
   ```json
   { "username": "your-name", "display_name": "Your Name", "platform": "linkedin", "active": true }
   ```
   The `username` here is a free-form identifier you choose — it groups records in the DB and does not need to match your LinkedIn URL.

4. Run the import:
   ```bash
   eanyra scrape linkedin
   ```

### What gets imported

From `Shares.csv` (LinkedIn's posts export):

| Field | Source column | Description |
|-------|--------------|-------------|
| `post_id` | `ShareLink` (URN extracted) | Unique identifier — prevents duplicate imports |
| `text` | `ShareCommentary` | Full post text including newlines |
| `posted_at` | `Date` | Publication timestamp (UTC) |
| `shared_url` | `SharedUrl` | External URL shared in the post, if any |
| `media_url` | `MediaUrl` | Attached media URL, if any |
| `visibility` | `Visibility` | e.g. `MEMBER_NETWORK` |
| `raw_url` | `ShareLink` | Direct URL to the post on LinkedIn |

`Profile.csv` is parsed and logged but not persisted to the DB at this stage — it serves as a reference and future hook for profile sync.

### Re-importing

Every import is idempotent. `post_id` has a unique constraint — rows already in the DB are silently skipped. You can drop a new export into `data/imports/` at any time and re-run `eanyra scrape linkedin`; only new posts will be inserted.

### Configurable parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `LINKEDIN_IMPORTS_DIR` | `data/imports/` | Path to the folder containing CSV exports |
| `LINKEDIN_SHARES_FILE` | `Shares.csv` | Filename of the posts export |
| `LINKEDIN_PROFILE_FILE` | `Profile.csv` | Filename of the profile export |

---

## Platform module interface

Each platform lives under `src/platforms/<n>/` and exposes a standard interface via its `index.js`:

```js
// Stable string key — used in CLI commands and DB records
export const PLATFORM_ID = 'linkedin'; // 'twitter' | 'github' | 'linkedin'

// Human-readable label for logs
export const displayName = 'LinkedIn';

// Factory — creates a scraper/importer instance
export function createScraper(...args) { … }
```

`ScraperOrchestrator` dispatches via a `switch` on `account.platform`. Adding a new platform means:
1. Create `src/platforms/<n>/index.js` with `createScraper()` + `PLATFORM_ID`
2. Add a `case` in `ScraperOrchestrator.#scrapeAccount()`
3. Add the platform string to `VALID_PLATFORMS` in `cli/index.js`

---

## Human-behaviour simulation (Twitter only)

The Twitter scraper is designed to look like a person casually browsing several profiles. GitHub and LinkedIn have no bot detection concerns — no delays are applied to them.

**Per-run (orchestrator level):**
- **0–3 min random "wake-up" pause** before the first Twitter account
- **5–15 min random gap** between consecutive Twitter accounts

**Per-account (scraper level):**
- **`simulatePageLanding()`** — called once after the first tweet appears: moves the mouse from the top-left corner, pauses 2–5 s as if reading the profile header, performs a small initial scroll
- **Bézier-curve mouse movement** before each scroll step
- **Reading pause** of 1.5–4 s before every scroll step
- **±15–35% jitter** on scroll distance
- **~15% chance** of a small upward correction scroll (humans overshoot)

---

## Anti-detection (Browser.js)

Beyond human behaviour, the browser context patches several fingerprint vectors used by Twitter:

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
| username | STRING | Account handle (unique across all platforms) |
| display_name | STRING | Human-readable label |
| platform | STRING | `'twitter'` / `'github'` / `'linkedin'` (default: `'twitter'`) |
| is_active | BOOLEAN | Soft toggle — set false to pause without deleting data |
| last_scraped_at | DATE | Timestamp of last successful scrape/import |

### `posts` (Twitter)

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| tweet_id | STRING | Twitter's own ID (unique) |
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

### `linkedin_posts` (LinkedIn)

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| post_id | STRING | Numeric ID extracted from post URN (unique) |
| account_id | INTEGER | FK → accounts |
| username | STRING | LinkedIn handle (from accounts.json) |
| text | TEXT | Full post commentary |
| shared_url | STRING | External URL shared in the post, if any |
| media_url | STRING | Attached media URL, if any |
| visibility | STRING | e.g. `MEMBER_NETWORK` |
| posted_at | DATE | Publication timestamp |
| raw_url | STRING | Direct URL to the post on LinkedIn |
| scraped_at | DATE | When this record was imported |

`post_id` is extracted from the ShareLink URN: `urn:li:share:7399399426819026944` → `7399399426819026944`. Both `urn:li:share:` and `urn:li:ugcPost:` formats are handled.

### `github_events` (GitHub)

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| event_id | STRING(256) | Stable unique key — format: `<type>:<owner>/<repo>:<detail>` |
| account_id | INTEGER | FK → accounts |
| username | STRING | GitHub login |
| repo | STRING | Repository name (short, no owner prefix) |
| event_type | ENUM | `release` / `commit_batch` / `new_repo` / `readme_change` |
| title | STRING | Human-readable summary |
| body | TEXT | Release notes, commit messages, etc. |
| url | STRING | Direct link to the event on GitHub |
| occurred_at | DATE | When the event happened |
| metadata | TEXT | JSON — event-type-specific extras (tag, sha, week, count…) |
| scraped_at | DATE | When this record was captured |

### `scraper_runs`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| started_at | DATE | Run start time |
| finished_at | DATE | Run end time |
| status | ENUM | `running` / `success` / `partial` / `failed` |
| accounts_processed | INTEGER | Successfully scraped/imported accounts |
| posts_saved | INTEGER | Newly inserted records (all platforms combined) |
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

All variables are read in `src/config/app.config.js`. See `.env.example` for the full list.

```env
# Scheduling
CRON_SCHEDULE=0 8 * * *               # When to run (UTC). Default: 08:00 daily
RUN_ON_STARTUP=false                   # Run once immediately on process start

# Twitter / Browser
BROWSER_HEADLESS=true                  # false to watch the browser (debug only)
POSTS_PER_ACCOUNT=20                   # Daily top-up depth
INITIAL_POSTS_PER_ACCOUNT=200          # First-run harvest depth
SCROLL_DELAY_MS=2500                   # Base delay (ms) between scroll steps
MIN_DELAY_BETWEEN_ACCOUNTS_MS=300000   # 5 min pause between accounts
MAX_DELAY_BETWEEN_ACCOUNTS_MS=900000   # 15 min max pause between accounts
MAX_SCROLL_ATTEMPTS=30                 # Max scroll passes before giving up

# GitHub
GITHUB_TOKEN=ghp_...                   # Personal Access Token (read:user, public_repo)
GITHUB_LOOKBACK_DAYS=8                 # How many days back to collect events
GITHUB_REPOS_PER_ACCOUNT=30            # Max repos inspected per account
GITHUB_RELEASES_PER_REPO=10            # Max releases per repo
GITHUB_COMMITS_PER_REPO=100            # Max commits per repo within the lookback window
GITHUB_COMMIT_MESSAGES_PER_BATCH=10    # Max messages stored in a commit_batch body

# LinkedIn
LINKEDIN_IMPORTS_DIR=data/imports      # Path to CSV exports folder
LINKEDIN_SHARES_FILE=Shares.csv        # Posts export filename
LINKEDIN_PROFILE_FILE=Profile.csv      # Profile export filename (optional)
```

---

## MCP server — agent integration

The MCP server lets an AI agent query EANyra's database directly using structured tools. The agent never touches live platforms — it reads from SQLite, getting clean structured data instantly.

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

Create `src/core/mcp/tools/yourskill.js` following the pattern in `twitter.js` (export a named array, each item has `name`, `description`, `inputSchema`, `handler`), then register it in `server.js`:

```js
import { yourSkillTools } from './tools/yourskill.js';
const allTools = [...twitterTools, ...statusTools, ...contextTools, ...yourSkillTools];
```

Restart the gateway — new tools appear automatically.

---

## User context

User context is the information the AI agent needs to generate content that sounds like you — not generic AI output. It covers tone, platform rules, bio, and active projects.

YAML files in `src/context/` are the source of truth. They are edited by hand, versioned in git, and never read directly by the agent. On `eanyra context sync`, `UserContextRepository` reads all YAML files and upserts them into two SQLite tables: `user_context` (flat key/value) and `projects` (one row per project).

```
src/context/*.yaml  →  eanyra context sync  →  user_context + projects tables
                                                          ↑
                                                 context_get() MCP tool
```

### YAML files

**`voice.yaml`** — tone, style preferences, taboos. The most important file — the agent uses this to calibrate writing style.

```yaml
tone: "Технічний але без снобізму. Практик, не теоретик."
likes:
  - "Конкретні числа (5 хвилин, 200 постів)"
  - "Behind the scenes думки"
dislikes:
  - "Корпоративні кліше"
taboo:
  - "Не публікувати непідтверджені факти як факти"
```

**`bio.yaml`** — short and full bio per platform.

```yaml
twitter:
  short: "Будую інструменти для медійки."
linkedin:
  short: "Full-Stack Engineer. Building tools for media."
  full: |
    Multi-line full bio here.
```

**`platforms.yaml`** — content rules per platform: max length, language, style, formats, posting frequency.

```yaml
twitter:
  max_length: 280
  language: "uk"
  style: "Короткий удар. Одна думка — один твіт."
linkedin:
  max_length: 3000
  language: "en"
  style: "Professional but personal. Show the work, not just the result."
```

**`projects/<slug>.yaml`** — one file per project. The `slug` field becomes the DB key `project.<slug>`.

```yaml
slug: "eanyra"
name: "EANyra"
status: "active"
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

To add a new project: copy `projects/_template.yaml`, rename to `<slug>.yaml`, fill in the fields, run `eanyra context sync`.

---

## Roadmap

### Done

**MCP server** — read-only MCP server (`src/core/mcp/`) exposing all scraped data to AI agents.

**CLI foundation** — Commander-based CLI with `eanyra start`, `eanyra scrape [platform]`, `eanyra context`. Binary in `package.json → bin`.

**Platform module interface** — each platform under `src/platforms/<n>/` exposes `createScraper()`, `PLATFORM_ID`, `displayName`. Orchestrator dispatches via `account.platform` switch — adding a platform touches only the switch and `VALID_PLATFORMS`.

**User context system** — YAML files in `src/context/` synced into SQLite. Agent reads context via `context_get()` MCP tool.

**Multi-platform account management** — `accounts.json` is the single source of truth. `platform` field routes each account to the correct scraper. `Account.js` carries the `platform` column (default: `'twitter'`).

**GitHub module** — REST API scraper collecting releases, weekly commit batches, new repos, README changes. `GithubEvent` model + `GithubEventRepository`. CLI: `eanyra scrape github`.

**LinkedIn module** — CSV import from `data/imports/`. Dependency-free CSV parser handles LinkedIn's quoted multiline format. `LinkedinPost` model + `LinkedinPostRepository`. Idempotent — safe to re-import same CSV. CLI: `eanyra scrape linkedin`.

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