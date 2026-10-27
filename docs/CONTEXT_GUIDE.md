# Author Context Guide

This guide explains how to maintain the YAML files under `instance/context/`.
For setup and commands, see the repository [README](../README.md). For the
implementation details and known sync limitations, see
[ARCHITECTURE.md](ARCHITECTURE.md) and [ROADMAP.md](ROADMAP.md).

## How Context Is Used

The YAML files are the editable source of truth for the author's identity and
content rules. They are not read directly by the MCP server or Markdown
exporter.

```text
instance/context/*.yaml
        |
        | npm run context:sync
        v
user_context (voice, bio, platforms, personas) + projects tables in SQLite
        |
        +--> context_get MCP tool
        +--> Markdown export
```

Run an explicit sync after every YAML change:

```bash
npm run context:sync
npm run nyra -- context show
```

`eanyra start` and scrape commands do not currently sync context
automatically. Deleting a project YAML file archives its existing database
record during the next explicit sync; it does not delete project history.

## Initial Setup

Create the real, gitignored files from the committed examples:

```powershell
npm run instance:init
Copy-Item instance/context/projects/_template.yaml instance/context/projects/my-project.yaml
```

Replace every placeholder before syncing. Real context files may contain
personal information and are intentionally gitignored. All of `instance/` is
ignored. Versioned examples and `_template.yaml` live in `instance_example/`;
initialization copies them into the selected instance. Project sync ignores templates beginning with `_` and any
`.example.yaml` files.

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

## `voice.yaml`

Defines global writing behavior. The entire YAML object is stored under the
`voice` context key.

| Field | Type | Guidance |
|---|---|---|
| `tone` | string | Describe the overall voice and what distinguishes it. |
| `likes` | string[] | Concrete patterns the agent should actively use. |
| `dislikes` | string[] | Phrases and patterns the agent should avoid. |
| `example_post` | multiline string | A representative post in the real publishing language. |
| `taboo` | string[] | Hard rules that must never be broken. |

Prefer specific instructions such as "use exact numbers when available" over
generic instructions such as "be engaging".

`context_get` returns `example_post`, but the generated Markdown export
currently omits it. This limitation is tracked in the roadmap.

## `bio.yaml`

Defines platform-specific biographies. Each top-level key is a platform slug.

```yaml
twitter:
  short: "Short platform bio"
  full: null

linkedin:
  short: "Short headline"
  full: |
    Longer biography.
```

| Field | Type | Guidance |
|---|---|---|
| `short` | string | Short bio or headline appropriate for the platform. |
| `full` | string or `null` | Longer biography when the platform supports one. |

Only include platforms that are useful to your content workflow.

## `platforms.yaml`

Defines how the same idea should be adapted per publishing platform. Platform
slugs in context are not restricted to the currently collected platforms, so
rules may also describe planned channels such as Discord.

```yaml
twitter:
  max_length: 280
  language: "uk"
  style: "Concise technical observations with concrete details."
  formats:
    - "insight"
    - "before / after"
  avoid:
    - "engagement bait"
  posting_frequency: "2 posts per week"
```

| Field | Type | Guidance |
|---|---|---|
| `max_length` | integer | Target hard character limit. |
| `language` | string | Publishing language, normally an ISO 639-1 code. |
| `style` | string | Platform-specific tone, density, and structure. |
| `formats` | string[] | Useful post patterns the agent may choose from. |
| `avoid` | string[] | Platform-specific anti-patterns. |
| `posting_frequency` | string | Human-readable target cadence; not automatically enforced. |

The MCP context returns all fields. The Markdown exporter currently looks for
`frequency` instead of `posting_frequency`, so cadence is absent from exports;
this mismatch is tracked in the roadmap.

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

A persona groups the accounts that represent one identity or theme across
platforms, for example a business brand on Twitter, LinkedIn and Telegram, and
a separate anime account. Without personas, every account shares the global
`voice.yaml`, `bio.yaml`, `platforms.yaml` and all active projects, so an AI
agent cannot tell what each account is for.

```powershell
Copy-Item instance/context/personas/_template.yaml instance/context/personas/anime.yaml
```

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
  taboo: ["Never mention work projects"]
platforms:
  twitter:
    language: "en"
projects: []
```

Rules:

- `accounts` lists `"platform/username"` entries that must exist in
  `accounts.json`. Each account may belong to only one persona, so its voice is
  never ambiguous. New platforms (for example Discord) use the same form once
  they are supported.
- `voice` overrides `voice.yaml` key by key. `bio` and `platforms` override per
  platform and per key. Missing values fall back to the global files, so the
  global files act as defaults for every persona. Lists are replaced, not
  appended: repeat a global `taboo` if it must also apply here.
- `projects` limits the projects the persona talks about. Omit it to use all
  active projects; `[]` means none.
- Accounts outside every persona keep using the global context.

MCP use: on connect, the server's `instructions` tell the agent to pick the
target persona before drafting. `personas_list` returns the personas, their
accounts and projects, plus configured accounts that belong to none (read from
`accounts.json`). `context_get` without arguments also lists the personas.
`context_get {"account": "twitter/example-anime-fan"}` or `{"persona": "anime"}`
returns the merged context for that persona. `posts_get`, `posts_search`,
`posts_stats`, `accounts_list` and `signals_get` accept `persona` to limit
results to its accounts, for example to calibrate style only on anime posts.

## Sync Semantics And Validation

`npm run context:sync`:

1. Parses `voice.yaml`, `bio.yaml`, and `platforms.yaml` when present.
2. Reads project YAML files from `instance/context/projects/`.
3. Upserts top-level objects into `user_context`.
4. Upserts projects into `projects` and duplicates each raw project object as
   `user_context` key `project.<slug>`.
5. Archives projects whose YAML files were removed.
6. Validates all persona files (slug, accounts present in `accounts.json`,
   exclusive membership, field types) and stores them as `persona.<slug>`. If
   any persona file is invalid, no persona is changed. Removing a persona file
   removes that grouping.
7. Prints updated, skipped, and failed entries.

The current implementation validates YAML syntax and database constraints, but
does not perform complete schema validation. Before syncing, check that arrays,
objects, URLs, languages, and project slugs use the intended types and values.

Useful inspection commands:

```bash
# What CLI, exports, and the full MCP context will see
npm run nyra -- context show

# One raw context key, including a paused or archived project
npm run nyra -- context show --key project.my-project
```

## Writing Checklist

- Use real values and remove all template placeholders.
- Keep `voice` rules concrete enough to evaluate a draft against them.
- Add at least one representative `example_post`.
- Describe meaningful differences between platform styles.
- Write content angles as actual hooks, not broad topics.
- Keep project filenames and `slug` values identical.
- Verify project facts from current documentation and implementation; ask the
  author instead of inventing missing features, results, metrics, or URLs.
- Use only supported project fields and preserve the documented YAML types.
- Keep inactive projects as `paused` or `archived`.
- Run `context:sync`, inspect `context show`, and review any sync errors.
