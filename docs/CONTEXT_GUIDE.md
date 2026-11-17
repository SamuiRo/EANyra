# Author Context Guide

This guide explains how to maintain the YAML files under `instance/context/`.
For setup and commands, see the repository [README](../README.md). For the
implementation details and known sync limitations, see
[ARCHITECTURE.md](ARCHITECTURE.md) and [ROADMAP.md](ROADMAP.md).

## How Context Is Used

Every **persona** is self-contained: its own voice, bio and platform rules,
plus the accounts it writes for. Nothing is shared between personas. Projects
are shared files; each persona chooses which of them it talks about.

```text
instance/context/personas/<slug>.yaml   voice, bio, platforms, accounts
instance/context/projects/<slug>.yaml   projects
        |
        | sync (on save in the web UI, or npm run context:sync)
        v
user_context (persona.<slug>, project.<slug>) + projects table in SQLite
        |
        +--> context_get / personas_list MCP tools, content plan
        +--> Markdown export (npm run export -- --persona <slug>)
```

The easiest way to edit is the web UI: `npm run serve` → «Контекст». Saving
validates and syncs at once. After editing the files by hand, sync explicitly:

```bash
npm run context:sync
npm run nyra -- context show
```

Deleting a project YAML file archives its existing database record during the
next sync; it does not delete project history.

### Moving from the old shared files (before 4.0.0)

Older instances have `voice.yaml`, `bio.yaml` and `platforms.yaml` next to the
personas. They are **no longer used**. In «Контекст» they are listed as
«Застарілі»; «Перенести в персони» copies into every persona what it does not
set itself (only for the platforms of its accounts), keeps the comments in the
persona files and moves the old files to `context/.trash/`. Until then
`context sync` warns about them.

## Initial Setup

`npm run serve` creates an empty instance on first start; create personas and
projects in «Контекст». From the terminal:

```powershell
npm run instance:init
Copy-Item instance/context/projects/_template.yaml instance/context/projects/my-project.yaml
```

Replace every placeholder before syncing. Real context files may contain
personal information and are intentionally gitignored. All of `instance/` is
ignored. Versioned templates (`_template.yaml`) live in `instance_example/`;
new personas and projects in the web UI start from them. Sync ignores files
beginning with `_` and any `.example.yaml` files.

## AI-Assisted Project Setup

For a self-contained instruction that can be handed directly to an AI agent,
use [AI Project Context Instructions](PROJECT_CONTEXT_PROMPT.md). It tells the
agent what evidence to inspect, which facts must not be invented, how to write
specific content angles, and how to validate the result through context sync.

A short handoff is enough when the agent can access this repository:

```text
Follow docs/PROJECT_CONTEXT_PROMPT.md to create or update the project context.
Inspect the target project, do not invent missing facts, and complete the
validation workflow before reporting the result.
```

## `projects/<slug>.yaml`

Each project file describes one source of content ideas. Full context and
exports include only projects whose status is `active`.

```yaml
slug: "local-content-pipeline"
name: "Local Content Pipeline"
status: "active"
archive: false

description: |
  A local pipeline that stores normalized publishing data and verified project
  activity for AI-assisted content creation. SQLite is the integration boundary
  between collectors, Markdown exports, and MCP tools.

tech_stack:
  - "Node.js"
  - "SQLite"
  - "Model Context Protocol"

links:
  github: null
  website: null

content_angles:
  - "Why SQLite is the integration boundary for a local single-user workflow"
  - "How separating published posts from raw signals prevents duplicate ideas"

posting_rules:
  - "Ground every claim in repository evidence or stored data"
  - "Prefer one concrete architecture tradeoff per post"
```

| Field | Type | Guidance |
|---|---|---|
| `slug` | string | Stable lowercase kebab-case key. It must exactly match the filename without `.yaml`. |
| `name` | string | Human-readable project name. Defaults to the slug when omitted. |
| `status` | `active`, `paused`, or `archived` | Controls inclusion in full context and exports. Defaults to `active`. |
| `archive` | boolean | When `true`, archives the project regardless of `status`. Removing the YAML file also archives it on the next sync. |
| `description` | string or `null` | Verified explanation of what it is, who it serves, the problem, approach, current stage, and important constraints. |
| `tech_stack` | string[] | Meaningful runtimes, storage, frameworks, protocols, and infrastructure actually used by the project. |
| `links` | object | Verified project URLs under descriptive keys; use `null` or omit a key when no URL is known. |
| `content_angles` | string[] | Five to ten concrete post hooks grounded in a decision, tradeoff, problem, result, constraint, or lesson. |
| `posting_rules` | string[] | Two to six enforceable rules specific to publishing about this project. |

The `slug` field becomes the `project.<slug>` database key. The implementation
does not currently enforce that it matches the filename, so the author or AI
agent must check this explicitly. Use only the fields above: extra YAML fields
are not preserved by the structured project model and Markdown export.

## `personas/<slug>.yaml`

A persona is one identity or theme across platforms, for example a business
brand on Twitter, LinkedIn and Telegram, and a separate anime account. An
account without a persona has no voice: the AI is told to ask which persona it
belongs to.

```yaml
slug: "anime"
name: "Anime"
description: |
  Personal anime account: seasonal reviews, character discussion, fan art finds.
topics: ["seasonal anime", "Genshin Impact"]
accounts:
  - "twitter/example-anime-fan"
  - "telegram/my-anime-channel"

voice:
  tone: "Casual, enthusiastic, emoji are fine"
  likes: ["Concrete impressions of one episode or scene"]
  dislikes: ["Spoilers without a warning"]
  example_post: |
    Episode 7 finally gave Frieren a quiet moment...
  taboo: ["Never mention work projects"]

bio:
  twitter:
    short: "Anime, games and the occasional fan art"

platforms:
  twitter:
    max_length: 280
    language: "en"
    style: "Short, conversational posts. One thought per post."
    formats: ["impression", "question to other fans"]
    avoid: ["spoilers"]
    posting_frequency: "3 posts per week"

projects: []
```

### Assigning accounts

The easiest way: «Акаунти» → «Редагувати» → «Персона». It moves the account
between persona files (comments stay) and syncs. In the file, `accounts`
lists `"platform/username"` entries that must exist in `accounts.json`. Each
account belongs to one persona only, so its voice is never ambiguous. A new
persona may start with `accounts: []`.

### `voice`

| Field | Type | Guidance |
|---|---|---|
| `tone` | string | Describe the overall voice and what distinguishes it. |
| `likes` | string[] | Concrete patterns the agent should actively use. |
| `dislikes` | string[] | Phrases and patterns the agent should avoid. |
| `example_post` | multiline string | A representative post in the real publishing language. |
| `taboo` | string[] | Hard rules that must never be broken. |

Prefer specific instructions such as "use exact numbers when available" over
generic instructions such as "be engaging".

### `bio`

One key per platform:

| Field | Type | Guidance |
|---|---|---|
| `short` | string | Short bio or headline appropriate for the platform. |
| `full` | string or `null` | Longer biography when the platform supports one. |

### `platforms`

How this persona adapts an idea per platform. Platform slugs are not limited
to the collected platforms, so rules may also describe planned channels.

| Field | Type | Guidance |
|---|---|---|
| `max_length` | integer | Target hard character limit. |
| `language` | string | Publishing language, normally an ISO 639-1 code. |
| `style` | string | Platform-specific tone, density, and structure. |
| `formats` | string[] | Useful post patterns the agent may choose from. |
| `avoid` | string[] | Platform-specific anti-patterns. |
| `posting_frequency` | string | Target cadence used by `content_plan_get` and the web content plan. Understood forms: `daily`, `weekly`, `monthly`, `every 2 days`, `3 posts per week`, `3/week`, `2 posts per month`, `щодня`, `щотижня`, `3 рази на тиждень`. Other text is shown but not checked. |

### `projects`

Limits the projects the persona talks about. Omit it to use all active
projects; `[]` means none.

### MCP use

On connect, the server's `instructions` tell the agent to pick the target
persona before drafting. `personas_list` returns the personas, their accounts
and projects, plus configured accounts that belong to none. `context_get
{"account": "twitter/example-anime-fan"}` or `{"persona": "anime"}` returns that
persona's voice, bio, platform rules and projects. `posts_get`, `posts_search`,
`posts_stats`, `accounts_list` and `signals_get` accept `persona` to limit
results to its accounts, for example to calibrate style only on anime posts.

## Editing in the Web UI

`npm run serve` → tab «Контекст» edits the same files: the editor validates
while you type (field-level errors block saving, warnings are hints), keeps
your comments, and «Зберегти й синхронізувати» writes the file and runs the
context sync, so the AI sees the change at once. New projects and personas
start from the shipped `_template.yaml` files; deleting one moves it to
`context/.trash/` (the project is archived, the persona's accounts ungrouped
on sync).

## Sync Semantics And Validation

`npm run context:sync` (also run by every save in the web UI):

1. Reports the old `voice.yaml`, `bio.yaml`, `platforms.yaml` as unused and
   removes their old database rows.
2. Reads project YAML files from `instance/context/projects/`, upserts them
   into `projects` and as `user_context` key `project.<slug>`.
3. Archives projects whose YAML files were removed.
4. Validates all persona files (slug, accounts present in `accounts.json`,
   exclusive membership, field types) and stores them as `persona.<slug>`. If
   any persona file is invalid, no persona is changed. Removing a persona file
   removes that grouping.
5. Prints updated, skipped, and failed entries.

Errors name the exact field, for example
`personas/brand.yaml: platforms.twitter.max_length must be a positive whole
number`; a file with errors is not synced and its previously synced version
stays in use. Warnings never block: unknown keys (with a hint such as `did you
mean "posting_frequency"?`), a `posting_frequency` the content plan cannot
read, a persona without accounts.

Useful inspection commands:

```bash
# What CLI, exports, and the full MCP context will see
npm run nyra -- context show

# One raw context key, including a paused or archived project
npm run nyra -- context show --key project.my-project
```

## Writing Checklist

- Use real values and remove all template placeholders.
- Give every persona its own `voice`, `bio` and `platforms`; nothing is inherited.
- Keep `voice` rules concrete enough to evaluate a draft against them.
- Add at least one representative `example_post` per persona.
- Describe meaningful differences between platform styles.
- Assign every publishing account to a persona.
- Write content angles as actual hooks, not broad topics.
- Keep project filenames and `slug` values identical.
- Verify project facts from current documentation and implementation; ask the
  author instead of inventing missing features, results, metrics, or URLs.
- Use only supported project fields and preserve the documented YAML types.
- Keep inactive projects as `paused` or `archived`.
- Run `context:sync`, inspect `context show`, and review any sync errors.
