import { chromium } from 'playwright';

import { BROWSER } from '../../config/app.config.js';
import {
  hasTwitterAuth,
  readCookieFile,
  saveCookieCache,
} from '../browser/sessionCookies.js';
import { ensureDir, print } from '../../shared/utils.js';

// Without an argument, import the file exported into the instance imports folder.
const cookiesImportPath = process.argv[2] ?? BROWSER.cookiesImportPath;

async function main() {
  print(`Reading cookies from: ${cookiesImportPath}`, 'system');
  const cookies = await readCookieFile(cookiesImportPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      `${cookiesImportPath} not found. Export x.com cookies there, or pass a path: ` +
      'npm run import-cookies -- <path-to-cookies.json>',
    );
  });

  await ensureDir(BROWSER.dataPath);
  const context = await chromium.launchPersistentContext(BROWSER.dataPath, { headless: true });
  try {
    await context.addCookies(cookies);
    if (!await hasTwitterAuth(context)) {
      throw new Error('auth_token is not valid for x.com. Check its domain and expiration.');
    }
  } finally {
    await context.close();
  }

  const cachePath = await saveCookieCache(cookies);
  print(`Imported ${cookies.length} cookies into: ${BROWSER.dataPath}`, 'success');
  print(`Saved local fallback cookies to: ${cachePath}`, 'success');
  print('Session is ready for `npm run scrape:twitter`.', 'info');
}

main().catch(error => {
  print(`Cookie import failed: ${error.message}`, 'error');
  process.exitCode = 1;
});
