import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

import pkg from '../../package.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/** Absolute path to the project root (two levels up from src/config/) */
export const PROJECT_ROOT = path.resolve(__dirname, '../../');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}

function envPath(name, fallback) {
  const raw = process.env[name];
  return raw ? path.resolve(process.cwd(), raw) : fallback;
}

export const NODE_ENV = process.env.NODE_ENV ?? 'production';
export const PKG      = pkg;

export const SUPPORTED_PLATFORMS = ['twitter', 'github', 'linkedin'];

const DATA_DIR = envPath('DATA_DIR', path.join(PROJECT_ROOT, 'data'));

export const PATHS = {
  dataDir:         DATA_DIR,
  accountsConfig: envPath('ACCOUNTS_CONFIG_PATH', path.join(PROJECT_ROOT, 'src', 'config', 'accounts.json')),
  contextDir:      envPath('CONTEXT_DIR', path.join(PROJECT_ROOT, 'src', 'context')),
  exportsDir:      envPath('EXPORTS_DIR', path.join(DATA_DIR, 'exports')),
};

export const MCP = {
  port:           envNumber('MCP_PORT', 3001),
  host:           process.env.MCP_HOST         ?? '127.0.0.1',
  transport:      process.env.MCP_TRANSPORT    ?? 'stdio',
  route:          process.env.MCP_ROUTE        ?? '/mcp',
  healthRoute:    process.env.MCP_HEALTH_ROUTE ?? '/health',
  exportMaxChars: envNumber('MCP_EXPORT_MAX_CHARS', 80_000),
  queryMaxRecords: envNumber('MCP_QUERY_MAX_RECORDS', 100),
  defaultPostLimit: envNumber('MCP_DEFAULT_POST_LIMIT', 20),
  defaultSignalLimit: envNumber('MCP_DEFAULT_SIGNAL_LIMIT', 30),
  defaultStatsDays: envNumber('MCP_DEFAULT_STATS_DAYS', 30),
  defaultStatusHistory: envNumber('MCP_DEFAULT_STATUS_HISTORY', 5),
  maxStatusHistory: envNumber('MCP_MAX_STATUS_HISTORY', 20),
};

export const SCHEDULER = {
  cronSchedule: process.env.CRON_SCHEDULE ?? '0 8 * * *',
  runOnStartup: envBoolean('RUN_ON_STARTUP', false),
};

export const DB = {
  storagePath: envPath('DB_PATH', path.join(DATA_DIR, 'pot.sqlite')),
  pool: {
    max:     envNumber('DB_POOL_MAX', 5),
    min:     envNumber('DB_POOL_MIN', 0),
    acquire: envNumber('DB_POOL_ACQUIRE_MS', 30_000),
    idle:    envNumber('DB_POOL_IDLE_MS', 10_000),
  },
};

export const BROWSER = {
  dataPath:             envPath('BROWSER_DATA_PATH', path.join(DATA_DIR, 'nyra')),
  cookiesPath:          envPath('BROWSER_COOKIES_PATH', path.join(DATA_DIR, 'cookies.json')),
  headless:            envBoolean('BROWSER_HEADLESS', true),
  navigationTimeoutMs: envNumber('BROWSER_NAV_TIMEOUT_MS', 30_000),
  selectorTimeoutMs:   envNumber('BROWSER_SEL_TIMEOUT_MS', 15_000),
  userAgent:           process.env.BROWSER_USER_AGENT ?? DEFAULT_USER_AGENT,
  viewport: {
    width:  envNumber('BROWSER_VIEWPORT_WIDTH',  1280),
    height: envNumber('BROWSER_VIEWPORT_HEIGHT',  900),
  },
  locale:     process.env.BROWSER_LOCALE   ?? 'en-US',
  timezoneId: process.env.BROWSER_TIMEZONE ?? 'America/New_York',
  loginChannel: process.env.BROWSER_LOGIN_CHANNEL ?? 'chrome',
  launchArgs: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-webrtc-encryption',
    '--enforce-webrtc-ip-permission-check',
    '--use-gl=swiftshader',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  blockedDomains: [
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'amplitude.com',
    'segment.io',
    'sentry.io',
    'ads-twitter.com',
    'analytics.twitter.com',
  ],
};

export const TWITTER = {
  baseUrl:  process.env.TWITTER_BASE_URL  ?? 'https://x.com',
  loginUrl: process.env.TWITTER_LOGIN_URL ?? 'https://x.com/i/flow/login',
  homeUrl:  process.env.TWITTER_HOME_URL  ?? 'https://x.com/home',
};

export const SCRAPER = {
  postsPerAccount:           envNumber('POSTS_PER_ACCOUNT', 20),
  initialPostsPerAccount:    envNumber('INITIAL_POSTS_PER_ACCOUNT', 200),
  scrollDelayMs:             envNumber('SCROLL_DELAY_MS', 2_500),
  minDelayBetweenAccountsMs: envNumber('MIN_DELAY_BETWEEN_ACCOUNTS_MS', 5 * 60 * 1_000),
  maxDelayBetweenAccountsMs: envNumber('MAX_DELAY_BETWEEN_ACCOUNTS_MS', 15 * 60 * 1_000),
  maxScrollAttempts:         envNumber('MAX_SCROLL_ATTEMPTS', 30),
  navigationTimeoutMs:       envNumber('SCRAPER_NAV_TIMEOUT_MS', envNumber('BROWSER_NAV_TIMEOUT_MS', 30_000)),
  selectorTimeoutMs:         envNumber('SCRAPER_SELECTOR_TIMEOUT_MS', envNumber('BROWSER_SEL_TIMEOUT_MS', 15_000)),
  wakeUpMaxMs:               envNumber('SCRAPER_WAKE_UP_MAX_MS', 3 * 60 * 1_000),
};

export const EXPORT = {
  defaultDays: envNumber('EXPORT_DEFAULT_DAYS', 7),
  maxRecords:  envNumber('EXPORT_MAX_RECORDS', 100),
  sections:    ['context', 'projects', 'posts', 'signals'],
};

// ─── GitHub ───────────────────────────────────────────────────────────────────

export const GITHUB = {
  /**
   * Personal Access Token — required scopes: read:user, public_repo.
   * Generate at: https://github.com/settings/tokens
   */
  token: process.env.GITHUB_TOKEN ?? '',
  apiBaseUrl: process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
  apiVersion: process.env.GITHUB_API_VERSION ?? '2022-11-28',
  userAgent:  process.env.GITHUB_USER_AGENT  ?? `${PKG.name}/${PKG.version}`,

  /** How many days back to look for events on each run. */
  lookbackDays:           envNumber('GITHUB_LOOKBACK_DAYS', 8),

  /** Max public repos to inspect per account (sorted by push date desc). */
  reposPerAccount:        envNumber('GITHUB_REPOS_PER_ACCOUNT', 30),

  /** Max releases to fetch per repo per run. */
  releasesPerRepo:        envNumber('GITHUB_RELEASES_PER_REPO', 10),

  /** Max commits to fetch per repo per run (within the lookback window). */
  commitsPerRepo:         envNumber('GITHUB_COMMITS_PER_REPO', 100),

  /** Max commit messages stored in a commit_batch body. */
  commitMessagesPerBatch: envNumber('GITHUB_COMMIT_MESSAGES_PER_BATCH', 10),
};

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

export const LINKEDIN = {
  /**
   * Directory where LinkedIn CSV export files are placed.
   * Default: <project_root>/data/imports/
   *
   * How to get the files:
   *   linkedin.com → Me → Settings & Privacy → Data Privacy
   *   → "Get a copy of your data" → select Posts (+ Profile)
   *   Unzip and drop Shares.csv (and Profile.csv) into this folder.
   */
  importsDir: envPath('LINKEDIN_IMPORTS_DIR', path.join(DATA_DIR, 'imports')),

  /** Expected filename for the posts export inside importsDir. */
  sharesFile:  process.env.LINKEDIN_SHARES_FILE  ?? 'Shares.csv',

  /** Expected filename for the profile export inside importsDir. */
  profileFile: process.env.LINKEDIN_PROFILE_FILE ?? 'Profile.csv',
};
