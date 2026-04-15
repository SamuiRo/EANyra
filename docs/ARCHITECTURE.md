# ARCHITECTURE.md

> How this project is structured and why.  
> Read this to understand where things live and how to extend the project.

---

## Directory structure

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
