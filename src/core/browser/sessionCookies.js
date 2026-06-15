import fs from 'fs/promises';
import path from 'path';

import { BROWSER, TWITTER } from '../../config/app.config.js';
import { ensureDir } from '../../shared/utils.js';

function normalizeSameSite(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[_-]/g, '');
  if (normalized === 'lax') return 'Lax';
  if (normalized === 'strict') return 'Strict';
  return 'None';
}

export function normalizeCookie(cookie) {
  if (!cookie?.name || cookie.value === undefined) {
    throw new Error('Every cookie must contain name and value fields.');
  }

  const expires = Number(cookie.expirationDate ?? cookie.expires ?? -1);
  return {
    name: cookie.name,
    value: String(cookie.value),
    domain: cookie.domain ?? '.x.com',
    path: cookie.path ?? '/',
    expires: Number.isFinite(expires) ? expires : -1,
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? true,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

export async function readCookieFile(filePath) {
  const raw = await fs.readFile(path.resolve(filePath), 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Cookie file must contain a non-empty JSON array.');
  }

  const cookies = parsed.map(normalizeCookie);
  if (!cookies.some(cookie => cookie.name === 'auth_token')) {
    throw new Error('Cookie file does not contain an auth_token cookie.');
  }
  return cookies;
}

export async function saveCookieCache(cookies, filePath = BROWSER.cookiesPath) {
  const cookiePath = path.resolve(filePath);
  await ensureDir(path.dirname(cookiePath));
  await fs.writeFile(cookiePath, JSON.stringify(cookies, null, 2), 'utf-8');
  return cookiePath;
}

export async function hasTwitterAuth(context) {
  const cookies = await context.cookies(TWITTER.baseUrl);
  return cookies.some(cookie => cookie.name === 'auth_token');
}

export async function restoreCachedTwitterAuth(context, filePath = BROWSER.cookiesPath) {
  if (await hasTwitterAuth(context)) return false;

  const cookies = await readCookieFile(filePath);
  await context.addCookies(cookies);
  if (!await hasTwitterAuth(context)) {
    throw new Error('Cached auth_token is not valid for x.com.');
  }
  return true;
}
