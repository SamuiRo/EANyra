# Product Vision

This document preserves the durable product direction of EANyra. It describes
why the system exists and where it may grow, without replacing the current
[architecture](ARCHITECTURE.md) or the actionable [roadmap](ROADMAP.md).

## Core Idea

EANyra is the data and context layer for an AI-assisted personal media
workflow.

It gives an AI agent visibility into two streams:

1. **What the author publishes**: posts, timing, platforms, and engagement.
2. **What the author builds and learns**: releases, commit activity, project
   context, notes, articles, and future signal sources.

The agent can use both streams to suggest grounded content, adapt ideas to each
platform, and help the author maintain a sustainable publishing rhythm.

## Product Boundary

EANyra collects, normalizes, stores, and exposes data. It should remain useful
without embedding a specific model or agent runtime.

The AI agent reads EANyra data through MCP or Markdown exports, then:

- decides what is worth writing about;
- adapts an idea to each platform's voice and constraints;
- proposes drafts and content sequences;
- asks for missing facts instead of inventing them;
- closes the loop after the author confirms publication.

EANyra is not intended to autonomously publish content without explicit author
control.

## Current Foundation

The original project plan has largely reached its first two phases:

- Twitter/X posts are collected through Playwright.
- GitHub activity is normalized into reusable signals.
- LinkedIn posts are imported from the platform's CSV export.
- Published posts share one normalized table.
- Signals are separated from already-published posts.
- Author voice, platform rules, and project context are maintained as YAML.
- MCP tools and Markdown exports expose the resulting context to an agent.

The authoritative implementation status is maintained in the roadmap.

## Target Agent Workflows

### Content Discovery

The agent reviews unused signals, active projects, and recent posts to propose
specific ideas grounded in real work. One meaningful release may become
several posts from different angles rather than one generic announcement.

### Platform Adaptation

The same source idea may become a concise technical observation on Twitter/X,
a longer lesson on LinkedIn, or a channel update on Telegram. Platform rules
come from author context, not hardcoded generic advice.

### Publishing Rhythm

The agent should eventually identify posting gaps per platform and proactively
remind the author when activity falls below the configured cadence. EANyra
currently stores the required post timestamps and target frequencies, but does
not yet implement this workflow.

### Feedback Loop

Published content and engagement provide style and performance context for
future suggestions. Signals should eventually be linked to the posts created
from them, allowing the system to learn which sources and angles become useful
content without confusing export activity with publication.

## Platform Strategy

Platform integrations should favor reliable, maintainable access:

- official APIs when available and appropriate;
- user-provided exports when scraping is fragile or unnecessary;
- authenticated browser collection only where no suitable alternative exists.

Potential future publishing sources include Telegram and Discord. They should
use the same normalized post and signal contracts rather than introducing
platform-specific agent workflows.

## Design Principles

- **Ground every suggestion in real data.** Never fabricate progress, facts, or
  metrics.
- **Keep collection separate from reasoning.** EANyra supplies evidence; the
  agent makes content decisions.
- **Preserve author control.** Drafting, marking a signal used, and publishing
  are distinct actions.
- **Treat platform differences as context.** Voice and format rules belong in
  editable author context.
- **Prefer durable integrations.** Reliability is more valuable than collecting
  every possible metric.
- **Stay local-first.** SQLite, explicit files, and MCP keep the system
  inspectable and portable.

## Long-Term Outcome

EANyra should make a solo developer's real work easier to turn into consistent,
accurate content without forcing them to constantly remember what happened,
search across platforms, or start every writing session from a blank page.
