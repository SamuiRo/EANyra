/**
 * instance/notifications.json — where problem alerts go and when.
 * Holds no secrets: the bot token and the Discord webhook URL live in the
 * encrypted vault (telegram-bot/<bot>, discord-webhook/<name>).
 *
 * {
 *   "telegram": { "enabled": true, "bot": "default", "chat_id": "123456789" },
 *   "discord":  { "enabled": true, "webhook": "default" },
 *   "rules": { "auth_expiring_days": 3, "stale_hours": 48, "repeat_hours": 24, "notify_resolved": true }
 * }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PATHS } from './app.config.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DEFAULT_RULES = Object.freeze({
  auth_expiring_days: 3,   // warn before an X login cookie expires
  stale_hours: 48,         // an account not collected for this long
  repeat_hours: 24,        // remind about an unchanged problem at most this often
  notify_resolved: true,   // one message when a problem disappears
});

export function validateNotifyConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('notifications.json must be a JSON object.');
  const config = { telegram: null, discord: null, rules: { ...DEFAULT_RULES } };
  if (raw.telegram !== undefined && raw.telegram !== null) {
    const { enabled = true, bot = 'default', chat_id: chatId } = raw.telegram;
    if (typeof enabled !== 'boolean') throw new Error('telegram.enabled must be true or false.');
    if (typeof bot !== 'string' || !NAME.test(bot)) throw new Error('telegram.bot must be a bot name such as "default".');
    if (!(typeof chatId === 'string' || Number.isInteger(chatId)) || !/^-?\d+$|^@[A-Za-z0-9_]{4,}$/.test(String(chatId))) {
      throw new Error('telegram.chat_id must be a numeric chat id (run `npm run nyra -- notify telegram-chat`).');
    }
    config.telegram = { enabled, bot, chat_id: String(chatId) };
  }
  if (raw.discord !== undefined && raw.discord !== null) {
    const { enabled = true, webhook = 'default' } = raw.discord;
    if (typeof enabled !== 'boolean') throw new Error('discord.enabled must be true or false.');
    if (typeof webhook !== 'string' || !NAME.test(webhook)) throw new Error('discord.webhook must be a webhook name such as "default".');
    config.discord = { enabled, webhook };
  }
  for (const [key, value] of Object.entries(raw.rules ?? {})) {
    if (!(key in DEFAULT_RULES)) throw new Error(`rules.${key} is not a known rule.`);
    if (typeof DEFAULT_RULES[key] === 'boolean' ? typeof value !== 'boolean' : !(Number.isFinite(value) && value >= 0)) {
      throw new Error(`rules.${key} must be ${typeof DEFAULT_RULES[key] === 'boolean' ? 'true or false' : 'a non-negative number'}.`);
    }
    config.rules[key] = value;
  }
  return config;
}

/** @returns {Promise<object|null>} null when the file does not exist */
export async function loadNotifyConfig(filePath = PATHS.notificationsConfig) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return validateNotifyConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`, { cause: error });
  }
}

/** Merge a change into the file (creating it), validating the result. */
export async function updateNotifyConfig(change, filePath = PATHS.notificationsConfig) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = { ...current, ...change };
  validateNotifyConfig(next);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, filePath);
  return next;
}
