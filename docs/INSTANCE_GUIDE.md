# Instance layout

The root `.env` contains credentials and runtime settings. `instance/` contains
editable context, accounts and runtime data. Application code stays in `src/`;
reusable defaults live in `instance_example/`.

```text
.env                            repository root; credentials and runtime options
instance/                       entirely gitignored
  accounts.json                 monitored accounts and publishing permissions
  context/
    voice.yaml
    bio.yaml
    platforms.yaml
    projects/
      _template.yaml
      your-project.yaml
  data/
    pot.sqlite                  collected records and Telegram publication outbox
    cookies.json                sensitive Twitter cookie cache
    nyra/                       persistent browser profile
    imports/                    LinkedIn CSV files
    exports/                    generated Markdown
    logs/                       migrated legacy logs
```

Edit `instance/context/` and `instance/accounts.json` directly. Put the Telegram
bot token in `.env` when ready; an empty token does not prevent editing
context or preparing a publication draft. Context changes become available to
agents after `npm run context:sync`; account changes sync during collection.
Restart MCP/daemon after changing environment values.

## New installation

```powershell
npm install
npm run instance:init
```

Initialization copies missing files from `instance_example/` and creates runtime
directories. Existing files are never overwritten. Replace sample accounts and
context placeholders before running collection or context sync. The project
template is ignored by context sync until copied to a real project YAML file.

## Migrating an older checkout

Stop the daemon, MCP workers, and the application browser before migrating.
Back up your SQLite file before upgrading the application. Run migration before
`instance:init` so initialized sample files cannot conflict with your real data.

```powershell
npm run instance:migrate
```

The command leaves root `.env` in place and moves `src/config/accounts.json`,
`src/context/`, root `data/`, and an optional root `debug.log` into the instance.
An intermediate `instance/.env` is moved back to root without changing its contents;
if both environment files exist, migration reports a conflict. It then creates
only missing template files. If a source and destination both exist, the command
reports a conflict before moving anything; it never merges or overwrites them.
An existing scrape lock also blocks migration. The migration does not run schema
migrations, scrape sources, publish messages, or resync context.

Standard path variables in the old environment are rebased to their instance
locations. Other environment values, including credentials, remain unchanged.
Explicit paths outside the standard legacy locations are preserved as absolute
paths; those custom files are not moved automatically. Handled move failures
attempt to restore already moved files. A hard process termination during file
moves may require manual recovery; this is not a filesystem transaction.

Legacy migration destinations must be within the repository and outside `src`,
`data`, `templates`, `instance_example` and `.git`. Symbolic-link destinations are rejected.

## Paths and selecting an instance

Configuration always loads `<repository>/.env`, independent of the current
working directory. `INSTANCE_DIR` can be set in that root file or supplied by
the process environment; the process value takes precedence. Its default is
`<repository>/instance`. For example:

```powershell
$env:INSTANCE_DIR = 'instance-client-two'
npm run instance:init
npm run context:sync
```

A relative `INSTANCE_DIR` resolves from the repository root. All other relative
runtime paths resolve from the selected instance, independent of the current
working directory. For example, `DB_PATH=data/pot.sqlite` points into that
instance, not a root `data/` directory. Absolute path overrides remain supported.
Externally supplied environment values take precedence over root `.env`.
Different instance directories share the root settings unless overridden externally.

| Setting | Default within the selected instance |
|---|---|
| environment file | `<repository>/.env` (outside the instance) |
| `ACCOUNTS_CONFIG_PATH` | `accounts.json` |
| `CONTEXT_DIR` | `context/` |
| `DATA_DIR` | `data/` |
| `DB_PATH` | `<DATA_DIR>/pot.sqlite` |
| `EXPORTS_DIR` | `<DATA_DIR>/exports/` |
| `BROWSER_DATA_PATH` | `<DATA_DIR>/nyra/` |
| `BROWSER_COOKIES_PATH` | `<DATA_DIR>/cookies.json` |
| `BROWSER_COOKIES_IMPORT_PATH` | `<DATA_DIR>/imports/cookies.json` (default `import-cookies` input) |
| `LINKEDIN_IMPORTS_DIR` | `<DATA_DIR>/imports/` |

The template `.env` explicitly specifies standard paths. If you change DATA_DIR,
update or remove the dependent path overrides so they follow the new default.
CLI argument paths such as export `--out` and cookie-import input remain relative
to the caller's working directory; they are not environment settings.

For an MCP client, pass the same selector in its environment:

```json
{
  "mcpServers": {
    "eanyra": {
      "command": "node",
      "args": ["/absolute/path/to/EANyra/src/core/mcp/start.js"],
      "env": { "INSTANCE_DIR": "instance-client-two", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

`instance/` is wholly ignored by Git. Custom instances outside that directory
need their own ignore rule if stored inside a Git repository. Back up the whole
instance and root `.env` with the application stopped to preserve settings,
content, sessions and the database together.
