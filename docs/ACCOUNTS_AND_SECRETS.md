# Accounts, Sessions and Encryption

EANyra works with your own accounts. Each account in `instance/accounts.json`
names the **session** (login) it uses, and every session's credentials live in
one encrypted file, `instance/secrets.vault`, protected by a master password.

## Concepts

| Term | Meaning |
|---|---|
| Account | One profile, channel or repository owner in `accounts.json` |
| Session | One login on one platform, e.g. the X login of `brand_a` |
| Vault | `instance/secrets.vault`: all sessions and tokens, AES-256-GCM encrypted |
| Persona | Voice/topics grouping accounts across platforms (see the Context Guide) |

Accounts without `session` use the session named `default`.

| Secret | Created by | Used for |
|---|---|---|
| `twitter/<session>` | `npm run import-cookies -- --session <s>` or `npm run login -- --session <s>` | X collection |
| `telegram/<session>` | `npm run login:telegram -- --session <s>` | Telegram collection, MTProto publishing |
| `telegram-api/default` | `npm run nyra -- secrets set telegram-api` | Telegram API id/hash for every session |
| `telegram-bot/<bot>` | `npm run nyra -- secrets set telegram-bot <bot>` | Bot API publishing (`"bot"` field) |
| `github/<session>` | `npm run nyra -- secrets set github <s>` | GitHub collection |
| `discord-webhook/<name>` | `npm run nyra -- notify discord` | Problem alerts to Discord |
| `discord-bot/<session>` | `npm run nyra -- secrets set discord-bot <s>` | Reading Discord community channels |
| `mcp-token/default` | `npm run nyra -- mcp token` | MCP clients of `npm run serve -- --mcp` |

## Several own X accounts

```json
[
  { "username": "brand_a",  "platform": "twitter", "session": "brand-a" },
  { "username": "brand_b",  "platform": "twitter", "session": "brand-b" },
  { "username": "personal", "platform": "twitter", "session": "personal" }
]
```

For each session, export that account's `x.com` cookies from your normal
browser (where you are logged in as that account) and import them:

```bash
npm run import-cookies -- path/to/brand-a-cookies.json --session brand-a --delete-source
npm run nyra -- sessions
```

How collection uses sessions:

- One Chromium process; each session gets an isolated browser context, so
  cookies of different accounts never mix.
- Profiles are grouped by session. The long human-like pause
  (`MIN/MAX_DELAY_BETWEEN_ACCOUNTS_MS`, 5–15 min) applies only between profiles
  of the same login; switching to another login waits
  `MIN/MAX_DELAY_BETWEEN_SESSIONS_MS` (30–120 s). With one session per account,
  ten accounts take minutes instead of hours.
- A rejected or missing login skips only the accounts of that session; the
  run finishes as `partial` and names the failed session.
- After collecting, refreshed cookies and local storage are re-encrypted into
  the vault, so the stored login stays current.

Several accounts may still share one session (e.g. reading other profiles from
one login); then the long pause applies between them.

Publishing to X and LinkedIn is deliberately not automated. The AI prepares
the text; you publish it yourself.

## Telegram, GitHub, LinkedIn

- **Telegram collection:** `"session"` picks the MTProto login. API id/hash are
  shared by all sessions.
- **Telegram publishing:** `"publish_enabled": true` plus `"bot": "<name>"`
  (Bot API, default) or `"publish_transport": "mtproto"` (publishes as the
  account's `session`). `telegram_publisher_info` with `account` shows which bot
  a channel uses.
- **GitHub:** `"session"` picks the token, for accounts that need different
  tokens.
- **LinkedIn:** `"import_file": "Shares-brand-a.csv"` gives each account its own
  export file in `instance/data/imports/`.

## The vault

```bash
npm run nyra -- vault init      # create; imports plaintext secrets it finds
npm run nyra -- vault status    # secret names, remembered key, plaintext leftovers
```

- Key derivation: scrypt (N=2^17, r=8, p=1) with a random salt.
- Encryption: AES-256-GCM, new IV on every write; the header is authenticated,
  so editing KDF parameters or ciphertext makes the file unreadable rather than
  silently weaker.
- Writes are atomic and lock-protected; a login in one terminal and a scrape
  saving refreshed cookies cannot overwrite each other.
- Names of sessions and kinds are inside the ciphertext too.
- **The master password cannot be recovered.** Keep it in a password manager
  and back up `secrets.vault` together with the rest of `instance/`.

### Unlocking

Processes unlock the vault in this order:

1. Key handed over by the parent process over IPC (MCP scrape and publish
   workers; never via argv or environment).
2. `EANYRA_MASTER_PASSWORD` (removed from the environment once read). Prefer
   option 3: this variable keeps the password in plaintext wherever it is set.
3. **Remembered on this PC**: `npm run nyra -- vault remember` stores the vault
   key protected by Windows DPAPI for your Windows user. MCP, the scheduler and
   workers then unlock without a prompt. `vault forget` removes it;
   `vault change-password` invalidates and refreshes it.
4. Hidden prompt when a terminal is attached (CLI, `npm start`).

MCP needs the vault only for `scraper_run` and Telegram publishing/identity;
reading posts, signals and context works while it is locked.

### Moving from a plaintext `.env`

`vault init` imports `TELEGRAM_SESSION`, `TELEGRAM_API_ID/HASH`,
`TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, the X profile (`instance/data/nyra`) and
cookie cache into the `default` sessions. Until you purge them, the plaintext
copies are still used as a fallback and a warning reminds you. After checking
that `npm run scrape` works:

```bash
npm run nyra -- vault migrate --purge
```

This blanks those `.env` values and deletes the cookie files and the old X
browser profile. Without a vault, EANyra keeps working in legacy mode, but only
the `default` session from `.env` exists.

## What is and is not encrypted

| Data | Protection |
|---|---|
| Logins, tokens, API keys | Encrypted vault |
| Temporary login browser profile | Deleted right after `npm run login` |
| `pot.sqlite` (collected public posts, drafts, run history) | Not encrypted; contains published content, not credentials |
| `instance/context/*.yaml` (voice, bio, projects) | Not encrypted |

Database and context encryption at rest can be added later (SQLCipher or
encrypted file storage); use Windows BitLocker for full-disk protection today.
