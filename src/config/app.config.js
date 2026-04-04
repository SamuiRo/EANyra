import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

import pkg from '../../package.json' with { type: 'json' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the project root (two levels up from src/config/) */
const PROJECT_ROOT = path.resolve(__dirname, '../../');

/** Default data directory: <project_root>/data */
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

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

export const NODE_ENV = process.env.NODE_ENV ?? 'production';
export const PKG = pkg;

export const MCP_PORT = envNumber('MCP_PORT', 3001);
export const MCP_HOST = process.env.MCP_HOST ?? '127.0.0.1';
export const MCP_TRANSPORT = process.env.MCP_TRANSPORT ?? 'stdio';

export const SCHEDULER = {
  cronSchedule: process.env.CRON_SCHEDULE ?? '0 8 * * *',
  runOnStartup: envBoolean('RUN_ON_STARTUP', false),
};

export const DB = {
  storagePath: process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : path.join(DATA_DIR, 'pot.sqlite'),
};

export const BROWSER = {
  dataPath: process.env.BROWSER_DATA_PATH
    ? path.resolve(process.cwd(), process.env.BROWSER_DATA_PATH)
    : path.join(DATA_DIR, 'nyra'),
  cookiesPath: process.env.BROWSER_COOKIES_PATH
    ? path.resolve(process.cwd(), process.env.BROWSER_COOKIES_PATH)
    : path.join(DATA_DIR, 'cookies.json'),
  // Default true — headful mode only for debugging or manual login
  headless: envBoolean('BROWSER_HEADLESS', true),
  navigationTimeoutMs: envNumber('BROWSER_NAV_TIMEOUT_MS', 30_000),
  selectorTimeoutMs: envNumber('BROWSER_SEL_TIMEOUT_MS', 15_000),
  userAgent: process.env.BROWSER_USER_AGENT ?? DEFAULT_USER_AGENT,
  viewport: {
    width: envNumber('BROWSER_VIEWPORT_WIDTH', 1280),
    height: envNumber('BROWSER_VIEWPORT_HEIGHT', 900),
  },
  locale: process.env.BROWSER_LOCALE ?? 'en-US',
  timezoneId: process.env.BROWSER_TIMEZONE ?? 'America/New_York',
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
  loginUrl: process.env.TWITTER_LOGIN_URL ?? 'https://x.com',
  // loginUrl: process.env.TWITTER_LOGIN_URL ?? 'https://x.com/login',
  homeUrl: process.env.TWITTER_HOME_URL ?? 'https://x.com/home',
};

export const SCRAPER = {
  /** How many posts to collect per account on a regular (daily) run. */
  postsPerAccount: envNumber('POSTS_PER_ACCOUNT', 20),

  /** Maximum posts to collect during the initial harvest of a new account. */
  initialPostsPerAccount: envNumber('INITIAL_POSTS_PER_ACCOUNT', 200),

  /**
   * Base delay (ms) between scroll steps on a single profile page.
   * Actual delay = scrollDelayMs + random jitter up to +800 ms (see humanBehavior).
   */
  scrollDelayMs: envNumber('SCROLL_DELAY_MS', 2_500),

  /** Minimum pause (ms) between scraping two consecutive accounts. Default: 5 min. */
  minDelayBetweenAccountsMs: envNumber('MIN_DELAY_BETWEEN_ACCOUNTS_MS', 5 * 60 * 1_000),

  /** Maximum pause (ms) between accounts. Default: 15 min. */
  maxDelayBetweenAccountsMs: envNumber('MAX_DELAY_BETWEEN_ACCOUNTS_MS', 15 * 60 * 1_000),

  /** Maximum scroll attempts before giving up on a single profile. */
  maxScrollAttempts: envNumber('MAX_SCROLL_ATTEMPTS', 30),

  // Prefer SCRAPER_NAV_TIMEOUT_MS; fall back to the shared BROWSER value.
  navigationTimeoutMs: envNumber('SCRAPER_NAV_TIMEOUT_MS', envNumber('BROWSER_NAV_TIMEOUT_MS', 30_000)),
  selectorTimeoutMs: envNumber('SCRAPER_SELECTOR_TIMEOUT_MS', envNumber('BROWSER_SEL_TIMEOUT_MS', 15_000)),
};