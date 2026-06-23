# Author Context Guide

This guide explains how to maintain the YAML files under `src/context/`.
For setup and commands, see the repository [README](../README.md). For the
implementation details and known sync limitations, see
[ARCHITECTURE.md](ARCHITECTURE.md) and [ROADMAP.md](ROADMAP.md).

## How Context Is Used

The YAML files are the editable source of truth for the author's identity and
content rules. They are not read directly by the MCP server or Markdown
exporter.

```text
src/context/*.yaml
        |
        | npm run context:sync
        v
user_context + projects tables in SQLite
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
Copy-Item src/context/voice.example.yaml src/context/voice.yaml
Copy-Item src/context/bio.example.yaml src/context/bio.yaml
Copy-Item src/context/platforms.example.yaml src/context/platforms.yaml
Copy-Item src/context/projects/_template.yaml src/context/projects/my-project.yaml
```

Replace every placeholder before syncing. Real context files may contain
personal information and are intentionally gitignored. Project sync ignores
templates beginning with `_` and committed `.example.yaml` files.

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
slug: "my-project"
name: "My Project"
status: "active"
archive: false

description: |
  What it is, how it works at a high level, and why it exists.

tech_stack:
  - "Node.js"
  - "SQLite"

links:
  github: null
  website: null

content_angles:
  - "Why this project uses SQLite"

posting_rules:
  - "Prefer technical insights over feature announcements"
```

| Field | Type | Guidance |
|---|---|---|
| `slug` | string | Stable project key. Prefer lowercase kebab-case matching the filename. |
| `name` | string | Human-readable project name. Defaults to the slug when omitted. |
| `status` | `active`, `paused`, or `archived` | Controls inclusion in full context and exports. Defaults to `active`. |
| `archive` | boolean | When `true`, archives the project regardless of `status`. Removing the YAML file also archives it on the next sync. |
| `description` | string or `null` | Technical background the agent needs to write accurately. |
| `tech_stack` | string[] | Runtime, storage, frameworks, protocols, and important libraries. |
| `links` | object | Relevant project URLs. |
| `content_angles` | string[] | Specific decisions, lessons, constraints, or stories worth publishing. |
| `posting_rules` | string[] | Project-specific content strategy. |

The `slug` field becomes the `project.<slug>` database key. The implementation
does not currently enforce that it matches the filename.

## Sync Semantics And Validation

`npm run context:sync`:

1. Parses `voice.yaml`, `bio.yaml`, and `platforms.yaml` when present.
2. Reads project YAML files from `src/context/projects/`.
3. Upserts top-level objects into `user_context`.
4. Upserts projects into `projects` and duplicates each raw project object as
   `user_context` key `project.<slug>`.
5. Archives projects whose YAML files were removed.
6. Prints updated, skipped, and failed entries.

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
- Keep inactive projects as `paused` or `archived`.
- Run `context:sync`, inspect `context show`, and review any sync errors.
