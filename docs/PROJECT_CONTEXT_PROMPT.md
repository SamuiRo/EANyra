# AI Project Context Instructions

Give this file to an AI agent when you want it to create or update an EANyra
project context file. This document is the complete task contract; the agent
must not rely on unstated assumptions.

## Objective

Create or update one real project context file at:

```text
instance/context/projects/<slug>.yaml
```

The file supplies verified project facts, reusable content angles, and
project-specific publishing rules to EANyra exports and MCP context.

## Required Research

Before writing the YAML:

1. Read this file completely.
2. Read `docs/CONTEXT_GUIDE.md`, especially the project schema and sync rules.
3. Inspect the target project's available evidence:
   - README and other product documentation;
   - package/dependency manifests;
   - architecture and roadmap documents;
   - configuration files;
   - primary implementation modules relevant to its purpose.
4. Prefer current implementation and authoritative documentation over old
   examples, archived plans, or marketing language.
5. If the target project or its location is unclear, ask the author before
   writing anything.

Do not invent features, technologies, users, metrics, results, links, project
status, or lessons. If a material fact cannot be verified, ask the author or
omit it. Explicitly list any unresolved facts in the final report.

## File Contract

Use only these supported fields:

| Field | Required shape | Rules |
|---|---|---|
| `slug` | string | Lowercase kebab-case. Must exactly match the filename without `.yaml`. Treat it as a stable identifier. |
| `name` | string | Real human-readable project name. |
| `status` | `active`, `paused`, or `archived` | Use `active` for a project that should appear in full context and exports. |
| `archive` | boolean | Normally `false`. When `true`, it overrides `status` and archives the project. |
| `description` | multiline string | Explain what it is, who it serves, the problem, the high-level approach, current stage, and important constraints. Use verified facts only. |
| `tech_stack` | string array | Include meaningful runtimes, storage, frameworks, protocols, and major infrastructure actually used by the project. Do not dump every dependency. |
| `links` | object | Use descriptive keys such as `github`, `website`, or `docs`. Include only verified URLs; otherwise use `null` or omit the key. |
| `content_angles` | string array | Add 5-10 concrete, evidence-based post hooks. Each must identify a decision, tradeoff, problem, result, constraint, or lesson. |
| `posting_rules` | string array | Add 2-6 rules specific to publishing about this project. Do not duplicate generic voice or platform rules. |

Do not add unsupported fields: the structured project model and Markdown
exporter will ignore them. Preserve the YAML value types shown above. EANyra
does not yet perform complete schema validation, so a successful parse alone
does not prove that the file is correct.

## Content Quality Rules

- Write the file in UTF-8.
- Do not leave template placeholders in a real project file.
- Do not edit `_template.yaml` or create a file ending in `.example.yaml`.
- Keep the filename and `slug` identical, for example
  `local-content-pipeline.yaml` and `slug: "local-content-pipeline"`.
- Make the description factual and useful to an agent unfamiliar with the
  repository. Avoid slogans and unsupported claims.
- Treat every content angle as a potential post premise. Avoid broad labels
  such as "interesting technical decisions", "what I learned", or "project
  updates".
- Make posting rules enforceable, for example "mention the measured limit"
  instead of "make the post engaging".
- Update an existing real file carefully. Preserve confirmed author-provided
  facts unless current evidence clearly supersedes them.

## YAML Shape

Use `instance/context/projects/_template.yaml` as the editable shape. A completed
file should resemble this structure:

```yaml
slug: "local-content-pipeline"
name: "Local Content Pipeline"
status: "active"
archive: false

description: |
  A local pipeline for a solo developer who wants to turn verified project
  activity into social content. It stores normalized posts, source signals,
  and author context in SQLite and exposes them through Markdown and MCP.

tech_stack:
  - "Node.js"
  - "SQLite"
  - "Model Context Protocol"

links:
  github: null
  website: null

content_angles:
  - "Why SQLite is the integration boundary for a local, single-user workflow"
  - "How separating published posts from raw signals prevents duplicate ideas"
  - "Why context sync is explicit instead of running during every scrape"
  - "What is gained by keeping collection separate from AI reasoning"
  - "How normalized platform records make one export work across several channels"

posting_rules:
  - "Ground every claim in repository evidence or stored data"
  - "Prefer one concrete architecture tradeoff per post"
  - "Do not present exported signals as already-published content"
```

The example demonstrates specificity and structure. Do not copy its facts into
an unrelated project.

## Validation Workflow

After writing the real file, run:

```bash
npm run context:sync
npm run nyra -- context show --key project.<slug>
```

Then verify all of the following:

- sync reports no errors for the project;
- the displayed key and YAML `slug` match the filename;
- arrays are arrays, `links` is an object, and `archive` is a boolean;
- no placeholders or unverified URLs remain;
- an active project appears in `npm run nyra -- context show`;
- `git status --short` does not list the real project file, because real
  project context files are intentionally gitignored.

If commands cannot be run, return the complete YAML and explicitly state that
sync and database verification remain pending.

## Final Report

Report:

1. the created or updated file path;
2. the evidence inspected;
3. whether sync and `context show` succeeded;
4. any facts that remain unverified or require author confirmation.
