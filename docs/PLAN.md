# EANyra — Project Plan

> **Purpose of this document**
> Single source of truth for the project's architecture, module contracts, refactoring tasks, and quality improvement process.
> Intended for two audiences: the developer working on the codebase, and an AI assistant receiving this file as context.
>
> **For AI:** Read this document top to bottom before any task. Section "Module contracts" describes exactly what each component does and what it must produce. Section "Export quality" describes how to evaluate and improve output. Section "Refactoring tasks" is the active task list.

---

## Table of contents

1. [What EANyra is](#1-what-eanyra-is)
2. [How to run the project](#2-how-to-run-the-project)
3. [Architecture overview](#3-architecture-overview)
4. [Module contracts](#4-module-contracts)
   - 4.1 [Database — unified schema](#41-database--unified-schema)
   - 4.2 [Scrapers](#42-scrapers)
   - 4.3 [UserContext system](#43-usercontext-system)
   - 4.4 [Export system](#44-export-system)
   - 4.5 [MCP server](#45-mcp-server)
5. [Export quality — how to evaluate and improve](#5-export-quality--how-to-evaluate-and-improve)
6. [Documentation structure](#6-documentation-structure)
7. [Refactoring tasks](#7-refactoring-tasks)
8. [Roadmap](#8-roadmap)

---

## 1. What EANyra is

EANyra is a personal media pipeline for a solo developer. It solves one problem: **maintaining a public presence when you have almost no time for it.**

The system does three things:

**Collects** what you publish (Twitter, LinkedIn) and what you build (GitHub). Stores everything locally in SQLite.

**Exports** a structured snapshot — your recent posts, your style, your active projects, and new content signals — into a single Markdown file that an AI can read.

**Exposes** all data through an MCP server so an AI agent in Claude Desktop or similar can query it with structured tools, without touching live platforms.

The AI's job: read the export, understand your voice and context, suggest what to post next and in what form.

---

## 2. How to run the project

The project is used primarily through `npm run` scripts, not the `eanyra` binary directly.

```bash
# Install
npm install

# Twitter: one-time manual login (opens real Chrome)
npm run login

# Scrape all platforms
npm run scrape

# Scrape a single platform
npm run scrape:twitter
# eanyra scrape github     (no npm alias yet)
# eanyra scrape linkedin   (no npm alias yet)

# Sync your YAML context files into the DB
eanyra context sync

# Check what the agent sees
eanyra context show
eanyra context show -k voice
eanyra context show -k project.eanyra

# Export — generate the AI-ready Markdown file
npm run nyra export                         # all sections, last 7 days
npm run nyra export -- --days 14            # last 14 days
npm run nyra export -- --sections twitter,github
npm run nyra export -- --unused-only        # only posts not yet exported
npm run nyra export -- --no-mark            # don't stamp used_for_content (dry run)
npm run nyra export -- --out ./my.md        # custom output path

# Start the daily cron daemon
npm start
```

### npm scripts reference

| Script | What it does |
|--------|-------------|
| `npm start` | Start cron daemon (runs scrape daily at 08:00 UTC) |
| `npm run dev` | Daemon with auto-restart on file change |
| `npm run scrape` | Single scrape, all platforms, then exit |
| `npm run scrape:twitter` | Single scrape, Twitter only |
| `npm run login` | Open browser for manual Twitter login |
| `npm run export` | Generate export file (passes args through with `--`) |

---

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Data collection                                        │
│                                                         │
│  Twitter/X  →  TwitterScraper (Playwright)              │
│  GitHub     →  GithubScraper  (REST API)                │
│  LinkedIn   →  LinkedinImporter (CSV from disk)         │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Database  (data/pot.sqlite)                            │
│                                                         │
│  posts          — everything you published              │
│  signals        — material for future posts (GitHub)    │
│  user_context   — your voice, bio, platform rules       │
│  projects       — active project metadata               │
│  accounts       — monitored accounts                    │
│  scraper_runs   — health log                            │
└──────────┬──────────────────────────┬───────────────────┘
           │                          │
           ▼                          ▼
┌─────────────────┐       ┌───────────────────────────────┐
│  Export system  │       │  MCP server                   │
│                 │       │                               │
│  eanyra export  │       │  posts_get · signals_get       │
│       ↓         │       │  context_get · export_get      │
│  data/exports/  │       │  signals_mark_used            │
│  export-DATE.md │       └──────────────┬────────────────┘
└────────┬────────┘                      │
         │                              ▼
         └──────────────►  AI Agent (Claude Desktop / OpenClaw)
```

Data flows one way: scrapers write, MCP and export read. The agent never touches live platforms.

---

## 4. Module contracts

This section defines what each module must do, what it produces, and what guarantees it makes. Use this as the specification when writing or reviewing code.

---

### 4.1 Database — unified schema

**Goal:** two tables for content (`posts`, `signals`), not one per platform.

#### `posts` — everything you published

Stores all content you have already published, regardless of platform.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK |
| platform | STRING | `twitter` / `linkedin` / `telegram` |
| external_id | STRING | Platform's own ID. Unique per platform. |
| account_id | INTEGER | FK → accounts |
| content | TEXT | Full post text |
| lang | STRING | `uk` / `en` / … |
| published_at | DATE | Original publication timestamp |
| likes | INTEGER | At time of scrape/import |
| reposts | INTEGER | |
| views | INTEGER | |
| comments | INTEGER | |
| is_retweet | BOOLEAN | Twitter only, default false |
| is_reply | BOOLEAN | Twitter only, default false |
| media_urls | TEXT | JSON array |
| raw_url | STRING | Direct link to the post |
| used_for_export | BOOLEAN | Has this post appeared in an export file |
| exported_at | DATE | When it was last exported |
| scraped_at | DATE | When this record was captured |
| raw_json | TEXT | Full original payload for debugging |

Unique constraint: `(platform, external_id)`.

**What migrates here:**
- `Post` (Twitter) → `platform='twitter'`, `external_id=tweet_id`, `content=text`
- `LinkedinPost` → `platform='linkedin'`, `external_id=post_id`, `content=text`

#### `signals` — material for future posts

Stores events and facts that are potential prompts for new posts. Currently populated by GitHub scraper only, but designed to be source-agnostic.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER | PK |
| source | STRING | `github` / `manual` / `rss` (future) |
| signal_type | STRING | `release` / `commit_batch` / `new_repo` / `readme_change` / `manual` |
| account_id | INTEGER | FK → accounts |
| title | STRING | One-line summary |
| body | TEXT | Release notes, commit messages, full detail |
| url | STRING | Link to the event on GitHub or elsewhere |
| event_at | DATE | When the event happened |
| metadata_json | TEXT | Source-specific extras (tag, sha, week, commit count…) |
| used_for_content | BOOLEAN | Has this signal been used to generate a post |
| used_at | DATE | When it was marked used |
| scraped_at | DATE | When this record was captured |

Unique constraint: event_id (kept internally as `source:type:detail`).

**What migrates here:** all rows from `github_events`.

#### Other tables

`accounts`, `scraper_runs`, `user_context`, `projects` — unchanged from current schema.

---

### 4.2 Scrapers

Each scraper has one job: collect data from its source and write it to the unified schema. No scraper reads from the DB except to check for existing records (deduplication).

#### Twitter scraper (`src/platforms/twitter/`)

**Input:** list of active Twitter accounts from `accounts.json`
**Output:** new rows in `posts` with `platform='twitter'`

Rules:
- Collect only original posts (exclude retweets and replies by default; store the flag, let export filter)
- Deduplicate by `(platform, external_id)` — re-running is always safe
- First run: collect up to `INITIAL_POSTS_PER_ACCOUNT` posts (default 200)
- Subsequent runs: collect up to `POSTS_PER_ACCOUNT` posts (default 20)
- Fields required: `content`, `published_at`, `external_id`, `likes`, `reposts`, `views`
- Fields optional: `lang`, `media_urls`, `raw_url`

Planned: network interception replaces DOM parsing. DOM parsing becomes fallback. No contract change — output schema stays the same.

#### GitHub scraper (`src/platforms/github/`)

**Input:** list of active GitHub accounts from `accounts.json` + `GITHUB_TOKEN`
**Output:** new rows in `signals`

Signal types and what they produce:

| `signal_type` | `title` | `body` | `metadata_json` |
|---------------|---------|--------|-----------------|
| `release` | "Released v2.1.0 — eanyra" | Full release notes from GitHub | `{ tag, repo, draft: false }` |
| `commit_batch` | "12 commits to eanyra (week 2025-W03)" | Up to 10 commit messages | `{ week, count, repo }` |
| `new_repo` | "New repo: tool-name" | README first paragraph if available | `{ repo, visibility }` |
| `readme_change` | "README updated — eanyra" | Diff summary or empty | `{ repo, old_sha, new_sha }` |

Rules:
- Deduplicate by internal event_id: `<source>:<type>:<owner>/<repo>:<detail>`
- `used_for_content` defaults to `false` on insert
- `event_at` is the GitHub event timestamp, not `scraped_at`

#### LinkedIn importer (`src/platforms/linkedin/`)

**Input:** `data/imports/Shares.csv`
**Output:** new rows in `posts` with `platform='linkedin'`

Rules:
- Read `Shares.csv` from `data/imports/`
- Map `ShareCommentary` → `content`, `Date` → `published_at`, `ShareLink` → `raw_url` and `external_id`
- Deduplicate by `(platform, external_id)`
- Re-importing same CSV is safe — already-existing rows are silently skipped
- `Profile.csv` is parsed but not persisted (reserved for future use)

---

### 4.3 UserContext system

UserContext is the information an AI needs to write content that sounds like you — not generic.

#### Source of truth: YAML files in `src/context/`

```
src/context/
  voice.yaml          ← tone, style, what you like, what you avoid, taboos
  bio.yaml            ← short and full bio per platform
  platforms.yaml      ← rules per platform: max length, language, style, posting frequency
  projects/
    <slug>.yaml       ← one file per project
    _template.yaml    ← copy this to add a new project
```

These files are edited by hand and versioned in git. The agent never reads them directly.

#### Sync: YAML → SQLite

```bash
eanyra context sync
```

`UserContextRepository` reads all YAML files and upserts into two tables:
- `user_context` (key-value): keys are `voice`, `bio`, `platforms`, `project.<slug>`
- `projects` (one row per project): parsed from `projects/*.yaml`

Run this after editing any YAML file.

#### What goes in each YAML file

**`voice.yaml`** — the most important file. Defines how posts sound.

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

**`bio.yaml`** — bio per platform. AI uses this for profile references and post introductions.

```yaml
twitter:
  short: "Будую інструменти для медійки."
linkedin:
  short: "Full-Stack Engineer. Building tools for media."
  full: |
    Multi-line full bio here.
```

**`platforms.yaml`** — posting rules per platform. AI must follow these when generating content.

```yaml
twitter:
  max_length: 280
  language: "uk"
  style: "Короткий удар. Одна думка — один твіт."
  posting_frequency: "3+ times per week"
linkedin:
  max_length: 3000
  language: "en"
  style: "Professional but personal. Show the work, not just the result."
  posting_frequency: "1-2 times per week"
```

**`projects/<slug>.yaml`** — one file per project.

```yaml
slug: "eanyra"
name: "EANyra"
status: "active"          # active | paused | archived
description: |
  Multi-platform monitoring pipeline for AI agents.
tech_stack:
  - "Node.js (ESM)"
  - "Playwright"
  - "GitHub REST API"
content_angles:
  - "Anti-detection: canvas fingerprint, not UA"
  - "MCP as a layer between agent and data"
posting_rules:
  - "On release — 3-4 posts, not all at once"
  - "Technical insights > feature announcements"
links:
  github: "https://github.com/you/eanyra"
```

To add a new project: copy `_template.yaml`, rename to `<slug>.yaml`, fill in, run `eanyra context sync`.

---

### 4.4 Export system

The export system produces a single Markdown file that gives an AI full context for a content creation session — without MCP, without database access, without any setup.

#### Entry point

```bash
npm run export [-- options]
```

Implemented in `src/core/cli/exportCommands.js` and `src/core/export/MarkdownExporter.js`.

#### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--days <n>` | `7` | How many days back to pull posts |
| `--sections <list>` | all | Comma-separated: `context,projects,twitter,linkedin,github` |
| `--unused-only` | false | Only include posts not yet exported |
| `--no-mark` | false (mark is on) | Do not stamp `used_for_export=true` — use for dry runs or extra context |
| `--out <path>` | `data/exports/export-YYYY-MM-DD.md` | Custom output path |

#### What the export file contains

The output is a structured Markdown file with these sections in order:

**1. Header** — generation timestamp, date range, sections included.

**2. Voice & Style** — full contents of `voice.yaml`. AI uses this for tone calibration on every post it writes.

**3. Bio** — contents of `bio.yaml`. AI uses this when posts reference who you are.

**4. Platform Rules** — contents of `platforms.yaml`. AI must follow these constraints: language, length, style per platform.

**5. Active Projects** — all projects with `status: active` from `projects/*.yaml`. Full content: description, tech stack, content angles, posting rules, links. Paused/archived projects: name and status only.

**6. Recent Posts** — sample of your posts per platform. Selection strategy (see Section 5 for quality rules):
- Last N original posts per platform (not retweets, not replies)
- Top N by engagement (likes + reposts)
- Posts are labelled with platform, date, and engagement numbers

**7. Pending Signals** — GitHub events where `used_for_content = false`. Ordered by priority: `release` first, then `commit_batch`, then `new_repo`, then `readme_change`. Each entry shows: type, title, date, and body (trimmed to ~300 characters).

**8. System prompt for AI** — appended at the bottom. Instructions for the AI on how to use the file: read voice first, follow platform rules for every post, use signals as source material, don't repeat already-used signals.

#### Marking as used

After export, by default:
- Posts included in the export are stamped `used_for_export = true`, `exported_at = now()`
- Signals are **not** marked automatically — you mark them explicitly after using them

To skip marking (e.g. you're exporting for extra context, not for a content session):
```bash
npm run export -- --no-mark
```

To mark a signal as used after you've written the post:
```bash
eanyra signals mark <id>
```

---

### 4.5 MCP server

The MCP server exposes the database to an AI agent running in Claude Desktop or similar. The agent queries structured tools instead of reading a file.

**When to use MCP vs export file:**
- Export file: one-shot session, paste into any chat, no setup required
- MCP: ongoing work in Claude Desktop, agent can query dynamically, mark signals used interactively

#### Available tools

| Tool | Description |
|------|-------------|
| `posts_get` | Query `posts` table. Params: `platform`, `limit`, `type` (`recent`/`top_engagement`/`sample`), `lang` |
| `signals_get` | Query `signals` table. Params: `signal_type`, `used_for_content`, `limit` |
| `signals_mark_used` | Mark a signal as used. Params: `signal_id` |
| `context_get` | Full user context: voice, bio, platform rules, active projects |
| `export_get` | Return the latest export file as a string (or generate on demand) |
| `twitter_get_recent_posts` | *(legacy, replaced by `posts_get`)* |
| `twitter_search_posts` | Full-text search across post content |
| `twitter_get_trending_posts` | *(legacy, replaced by `posts_get` with `type=top_engagement`)* |
| `twitter_get_account_stats` | Aggregated engagement stats per account |
| `twitter_list_accounts` | All monitored accounts with last scrape time |
| `twitter_get_scraper_status` | Scraper health and data freshness |

#### Setup

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

---

## 5. Export quality — how to evaluate and improve

This section answers: **how do you know the export is good, and how do you make it better over time?**

The export is the main product of this system. Its quality directly determines how useful the AI's suggestions are. A bad export → generic suggestions. A good export → suggestions that sound like you and are actually publishable.

### What "good export" means

A good export passes these checks:

**Voice check** — paste the export into Claude and ask: "Based only on this file, write a Twitter post about X." If the output sounds like you without editing, the voice section is working.

**Platform check** — the AI respects length limits and language per platform without being reminded. If it keeps writing English LinkedIn posts when you're Ukrainian, `platforms.yaml` needs more explicit instruction.

**Signal usefulness** — pending signals contain real material: release notes, commit descriptions, specific feature changes. If signals are too vague ("updated README"), they won't generate useful posts.

**Post sample quality** — the sample shows your actual writing style, not just your most-liked posts. A viral post from two years ago might not represent how you write today.

### How to evaluate after each export

After running `npm run export`, open the file and check these four things:

**1. Is the voice section complete?**
Does `voice.yaml` describe your current style? Add new examples if your writing has evolved. The more specific, the better: instead of "casual tone", write "one short sentence per line on Twitter, no thread unless the topic needs it".

**2. Are platform rules specific enough?**
Open `platforms.yaml`. For each platform: does it say what to do (not just constraints)? Example of weak rule: `style: "Professional."` Example of strong rule: `style: "Start with a concrete result ('I shipped X'), then explain how. End with one question or takeaway."`

**3. Is the signal list actionable?**
Look at the pending signals section. For each signal, ask: could the AI turn this into a post right now? If the body is too short or too generic, the GitHub scraper is not collecting enough metadata. Fix: increase `GITHUB_COMMIT_MESSAGES_PER_BATCH` or extend the release body.

**4. Does the post sample represent your current voice?**
Check the dates. If the sample includes old posts from a year ago, the selection strategy is too broad. Fix: reduce `--days` or adjust the selection logic to weight recency more.

### How to improve iteratively

Keep a simple log. After each content session where you used an export:

```
Date: 2025-03-10
What worked: Signal about v2.0 release → 3 posts, all usable with minor edits
What didn't: AI kept writing LinkedIn posts in Ukrainian despite platform rules
Fix applied: Added explicit "language: en — always English, never Ukrainian" to platforms.yaml
Result: Check on next session
```

This log can live in `src/context/improvements.md` or a simple note. The point is to track what you changed and whether it helped.

### Signals quality checklist (GitHub scraper)

The GitHub scraper is the main source of content material. Signal quality depends on:

| Signal type | What makes it usable | What makes it weak |
|-------------|---------------------|-------------------|
| `release` | Full release notes, specific features listed, breaking changes called out | "v1.2.0" with empty body |
| `commit_batch` | Meaningful commit messages ("Add network interception fallback", "Fix canvas fingerprint on M1") | Auto-generated messages ("Update", "Fix", "WIP") |
| `new_repo` | README with project description | Empty or no README |
| `readme_change` | Diff showing what changed | SHA change with no body |

If your commit messages are weak, the signal will be weak. Write commit messages as if they'll appear in a changelog — because now they will.

---

## 6. Documentation structure

The project uses four separate documents, each with a distinct audience and purpose.

### `README.md` — setup and reference

**Audience:** developer (you, or someone new to the project)
**Purpose:** get the project running, understand all configuration options
**Contents:** quick start, CLI reference, npm scripts, module setup (Twitter login, LinkedIn CSV, GitHub token), full database schema, environment variables, MCP server setup
**What it is NOT:** architecture decisions, refactoring plans, quality improvement process

### `PLAN.md` — architecture and plan (this file)

**Audience:** developer for planning; AI assistant for context
**Purpose:** understand how the system works at the module level, what each component must do, what the active task list is
**Contents:** module contracts, data flow, export quality process, refactoring tasks, roadmap
**What it is NOT:** setup instructions, environment variable lists, step-by-step CLI usage

### `ARCHITECTURE.md` — technical decisions log (future)

**Audience:** developer
**Purpose:** document non-obvious decisions and why they were made
**Example entries:** "Why SQLite and not Postgres", "Why CSV import for LinkedIn and not Playwright", "Why MCP layer instead of direct DB calls from AI"
**Status:** not yet created — create when decisions accumulate

### `ROADMAP.md` — what is coming and when (future)

**Audience:** developer, optionally public
**Purpose:** track phases, what is done, what is next, what is out of scope
**Status:** currently lives at the bottom of README.md — extract when the list grows

### For AI sessions

When starting a content creation session with an AI:
- **Quickest:** `npm run export` → paste `data/exports/export-DATE.md` into chat
- **With MCP:** point Claude Desktop at the MCP server, call `context_get` first, then `signals_get`
- **For code work:** paste `PLAN.md` into chat — it describes every module contract and the active task list

---

## 7. Refactoring tasks

These are ordered by dependency — earlier tasks unblock later ones.

### Task 1 — DB migration: unify posts table

**What:** merge `Post` (Twitter) and `LinkedinPost` into a single `posts` table. Migrate `github_events` to `signals`.

**Why:** simplifies all queries, export logic, and MCP tools. Removes duplicated repository logic.

**Steps:**
1. Write migration script: create new `posts` schema, copy Twitter rows with `platform='twitter'`, copy LinkedIn rows with `platform='linkedin'`
2. Write migration script: create `signals` schema, copy `github_events` rows
3. Update `Post.js` → add `platform`, `external_id`, `content` columns
4. Delete `LinkedinPost.js`, `LinkedinPostRepository.js`
5. Delete `GithubEvent.js`, `GithubEventRepository.js`
6. Create `Signal.js`, `SignalRepository.js`
7. Update `registerModels()` in `models/index.js`
8. No backward compatibility needed — migrate all data, drop old tables

### Task 2 — Update LinkedIn importer

**What:** write to `posts` with `platform='linkedin'` instead of `linkedin_posts`.

**Steps:**
1. Update `LinkedinImporter.js`: map CSV fields to unified `posts` schema
2. Update `LinkedinPostRepository` → becomes part of `PostRepository` with platform filter
3. Update deduplication: `(platform, external_id)` unique constraint

### Task 3 — Update GitHub scraper

**What:** write to `signals` instead of `github_events`.

**Steps:**
1. Update `GithubScraper.js`: write `SignalRepository.upsert()` instead of `GithubEventRepository`
2. Map event types to `signal_type` values
3. Map `metadata` JSON to `metadata_json`
4. Verify `used_for_content` defaults to `false` on all inserts

### Task 4 — Export: update to unified schema

**What:** `ExportRepository` queries `posts` (not `Post`/`LinkedinPost`) and `signals` (not `github_events`).

**Steps:**
1. Update `ExportRepository.getTwitterPosts()` → `getPostsByPlatform('twitter')`
2. Update `ExportRepository.getLinkedinPosts()` → `getPostsByPlatform('linkedin')`
3. Update `ExportRepository.getGithubEvents()` → `getSignals()`
4. Update `markAsUsed()` → single `posts` table update

### Task 5 — MCP: new tools

**What:** add `posts_get`, `signals_get`, `signals_mark_used`, `export_get`. Keep legacy Twitter tools for now.

**Steps:**
1. Create `src/core/mcp/tools/posts.js` — `posts_get` with params `platform`, `limit`, `type`, `lang`
2. Create `src/core/mcp/tools/signals.js` — `signals_get` and `signals_mark_used`
3. Add `export_get` to `src/core/mcp/tools/context.js` — reads latest file from `data/exports/`
4. Register all new tools in `server.js`

### Task 6 — CLI: new commands

**What:** add `eanyra signals list`, `eanyra signals mark <id>`, `eanyra db migrate`.

**Steps:**
1. Create `src/core/cli/signalCommands.js` — `list` (pending signals) and `mark <id>`
2. Create `src/core/cli/dbCommands.js` — `migrate` runs the migration scripts from Task 1
3. Register in `cli/index.js`
4. Add npm scripts: `npm run signals` (alias for `eanyra signals list`)

### Task 7 — Documentation update

**What:** update `README.md` to reflect unified schema. Keep `PLAN.md` (this file) current.

**Steps:**
1. Update Database schema section in README — remove `linkedin_posts`, `github_events`, add `signals`
2. Update MCP tools table — add new tools
3. Update CLI section — add new commands and npm scripts
4. Create `ARCHITECTURE.md` with first two entries: SQLite choice, LinkedIn CSV choice

---

## 8. Roadmap

### Done

- MCP server with Twitter tools and `context_get`
- CLI with `eanyra start`, `eanyra scrape [platform]`, `eanyra context`
- Twitter scraper (Playwright + human behaviour + anti-detection)
- GitHub scraper (REST API — releases, commit batches, new repos, README changes)
- LinkedIn importer (CSV — idempotent, dependency-free parser)
- UserContext system (YAML → SQLite sync, `context_get` MCP tool)
- Export system (`eanyra export` / `npm run export` with full options)
- Multi-platform account management via `accounts.json`

### In progress

- DB unification (Tasks 1–3 above)
- Export update to unified schema (Task 4)

### Next

- MCP new tools: `posts_get`, `signals_get`, `signals_mark_used`, `export_get` (Task 5)
- CLI new commands (Task 6)
- Twitter network interception (replaces DOM scraping, DOM becomes fallback — see README)

### Future phases

- **Phase 3 — Telegram:** bot collects channel posts → `posts` table; reactions/questions → `signals`
- **Phase 4 — Discord:** community feedback → `signals`
- **ARCHITECTURE.md:** document key technical decisions
- **ROADMAP.md:** extract from README, expand with dates