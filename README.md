# EANyra

Twitter/X monitoring pipeline designed primarily for AI agents.

EANyra scrapes selected accounts using Playwright, stores posts in SQLite, and exposes the data through an MCP server — so an AI agent can query posts, stats, and scraper health directly from the database without browsing Twitter itself. This eliminates token waste on live web scraping and gives the agent structured, reliable data on demand.

The pipeline is equally useful outside of AI contexts: as a data source for scripts, dashboards, or any automation that needs a local feed of Twitter activity.

---

## How it works

```
Twitter/X  ──►  EANyra Scraper  ──►  pot.sqlite
                (runs daily)
                                          │
                                   MCP Server
                              (src/mcp/server.js)
                                          │
                                   AI Agent
                             (OpenClaw / Claude Desktop)
```

The scraper runs on a schedule and keeps the database fresh. The MCP server is a lightweight read-only layer on top — it exposes typed tools that the agent calls directly, with no browser, no live scraping, and no wasted tokens.

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
    ├── index.js                # Entry point — daemon or single-run mode
    ├── config/
    │   ├── app.config.js       # All configuration with documented defaults
    │   └── accounts.json       # Monitored accounts list
    ├── mcp/                    # MCP server — agent interface
    │   ├── server.js           # Entry point, tool registration
    │   ├── db.js               # Read-only SQLite query layer
    │   └── tools/
    │       ├── twitter.js      # Post/account query tools
    │       └── status.js       # Scraper health tool
    ├── module/
    │   ├── browser/
    │   │   └── Browser.js      # Playwright persistent context + anti-detection
    │   ├── scraper/
    │   │   ├── TwitterScraper.js   # DOM-based tweet extractor
    │   │   └── humanBehavior.js    # Realistic mouse/scroll helpers
    │   ├── orchestrator/
    │   │   └── ScraperOrchestrator.js  # Coordinates a full scrape run
    │   └── scheduler/
    │       └── Scheduler.js    # node-cron wrapper
    ├── shared/
    │   └── utils.js            # Logging, sleep, jitter, file helpers
    └── teapot/
        ├── database.js         # Sequelize singleton
        ├── models/
        │   ├── index.js        # registerModels() — associations live here
        │   ├── Account.js
        │   ├── Post.js
        │   └── ScraperRun.js
        └── repositories/
            ├── AccountRepository.js    # accounts.json sync + DB queries
            ├── PostRepository.js       # Batch upsert, oldest-post lookup
            └── ScraperRunRepository.js # Run lifecycle (start/finish/fail)
```

### Directory purposes

| Path | Purpose |
|------|---------|
| `src/mcp/` | MCP server exposing DB data to AI agents via typed tools. |
| `src/config/` | Environment config and exported constants. Single source of truth for all tuneable values. |
| `src/module/browser/` | Playwright context management and anti-detection patches. |
| `src/module/scraper/` | Tweet extraction and human-behaviour simulation. |
| `src/module/orchestrator/` | Coordinates browser, scraper, and repositories for a full run. |
| `src/module/scheduler/` | Cron-based daemon scheduling. |
| `src/shared/` | Reusable utilities shared across the project. |
| `src/teapot/` | Database layer: Sequelize wrapper, model definitions, repository classes. |

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

# 5. Start the daily daemon
npm start
```

---

## MCP server — agent integration

The MCP server lets an AI agent query EANyra's database directly using structured tools. The agent never touches Twitter — it reads from SQLite, getting clean structured data instantly.

### Setup

```bash
# Install MCP dependencies (one-time)
npm install @modelcontextprotocol/sdk zod
```

Add to your OpenClaw / Claude Desktop config (replace paths with absolute paths on your machine):

```json
{
  "mcpServers": {
    "eanyra": {
      "command": "node",
      "args": ["/absolute/path/to/EANyra/src/mcp/server.js"],
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

### Extending with new skills

To add a new skill to the same MCP server, create `src/mcp/tools/yourskill.js` following the same pattern as `twitter.js`, then register it in `server.js`:

```js
import { yourSkillTools } from './tools/yourskill.js';
const allTools = [...twitterTools, ...statusTools, ...yourSkillTools];
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

### Done: MCP server

Read-only MCP server (`src/mcp/`) exposing all scraped data to AI agents via structured tools. See [MCP server — agent integration](#mcp-server--agent-integration) above.

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
src/module/scraper/
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