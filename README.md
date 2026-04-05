# EANyra

Twitter/X monitoring pipeline designed primarily for AI agents.

EANyra scrapes selected accounts using Playwright, stores posts in SQLite, and exposes the data through an MCP server — so an AI agent can query posts, stats, and scraper health directly from the database without browsing Twitter itself. This eliminates token waste on live web scraping and gives the agent structured, reliable data on demand.

The pipeline is equally useful outside of AI contexts: as a data source for scripts, dashboards, or any automation that needs a local feed of Twitter activity.

---

## How it works

```
Twitter/X  ──►  EANyra Scraper  ──►  pot.sqlite
                (runs daily)               │
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
    │   │   └── ScraperOrchestrator.js  # Coordinates a full scrape run
    │   ├── scheduler/
    │   │   └── Scheduler.js            # node-cron wrapper
    │   ├── browser/
    │   │   └── Browser.js              # Playwright persistent context + anti-detection
    │   ├── teapot/                     # Database layer (kept as "teapot")
    │   │   ├── database.js             # Sequelize singleton
    │   │   ├── models/
    │   │   │   ├── index.js            # registerModels() — associations live here
    │   │   │   ├── Account.js
    │   │   │   ├── Post.js
    │   │   │   ├── ScraperRun.js
    │   │   │   ├── UserContext.js      # Key/value store for YAML context
    │   │   │   └── Project.js          # Project metadata from projects/*.yaml
    │   │   └── repositories/
    │   │       ├── AccountRepository.js
    │   │       ├── PostRepository.js
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
    │   └── twitter/
    │       ├── index.js            # Platform module interface (factory + re-exports)
    │       ├── TwitterScraper.js   # DOM-based tweet extractor
    │       └── humanBehavior.js    # Realistic mouse/scroll helpers
    ├── config/
    │   ├── app.config.js               # All configuration with documented defaults
    │   └── accounts.json               # Monitored accounts list
    └── shared/
        ├── utils.js                    # Logging, sleep, jitter, file helpers
        └── message.js                  # CLI/MCP user-facing messages
```

### Directory purposes

| Path | Purpose |
|------|---------|
| `src/context/` | YAML source of truth for user context. Edit these by hand; sync to DB via `eanyra context sync`. Versioned in git. |
| `src/core/mcp/` | MCP server exposing DB data to AI agents via typed tools. |
| `src/config/` | Environment config and exported constants. Single source of truth for all tuneable values. |
| `src/core/browser/` | Playwright persistent context management and anti-detection patches. |
| `src/platforms/twitter/` | Twitter/X extraction logic. `index.js` exposes the standard platform interface; `TwitterScraper.js` handles DOM extraction; `humanBehavior.js` handles mouse/scroll simulation. |
| `src/core/cli/` | Commander-based CLI entry point (`eanyra start`, `eanyra scrape [platform]`, `eanyra context`). |
| `src/core/orchestrator/` | Orchestrator for full scrape runs per schedule. |
| `src/core/scheduler/` | `node-cron` wrapper for scheduled execution. |
| `src/shared/` | Reusable utilities shared across the project. |
| `src/core/teapot/` | Database layer: Sequelize wrapper, model definitions, repository classes. |

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and edit paths/schedule if needed
cp .env.example .env

# 3. Log in once (opens a real Chrome window — complete login manually)
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
| `npm run login` | — | Open browser for manual login |

---

## Platform module interface

Each platform lives under `src/platforms/<n>/` and exposes a standard interface via its `index.js`:

```js
// Stable string key — used in CLI commands and DB records
export const PLATFORM_ID = 'twitter';

// Human-readable label for logs and help text
export const displayName = 'Twitter / X';

// Factory — creates a scraper instance without exposing the constructor
export function createScraper(page, postsTarget) { … }

// Re-exports of public classes and helpers
export { TwitterScraper }           from './TwitterScraper.js';
export { humanScroll, … }           from './humanBehavior.js';
```

`ScraperOrchestrator` imports platforms through this interface, so adding a new platform means dropping a new folder under `src/platforms/` with a matching `index.js` — no changes required in the orchestrator.

---

## User context

User context is the information the AI agent needs to generate content that sounds like you — not generic AI output. It covers tone, platform rules, bio, and active projects.

### Design

YAML files in `src/context/` are the source of truth. They are:
- Edited by hand like a config file, not like code
- Versioned in git — changes are visible in diffs
- Never read directly by the agent

On `eanyra context sync` (or `eanyra start`), `UserContextRepository` reads all YAML files and upserts them into two SQLite tables: `user_context` (flat key/value) and `projects` (one row per project). The MCP tool `context_get()` reads exclusively from the DB.

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

One file per project. The `slug` field (or filename if omitted) becomes the DB key `project.<slug>`. Each file contains description, tech stack, links, content angles, and posting rules.

```yaml
slug: "eanyra"
name: "EANyra"
status: "active"          # active | paused | archived
description: |
  Twitter/X monitoring pipeline для AI-агентів.
tech_stack:
  - "Node.js (ESM)"
  - "Playwright"
content_angles:
  - "Anti-detection: canvas fingerprint, не UA"
  - "MCP як шар між агентом і даними"
posting_rules:
  - "На реліз — 3-4 пости, не всі одразу"
  - "Технічні інсайти > анонси фіч"
```

To add a new project — copy `projects/_template.yaml`, rename to `<slug>.yaml`, fill in the fields, run `eanyra context sync`.

### Workflow

```bash
# Edit any YAML file, then:
eanyra context sync

# Verify what the agent will see:
eanyra context show
eanyra context show -k voice
eanyra context show -k project.eanyra
```

### Implementation notes

- `UserContextRepository` (`src/core/teapot/repositories/UserContextRepository.js`) handles all YAML reading and DB upserts. It is used only by the CLI — never by the MCP server directly.
- `UserContext` model (`src/core/teapot/models/UserContext.js`) — table `user_context`, columns: `key` (unique string), `value` (JSON TEXT), `synced_at`.
- `Project` model (`src/core/teapot/models/Project.js`) — table `projects`, columns: `slug`, `name`, `status`, `description`, `tech_stack`, `links`, `content_angles`, `posting_rules`, `synced_at`. JSON columns are stored as TEXT and deserialized automatically via Sequelize getters/setters.
- Both models are registered in `src/core/teapot/models/index.js` alongside existing models and are created automatically by `sequelize.sync()` on first run.
- The MCP `context_get()` tool (`src/core/mcp/tools/context.js`) uses raw SQL via `db.js` — consistent with other MCP tools, no Sequelize dependency in the MCP process.
- `project.*` keys in `user_context` are written as a convenience but skipped by `context_get()` — the authoritative project data comes from the `projects` table which has proper typed columns.

---

## MCP server — agent integration

The MCP server lets an AI agent query EANyra's database directly using structured tools. The agent never touches Twitter — it reads from SQLite, getting clean structured data instantly.

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

Restart the gateway — the agent discovers all tools automatically. No additional prompting or explanation needed.

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

To add a new tool to the same MCP server, create `src/core/mcp/tools/yourskill.js` following the same pattern as `twitter.js` (export a named array, each item has `name`, `description`, `inputSchema`, `handler`), then register it in `server.js`:

```js
import { yourSkillTools } from './tools/yourskill.js';
const allTools = [...twitterTools, ...statusTools, ...contextTools, ...yourSkillTools];
```

Restart the gateway — new tools appear automatically.

---

## Authentication

EANyra uses a Playwright **persistent browser context** — cookies and session data are stored automatically in `data/nyra/` after the first login. No credentials are stored in code.

1. Run `npm run login`
2. A real Chrome window opens — log in manually (2FA is fine)
3. Once the feed fully loads, press `ENTER` in the terminal

The session typically lasts several weeks. Re-run `npm run login` when it expires.

---

## Managing monitored accounts

Edit `src/config/accounts.json`:

```json
[
  { "username": "elonmusk", "display_name": "Elon Musk", "active": true },
  { "username": "sama",     "display_name": "Sam Altman", "active": true }
]
```

On every run, `AccountRepository.syncFromConfig()` upserts this list into the DB. Set `"active": false` to pause an account without deleting its posts.

---

## Scrape depth — initial harvest vs. daily top-up

The orchestrator automatically detects whether an account has been scraped before:

| Condition | Posts target | Behaviour |
|-----------|-------------|-----------|
| No posts in DB yet | `INITIAL_POSTS_PER_ACCOUNT` (default 200) | Deep scroll — collects historical posts |
| Posts already exist | `POSTS_PER_ACCOUNT` (default 20) | Shallow scroll — catches today's activity |

All posts are upserted by `tweet_id` so re-runs never create duplicates.

---

## Human-behaviour simulation

The scraper is designed to look like a person casually browsing several profiles.
All behaviour is implemented in `humanBehavior.js` and wired into `TwitterScraper.js`.

**Per-run (orchestrator level):**
- **0–3 min random "wake-up" pause** before the first account
- **5–15 min random gap** between consecutive accounts

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
| username | STRING | Normalised Twitter handle (unique) |
| display_name | STRING | Human-readable label |
| is_active | BOOLEAN | Soft toggle |
| last_scraped_at | DATE | Timestamp of last successful scrape |

### `posts`

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

### `scraper_runs`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| started_at | DATE | Run start time |
| finished_at | DATE | Run end time |
| status | ENUM | `running` / `success` / `partial` / `failed` |
| accounts_processed | INTEGER | Successfully scraped accounts |
| posts_saved | INTEGER | Newly inserted posts |
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
CRON_SCHEDULE=0 8 * * *               # When to run (UTC). Default: 08:00 daily
RUN_ON_STARTUP=false                   # Run once immediately on process start
BROWSER_HEADLESS=true                  # false to watch the browser (debug only)
POSTS_PER_ACCOUNT=20                   # Daily top-up depth
INITIAL_POSTS_PER_ACCOUNT=200          # First-run harvest depth
SCROLL_DELAY_MS=2500                   # Base delay (ms) between scroll steps; actual = value + up to 800 ms jitter
MIN_DELAY_BETWEEN_ACCOUNTS_MS=300000   # 5 min
MAX_DELAY_BETWEEN_ACCOUNTS_MS=900000   # 15 min
MAX_SCROLL_ATTEMPTS=30                 # Max scroll passes before giving up on a profile
```

---

## Roadmap

### Done

#### MCP server
Read-only MCP server (`src/core/mcp/`) exposing all scraped data to AI agents via structured tools. See [MCP server — agent integration](#mcp-server--agent-integration) above.

#### CLI foundation
Commander-based CLI (`src/core/cli/index.js`) with `eanyra start`, `eanyra scrape [platform]`, and `eanyra context` commands. Binary registered in `package.json → bin`. See [CLI](#cli) above.

#### Platform module interface
`src/platforms/twitter/index.js` exposes a stable `createScraper()` factory, `PLATFORM_ID`, `displayName`, and re-exports of all public classes. `ScraperOrchestrator` imports platforms through this interface.

#### User context system
YAML files in `src/context/` synced into SQLite via `eanyra context sync`. The agent reads context via the `context_get()` MCP tool. See [User context](#user-context) above.

---

### In progress

#### Platform filtering in orchestrator
**Status:** CLI accepts `eanyra scrape twitter` but `ScraperOrchestrator.run()` does not yet consume the `{ platform }` argument — all active accounts are scraped regardless.

**What needs to be done:**
1. `ScraperOrchestrator.run({ platform })` — add `platform` param to the signature
2. After `syncFromConfig()`, filter `accounts` by platform if a filter is provided:  
   ```js
   const accounts = (await this.accountRepo.findAllActive())
     .filter(a => !platform || a.platform === platform);
   ```
3. The `accounts` table currently has no `platform` column — add it to `Account.js` (default: `'twitter'`)
4. `AccountRepository.syncFromConfig()` must write the `platform` field when upserting from `accounts.json`
5. Add `platform` field to `accounts.json` entries (optional — defaults to `'twitter'` if absent)

**Files to touch:** `Account.js`, `AccountRepository.js`, `ScraperOrchestrator.js`, `accounts.json`

---

### Next: network interception module

**Goal:** replace DOM-based tweet extraction with GraphQL response interception.

**Why:** Twitter/X is a React SPA — all post data arrives via internal GraphQL endpoints (`UserTweets`, `UserByScreenName`). Intercepting these responses gives access to exact numeric fields, fields not present in the DOM at all, and a data path that is more stable than CSS selectors.

**What changes and what stays the same:**
- `page.goto()` and all human-behaviour scrolling **stays** — the browser must navigate and scroll normally to trigger the GraphQL requests
- `page.on('response', ...)` listener is added alongside the scroll loop
- `TwitterScraper.js` DOM extraction becomes a **fallback** in case the interceptor yields nothing
- No new HTTP requests are made by the code — the interceptor only reads data the browser already received

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