import { SUPPORTED_PLATFORMS } from './app.config.js';
import { SESSION_PLATFORMS } from '../platforms/catalog.js';
import { normalizeTelegramChannel } from '../platforms/telegram/TelegramMessageParser.js';

/** Login used when an account does not name one. */
export const DEFAULT_SESSION = 'default';
/** Platforms whose collection needs a login stored in the vault. */
export { SESSION_PLATFORMS };
const SESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IMPORT_FILE = /^[\w .()-]{1,128}\.csv$/i;

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

/** "twitter/Name" or "@name" with an explicit platform → { platform, username } */
export function parseAccountRef(ref, platform) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Account reference must be a non-empty string.');
  const [first, ...rest] = ref.trim().split('/');
  const resolvedPlatform = rest.length ? first.toLowerCase() : platform;
  if (!resolvedPlatform) throw new Error(`Account "${ref}" needs a platform, e.g. "twitter/${ref.replace(/^@/, '')}".`);
  if (!SUPPORTED_PLATFORMS.includes(resolvedPlatform)) throw new Error(`Unsupported platform in account "${ref}".`);
  const username = normalizeAccount(rest.length ? rest.join('/') : first, resolvedPlatform);
  return { platform: resolvedPlatform, username };
}

export const accountKey = ({ platform, username }) => `${platform}/${username}`;

/**
 * Validate a collection selection shared by CLI, MCP and the orchestrator.
 * `account` (one) and `accounts` (several) are merged into one normalized list
 * of "platform/username" keys. Entries are bare usernames of `platform`, or
 * "platform/username" refs, which may span platforms when `platform` is omitted.
 */
export function normalizeSelection({ platform, account, accounts } = {}) {
  if (platform && !SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  if (accounts !== undefined && !Array.isArray(accounts)) throw new Error('accounts must be an array of usernames.');
  const requested = [...(accounts ?? []), ...(account ? [account] : [])];
  const keys = [...new Set(requested.map(ref => {
    if (!platform && typeof ref === 'string' && !ref.includes('/')) {
      throw new Error('A platform is required when selecting an account.');
    }
    const target = parseAccountRef(ref, platform);
    if (platform && target.platform !== platform) {
      throw new Error(`Account ${ref} is not on the selected platform ${platform}.`);
    }
    return accountKey(target);
  }))];
  return { platform, accounts: keys.length ? keys : undefined };
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
      if (!SESSION_PLATFORMS.includes(platform)) {
        throw new Error(`${platform}/${username}: session is supported only for ${SESSION_PLATFORMS.join(', ')}.`);
      }
      if (typeof entry.session !== 'string' || !SESSION_NAME.test(entry.session)) {
        throw new Error(`${platform}/${username}: session must be a lowercase name like "brand-a".`);
      }
    }
    if (entry.bot !== undefined) {
      if (platform !== 'telegram') throw new Error(`${platform}/${username}: bot is supported only for Telegram.`);
      if (typeof entry.bot !== 'string' || !SESSION_NAME.test(entry.bot)) {
        throw new Error(`${platform}/${username}: bot must be a lowercase name like "news-bot".`);
      }
    }
    if (entry.publish_transport !== undefined) {
      if (platform !== 'telegram') throw new Error(`${platform}/${username}: publish_transport is supported only for Telegram.`);
      if (!['bot', 'mtproto'].includes(entry.publish_transport)) {
        throw new Error(`${platform}/${username}: publish_transport must be "bot" or "mtproto".`);
      }
    }
    if (entry.import_file !== undefined) {
      if (platform !== 'linkedin') throw new Error(`${platform}/${username}: import_file is supported only for LinkedIn.`);
      if (typeof entry.import_file !== 'string' || !IMPORT_FILE.test(entry.import_file)) {
        throw new Error(`${platform}/${username}: import_file must be a .csv file name inside the imports folder.`);
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

/** The login an account uses for collection (and MTProto publishing). */
export function sessionOf(entry) {
  return entry?.session ?? DEFAULT_SESSION;
}
