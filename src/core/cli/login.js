/**
 * Interactive Twitter/X login helper.
 *
 * Uses a normal headful Chrome session without scraper stealth patches or a
 * custom user agent. The persistent profile is shared with the scraper.
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

import { BROWSER, TWITTER } from '../../config/app.config.js';
import { banner, ensureDir, print } from '../../shared/utils.js';

function waitForEnter(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive login requires a terminal. Use `npm run import-cookies -- <file>` instead.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function launchLoginContext() {
  const options = {
    headless: false,
    viewport: null,
    args: [`--window-size=${BROWSER.viewport.width},${BROWSER.viewport.height}`],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (BROWSER.loginChannel) {
    try {
      print(`Opening system browser channel "${BROWSER.loginChannel}"...`, 'system');
      return await chromium.launchPersistentContext(BROWSER.dataPath, {
        ...options,
        channel: BROWSER.loginChannel,
      });
    } catch (error) {
      print(
        `Could not open "${BROWSER.loginChannel}" (${error.message}). Falling back to bundled Chromium.`,
        'warning',
      );
    }
  }

  return chromium.launchPersistentContext(BROWSER.dataPath, options);
}

async function exportCookies(context) {
  const cookies = await context.cookies();
  const cookiesPath = path.resolve(BROWSER.cookiesPath);
  await ensureDir(path.dirname(cookiesPath));
  await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2), 'utf-8');
  return { cookies, cookiesPath };
}

function resolveLoginUrl() {
  try {
    const configuredUrl = new URL(TWITTER.loginUrl);
    if (configuredUrl.pathname === '/' || configuredUrl.pathname === '') {
      return `${TWITTER.baseUrl}/i/flow/login`;
    }
  } catch {
    // Playwright will report malformed custom URLs during navigation.
  }

  return TWITTER.loginUrl;
}

async function main() {
  banner('EANyra - Login Helper', 'Interactive Twitter/X authentication');
  await ensureDir(BROWSER.dataPath);

  let context;
  try {
    context = await launchLoginContext();
    const page = context.pages()[0] ?? await context.newPage();
    const loginUrl = resolveLoginUrl();

    print(`Navigating to ${loginUrl}`, 'info');
    try {
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER.navigationTimeoutMs,
      });
    } catch (error) {
      print(`Initial navigation did not finish: ${error.message}`, 'warning');
      print('The browser remains open; navigate to x.com/login manually if needed.', 'info');
    }

    print('Log in in the browser, including any email/2FA challenge.', 'system');
    print('Wait until the home feed is visible, then return to this terminal.', 'system');
    await waitForEnter('Press ENTER after login is complete: ');

    const { cookies, cookiesPath } = await exportCookies(context);
    const authCookie = cookies.find(cookie => cookie.name === 'auth_token');

    if (!authCookie) {
      throw new Error(
        'No auth_token cookie was found. Login was not completed. ' +
        'You can retry or use `npm run import-cookies -- <file>`.',
      );
    }

    print(`Session profile saved to: ${BROWSER.dataPath}`, 'success');
    print(`Cookies exported to: ${cookiesPath}`, 'success');
    print(`Found ${cookies.length} cookies, including auth_token.`, 'data');
  } finally {
    if (context) await context.close();
  }
}

main().catch(error => {
  print(`Login failed: ${error.message}`, 'error');
  process.exitCode = 1;
});
