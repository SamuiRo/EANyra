import { SUPPORTED_PLATFORMS } from './app.config.js';
import { normalizeTelegramChannel } from '../platforms/telegram/TelegramMessageParser.js';

/** The only X login session: BROWSER.dataPath + BROWSER.cookiesPath. */
export const DEFAULT_TWITTER_SESSION = 'default';

export function normalizeAccount(username, platform) {
  if (typeof username !== 'string') throw new Error('Account username must be a string.');
  const value = platform === 'telegram'
    ? normalizeTelegramChannel(username)
    : username.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_][a-z0-9_-]{0,127}$/.test(value) &&
      !(platform === 'telegram' && /^-100\d+$/.test(value))) {
    throw new Error(`Invalid ${platform} username: ${username}`);
  }
  return value;
}

/**
 * Validate a collection selection shared by CLI, MCP and the orchestrator.
 * `account` (one) and `accounts` (several) are merged into one normalized list.
 */
export function normalizeSelection({ platform, account, accounts } = {}) {
  if (platform && !SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  if (accounts !== undefined && !Array.isArray(accounts)) throw new Error('accounts must be an array of usernames.');
  const requested = [...(accounts ?? []), ...(account ? [account] : [])];
  if (requested.length && !platform) throw new Error('A platform is required when selecting an account.');
  const usernames = [...new Set(requested.map(name => normalizeAccount(name, platform)))];
  return { platform, accounts: usernames.length ? usernames : undefined };
}

export function validateAccounts(entries) {
  if (!Array.isArray(entries)) throw new Error('Accounts config must be a JSON array.');
  const keys = new Set();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Account entry ${index + 1} must be an object.`);
    }
    const platform = entry.platform ?? 'twitter';
    if (!SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
    const username = normalizeAccount(entry.username, platform);
    for (const field of ['active', 'archive', 'publish_enabled']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
        throw new Error(`${platform}/${username}: ${field} must be boolean.`);
      }
    }
    if (entry.publish_enabled === true && platform !== 'telegram') {
      throw new Error(`${platform}/${username}: publishing is supported only for Telegram.`);
    }
    if (entry.session !== undefined) {
      if (platform !== 'twitter') throw new Error(`${platform}/${username}: session is supported only for Twitter.`);
      // Placeholder for per-profile X logins: only the shared session exists today.
      if (entry.session !== DEFAULT_TWITTER_SESSION) {
        throw new Error(`${platform}/${username}: session "${entry.session}" is not available. Only "${DEFAULT_TWITTER_SESSION}" is supported for now.`);
      }
    }
    if (entry.display_name !== undefined && typeof entry.display_name !== 'string') {
      throw new Error(`${platform}/${username}: display_name must be a string.`);
    }
    const key = `${platform}/${username}`;
    if (keys.has(key)) throw new Error(`Duplicate account: ${key}`);
    keys.add(key);
    return { ...entry, username, platform };
  });
}
