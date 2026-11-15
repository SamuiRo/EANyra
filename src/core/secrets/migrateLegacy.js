/**
 * Move plaintext credentials from the pre-vault layout into the vault:
 *
 *   root .env      TELEGRAM_SESSION, TELEGRAM_API_ID/HASH, TELEGRAM_BOT_TOKEN, GITHUB_TOKEN
 *   cookie cache   instance/data/cookies.json (X auth fallback)
 *   X profile      instance/data/nyra (persistent Playwright profile)
 *
 * Copying never overwrites a secret already in the vault. Purging (removing
 * the plaintext copies) is a separate, explicit step.
 */

import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';

import { BROWSER, GITHUB, PATHS, TELEGRAM } from '../../config/app.config.js';
import { readCookieFile } from '../browser/sessionCookies.js';
import { DEFAULT_SESSION } from './Vault.js';

export const LEGACY_ENV_KEYS = ['TELEGRAM_SESSION', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN'];

const exists = filePath => fs.access(filePath).then(() => true, () => false);

/** @returns {Promise<string[]>} human-readable list of what was imported */
export async function importLegacySecrets(vault, {
  telegram = TELEGRAM, githubToken = GITHUB.token, cookiesPath = BROWSER.cookiesPath,
  profileDir = BROWSER.dataPath, readProfileState = readPersistentProfileState,
} = {}) {
  const imported = [];
  const setIfMissing = async (kind, value, label) => {
    if (vault.get(kind, DEFAULT_SESSION)) return;
    await vault.set(kind, DEFAULT_SESSION, value);
    imported.push(label);
  };

  if (telegram.session) await setIfMissing('telegram', { session: telegram.session }, 'TELEGRAM_SESSION → telegram/default');
  if (telegram.apiId && telegram.apiHash) {
    await setIfMissing('telegram-api', { api_id: telegram.apiId, api_hash: telegram.apiHash }, 'TELEGRAM_API_ID/HASH → telegram-api/default');
  }
  if (telegram.botToken) await setIfMissing('telegram-bot', { token: telegram.botToken }, 'TELEGRAM_BOT_TOKEN → telegram-bot/default');
  if (githubToken) await setIfMissing('github', { token: githubToken }, 'GITHUB_TOKEN → github/default');

  if (!vault.get('twitter', DEFAULT_SESSION)) {
    // The live profile also carries local storage; the cookie cache is the fallback.
    let state = null;
    if (await exists(profileDir)) state = await readProfileState(profileDir).catch(() => null);
    if (!state?.cookies?.some(cookie => cookie.name === 'auth_token') && await exists(cookiesPath)) {
      state = { cookies: await readCookieFile(cookiesPath), origins: [] };
    }
    if (state?.cookies?.some(cookie => cookie.name === 'auth_token')) {
      await vault.set('twitter', DEFAULT_SESSION, state);
      imported.push('X login (browser profile / cookie cache) → twitter/default');
    }
  }
  return imported;
}

/** Plaintext leftovers that purge would remove. */
export async function findLegacyPlaintext({
  envFile = PATHS.envFile, cookiesPath = BROWSER.cookiesPath,
  cookiesImportPath = BROWSER.cookiesImportPath, profileDir = BROWSER.dataPath,
} = {}) {
  const found = [];
  const raw = await fs.readFile(envFile, 'utf8').catch(() => '');
  const values = dotenv.parse(raw);
  const envKeys = LEGACY_ENV_KEYS.filter(key => values[key] && values[key] !== '0');
  if (envKeys.length) found.push({ type: 'env', path: envFile, keys: envKeys });
  for (const filePath of [cookiesPath, cookiesImportPath]) {
    if (await exists(filePath)) found.push({ type: 'file', path: filePath });
  }
  if (await exists(profileDir)) found.push({ type: 'dir', path: profileDir });
  return found;
}

export async function purgeLegacyPlaintext(found) {
  for (const item of found) {
    if (item.type === 'env') await blankEnvFile(item.path, item.keys);
    else if (item.type === 'file') await fs.unlink(item.path);
    else if (item.type === 'dir') await fs.rm(item.path, { recursive: true, force: true });
  }
}

/** Set the given keys to empty values, leaving every other line untouched. */
export function blankEnvKeys(raw, keys) {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const pattern = new RegExp(`^[\\t ]*(?:export[\\t ]+)?(${keys.join('|')})[\\t ]*=`);
  const updated = raw.split(/\r?\n/).map(line => {
    const match = line.match(pattern);
    return match ? `${match[1]}=` : line;
  }).join(newline);
  const before = dotenv.parse(raw);
  const after = dotenv.parse(updated);
  for (const [key, value] of Object.entries(before)) {
    const expected = keys.includes(key) ? '' : value;
    if ((after[key] ?? '') !== expected) {
      throw new Error(`Cannot blank secrets in .env without changing ${key}; edit it manually.`);
    }
  }
  return updated;
}

async function blankEnvFile(envFile, keys) {
  const updated = blankEnvKeys(await fs.readFile(envFile, 'utf8'), keys);
  const temporary = `${envFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, envFile);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readPersistentProfileState(profileDir) {
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(profileDir, { headless: true });
  try {
    return await context.storageState();
  } finally {
    await context.close();
  }
}
