import { chromium } from 'playwright';

import { BROWSER } from '../../config/app.config.js';
import {
  hasTwitterAuth,
  readCookieFile,
  saveCookieCache,
} from '../browser/sessionCookies.js';
import { ensureDir, print } from '../../shared/utils.js';

const cookiesImportPath = process.argv[2];
if (!cookiesImportPath) {
  console.error(
    'Usage: npm run import-cookies -- <path-to-cookies.json>\n' +
    '   or: node src/core/cli/import-cookies.js <path-to-cookies.json>',
  );
  process.exit(1);
}

async function main() {
  const cookies = await readCookieFile(cookiesImportPath);

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
