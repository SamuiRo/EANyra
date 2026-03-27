import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { BROWSER } from './config/app.config.js';
import { ensureDir, print } from './shared/utils.js';

const COOKIES_IMPORT_PATH = process.argv[2];
if (!COOKIES_IMPORT_PATH) {
  console.error('Usage: node src/import-cookies.js <path-to-cookies.json>');
  process.exit(1);
}

async function main() {
  const raw     = await fs.readFile(path.resolve(COOKIES_IMPORT_PATH), 'utf-8');
  const cookies = JSON.parse(raw);

  // Cookie-Editor / EditThisCookie формат → Playwright формат
  const mapped = cookies.map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain ?? '.twitter.com',
    path:     c.path ?? '/',
    expires:  c.expirationDate ?? c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure:   c.secure   ?? true,
    sameSite: c.sameSite === 'no_restriction' ? 'None'
            : c.sameSite === 'lax'            ? 'Lax'
            : c.sameSite === 'strict'         ? 'Strict'
            : 'None',
  }));

  await ensureDir(BROWSER.dataPath);

  const context = await chromium.launchPersistentContext(BROWSER.dataPath, {
    headless:   true,
    userAgent:  BROWSER.userAgent,
    viewport:   BROWSER.viewport,
    locale:     BROWSER.locale,
    timezoneId: BROWSER.timezoneId,
    args: BROWSER.launchArgs,
  });

  await context.addCookies(mapped);

  // Перевіримо що auth_token є
  const saved    = await context.cookies();
  const authTok  = saved.find(c => c.name === 'auth_token');
  if (authTok) {
    print('auth_token знайдено — сесія збережена ✓', 'success');
  } else {
    print('auth_token НЕ знайдено — переконайся що ти залогінений у Chrome', 'warning');
  }

  await context.close();
  print(`Cookies збережено у: ${BROWSER.dataPath}`, 'success');
  print('Тепер можна запускати: npm run scrape', 'info');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});