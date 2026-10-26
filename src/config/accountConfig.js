import { SUPPORTED_PLATFORMS } from './app.config.js';
import { normalizeTelegramChannel } from '../platforms/telegram/TelegramMessageParser.js';

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
    if (entry.display_name !== undefined && typeof entry.display_name !== 'string') {
      throw new Error(`${platform}/${username}: display_name must be a string.`);
    }
    const key = `${platform}/${username}`;
    if (keys.has(key)) throw new Error(`Duplicate account: ${key}`);
    keys.add(key);
    return { ...entry, username, platform };
  });
}
