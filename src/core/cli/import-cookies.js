import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

import { BROWSER } from '../../config/app.config.js';
import { ensureDir, print } from '../../shared/utils.js';

const cookiesImportPath = process.argv[2];
if (!cookiesImportPath) {
  console.error(
    'Usage: npm run import-cookies -- <path-to-cookies.json>\n' +
    '   or: node src/core/cli/import-cookies.js <path-to-cookies.json>',
  );
  process.exit(1);
}

function normalizeSameSite(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[_-]/g, '');
  if (normalized === 'lax') return 'Lax';
  if (normalized === 'strict') return 'Strict';
  return 'None';
}

function normalizeCookie(cookie) {
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

async function main() {
  const raw = await fs.readFile(path.resolve(cookiesImportPath), 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Cookie file must contain a non-empty JSON array.');
  }

  const cookies = parsed.map(normalizeCookie);
  if (!cookies.some(cookie => cookie.name === 'auth_token')) {
    throw new Error('Cookie file does not contain an auth_token cookie.');
  }

  await ensureDir(BROWSER.dataPath);
  const context = await chromium.launchPersistentContext(BROWSER.dataPath, { headless: true });
  try {
    await context.addCookies(cookies);
    const saved = await context.cookies('https://x.com');
    if (!saved.some(cookie => cookie.name === 'auth_token')) {
      throw new Error('auth_token is not valid for x.com. Check its domain and expiration.');
    }
  } finally {
    await context.close();
  }

  print(`Imported ${cookies.length} cookies into: ${BROWSER.dataPath}`, 'success');
  print('Session is ready for `npm run scrape:twitter`.', 'info');
}

main().catch(error => {
  print(`Cookie import failed: ${error.message}`, 'error');
  process.exitCode = 1;
});
