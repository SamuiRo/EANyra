---
name: eanyra
description: >
  Personal media pipeline for a solo developer. Collects published posts
  (Twitter, LinkedIn) and GitHub activity, stores them locally in SQLite,
  and exposes everything through unified MCP tools for AI-assisted content creation.
  Use this skill to understand the author's voice, browse pending signals,
  query posts across all platforms, and suggest what to publish next.
version: 2.0.0
metadata:
  openclaw:
    requires:
      env:
        - DB_PATH
      bins:
        - node
    primaryEnv: DB_PATH
    emoji: "📡"
    homepage: https://github.com/SamuiRo/EANyra
---

# EANyra — Content Creation Skill

EANyra is a personal media pipeline for a solo developer. It collects published posts
(Twitter, LinkedIn) and GitHub activity into a local SQLite database, then exposes
everything through unified MCP tools.

Your job: read the author's context, identify what is worth posting about, and generate
content that sounds exactly like the author — not like a generic AI assistant.

## MCP Setup

Add this to your OpenClaw MCP configuration (`~/.openclaw/config.json`):

```json
{
  "mcpServers": {
    "eanyra": {
      "command": "node",
      "args": ["/absolute/path/to/EANyra/src/core/mcp/server.js"],
      "env": {
        "DB_PATH": "${DB_PATH}"
      }
    }
  }
}
```

`DB_PATH` must point to the SQLite file, typically `<project-root>/data/pot.sqlite`.

---

## Mandatory workflow — follow this order every session

**Never generate content before calling `context_get`.**

```
Step 1 → context_get()          read voice, bio, platform rules, active projects
Step 2 → signals_get()          see what signals are pending (unused)
Step 3 → posts_get()            (optional) calibrate tone from real post examples
Step 4 → write content
Step 5 → signals_mark_used()    only after the author confirms the post goes live
```

If the author starts with "write me a post about X", you still run Step 1 first.
One `context_get` call makes every piece of content significantly more accurate.

---

## Available Tools

### `context_get` — author identity and rules

Returns everything needed to write in the author's voice:
- `voice` — tone, style, what they like, what they dislike, taboo topics
- `bio` — bio per platform
- `platforms` — per-platform rules: language, max length, style, posting frequency
- `projects` — active projects with content angles and posting rules

```
context_get()                          → full context (use this by default)
context_get(key: "voice")              → tone and style only
context_get(key: "platforms")          → platform rules only
context_get(key: "project.eanyra")     → specific project by slug
```

Call this **first in every session**, no exceptions.

---

### `signals_get` — raw material for future posts

Signals are events and notes that have not yet become posts.
They are the primary input for every content creation session.

Sources:
- `github` — releases, commit batches, new repos, README changes
- `note` — manual ideas or drafts added by the author
- `article` — links the author wants to write about

Signal types within `github` (returned in priority order):
- `release` — most valuable; has version tag and full release notes
- `commit_batch` — N commits grouped by week; useful when messages are meaningful
- `new_repo` — new repository; useful if README has a real description
- `readme_change` — README update; only useful if `body` has real content

```
signals_get()                               → unused signals, priority order (default)
signals_get(signal_type: "release")         → only releases
signals_get(source: "github")               → only GitHub signals
signals_get(used_for_content: false)        → explicitly unused only
signals_get(used_for_content: true)         → already used (for reference)
signals_get(since_days: 14)                 → last 14 days
signals_get(account: "username")            → signals from a specific account
signals_get(limit: 50)                      → more results
```

Each signal has an `id` field — save it for `signals_mark_used`.

---

### `signals_mark_used` — close the loop after publishing

Mark signals as used **after** the author confirms the post goes live.
Do NOT call this speculatively or before confirmation.
If the session ends without publishing, do not mark anything.

```
signals_mark_used(signal_id: 42)            → one signal
signals_mark_used(signal_id: [42, 43, 44])  → multiple at once
```

---

### `posts_get` — browse published posts

Query published posts across all platforms. Use this to calibrate writing style
against real examples before drafting content.

Selection types:
- `recent` — newest first (default)
- `top_engagement` — ranked by likes + reposts
- `sample` — balanced mix: 50% top engagement + 50% recent; **best for style calibration**

```
posts_get()                                 → last 20 posts, all platforms
posts_get(platform: "twitter", limit: 10)   → 10 recent Twitter posts
posts_get(platform: "linkedin")             → LinkedIn posts
posts_get(type: "top_engagement")           → sorted by likes + reposts
posts_get(type: "sample")                   → balanced style calibration mix
posts_get(lang: "uk")                       → Ukrainian posts only
posts_get(since_days: 30)                   → last 30 days
posts_get(unused_only: true)                → not yet used for content creation
```

Always excludes reposts. Excludes replies by default.

---

### `posts_search` — full-text search across posts

Search post content across all platforms. Case-insensitive substring match.

```
posts_search(query: "Playwright")                       → all platforms
posts_search(query: "MCP", platform: "linkedin")        → LinkedIn only
posts_search(query: "реліз", account: "username")       → specific account
posts_search(query: "антидетекція", since_days: 90)     → last 90 days
```

---

### `posts_stats` — engagement statistics

Aggregated stats grouped by account and platform.
Useful for comparing performance across platforms or identifying best-performing content.

```
posts_stats()                               → all platforms, last 30 days
posts_stats(platform: "twitter")            → Twitter only
posts_stats(platform: "linkedin")           → LinkedIn only
posts_stats(account: "username")            → specific account
posts_stats(days: 0)                        → all-time stats
posts_stats(days: 7)                        → last 7 days
```

Returns per account per platform: total posts, original posts, repost/reply counts,
total/average/peak likes, reposts, replies, views.

---

### `accounts_list` — all monitored accounts

List all monitored accounts across all platforms with post and signal counts.

```
accounts_list()                             → all active accounts, all platforms
accounts_list(platform: "twitter")          → Twitter accounts only
accounts_list(platform: "github")           → GitHub accounts only
accounts_list(active_only: false)           → include inactive accounts
```

Returns: username, display name, platform, last scrape time,
`posts_in_db` count, `signals_in_db` count.

---

### `export_get` — full context in one call

Returns the latest export Markdown file from `data/exports/`.
Contains voice, platform rules, active projects, recent posts, and pending signals
in one document — everything needed for a content session without multiple round-trips.

```
export_get()                                → latest export file
export_get(file: "export-2025-04-01.md")    → specific file by name
export_get(max_chars: 120000)               → larger output for long-context models
```

Use this when you want a complete picture quickly. Otherwise use individual tools
for more precise filtering.

---

### `scraper_status` — data freshness check

Check when data was last collected and whether scrapers are healthy.

```
scraper_status()
scraper_status(history_limit: 10)           → last 10 runs instead of 5
```

Response fields:
- `health`: `ok` / `degraded` / `error` / `running` / `unknown`
- `data_age_hours`: hours since last successful scrape
- `latest_run`: full details of the most recent run
- `recent_runs`: history of recent scraper executions

Use this if data looks stale or before a session where freshness matters.
If `data_age_hours > 48`, warn the author that data may be outdated.

---

## Content generation rules

### Voice — the most important constraint

Before writing any post:
1. Read `voice` from `context_get`
2. Check `voice.taboo` — hard limits, never cross them
3. Check `voice.dislikes` — avoid these patterns even if they seem natural
4. Call `posts_get(type: "sample")` and compare your draft to real examples

If your draft does not sound like the examples, rewrite it.
Do not deliver generic AI-sounding content and expect the author to fix it.

### Platform rules — always enforced

From `context_get` → `platforms.<platform>`:
- `language` — write **only** in this language for this platform. No exceptions.
- `max_length` — never exceed this. Count characters if needed.
- `style` — follow the style description literally.

If `platforms.twitter.language` is `uk`, write in Ukrainian.
If `platforms.linkedin.language` is `en`, write in English.
Never mix languages between platforms.

### Projects — use the angles

From `context_get` → `projects`:
- `content_angles` — pre-approved angles for posting about this project. Use them.
- `posting_rules` — specific constraints (e.g. "on release — 3-4 posts, not all at once")
- `tech_stack` — accurate technical details for technical posts

### Signals → posts: conversion guide

**`release` signal:**
Source: version tag + release notes.
Write about: specific changes → what problem they solve → what changed for the user.
Volume: 1–3 posts depending on release size.
Avoid: "Version 2.0 is out" with no details.

**`commit_batch` signal:**
Source: N commit messages grouped by week.
Write about: what actually changed → behind-the-scenes decisions.
Avoid: listing every commit as a bullet list.

**`new_repo` signal:**
Source: repo name + README content.
Write about: what problem it solves → why it was built → current status.
If README is empty — ask the author what the project does before writing.

**`readme_change` signal:**
Source: SHA diff (often minimal).
Only write about this if `body` has real content.
If `body` is empty or just a SHA — skip or ask the author what changed.

### Never do these things

- Do not write content without reading `voice` first
- Do not invent facts, numbers, or technical details not present in the signal
- Do not mark signals as used before the author confirms the post goes live
- Do not write in the wrong language for the platform
- Do not use corporate phrasing ("We are excited to announce…", "Thrilled to share…")
- Do not use signals where `used: true` — they are already processed

---

## Quality checklist before delivering a draft

- [ ] Language matches `platforms.<platform>.language`
- [ ] Length does not exceed `platforms.<platform>.max_length`
- [ ] No phrases from `voice.dislikes`
- [ ] No topics from `voice.taboo`
- [ ] Contains specific details (numbers, names, concrete facts) — not generic statements
- [ ] Tone matches `voice.tone`
- [ ] If about a project — at least one `content_angles` item is reflected
- [ ] Signal `used` field is `false` (not already used)

---

## Common session patterns

**Standard content session:**
```
context_get() → signals_get() → posts_get(type:"sample") → write → signals_mark_used()
```

**"Write about my GitHub this week":**
```
context_get() → signals_get(source:"github", since_days:7) → write → signals_mark_used()
```

**"What content performed best recently?":**
```
posts_stats(days:30) → posts_get(type:"top_engagement", since_days:30)
```

**"Find posts where I mentioned Playwright":**
```
posts_search(query:"Playwright")
```

**"Which accounts do you monitor?":**
```
accounts_list()
```

**Quick full-context load:**
```
export_get() → write (no additional calls needed)
```

**Check data freshness before a session:**
```
scraper_status() → if data_age_hours > 48, warn the author
```