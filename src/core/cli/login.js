/**
 * Interactive Twitter/X login helper.
 *
 *   npm run login                       → session "default"
 *   npm run login -- --session brand-a  → session "brand-a"
 *
 * Uses a normal headful Chrome window without scraper stealth patches. The
 * window runs in a throwaway profile; after login only the storage state
 * (cookies + local storage) is kept, encrypted in the vault. The temporary
 * profile is deleted, so no plaintext login remains on disk.
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';

import { BROWSER, TWITTER } from '../../config/app.config.js';
import { Credentials, DEFAULT_SESSION } from '../secrets/Credentials.js';
import { assertSessionName } from '../secrets/Vault.js';
import { banner, print } from '../../shared/utils.js';

function waitForEnter(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error('Interactive login requires a terminal. Use `npm run import-cookies` instead.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function launchLoginContext(profileDir) {
  const options = {
    headless: false,
    viewport: null,
    args: [`--window-size=${BROWSER.viewport.width},${BROWSER.viewport.height}`],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (BROWSER.loginChannel) {
    try {
      print(`Opening system browser channel "${BROWSER.loginChannel}"...`, 'system');
      return await chromium.launchPersistentContext(profileDir, {
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

  return chromium.launchPersistentContext(profileDir, options);
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
  const { session } = new Command()
    .name('login')
    .description('Log into X in a browser window and store the session in the encrypted vault.')
    .option('--session <name>', 'Session name referenced by accounts.json "session"', DEFAULT_SESSION)
    .parse()
    .opts();
  assertSessionName(session);

  banner('EANyra - Login Helper', `Interactive Twitter/X authentication · session "${session}"`);
  print(
    'X may reject Playwright-controlled browsers. Cookie import is the recommended session setup.',
    'warning',
  );
  print(`Fallback: npm run import-cookies -- --session ${session}`, 'info');

  const credentials = await Credentials.open({ interactive: true });
  if (!credentials.encrypted) {
    print('No encrypted vault yet: cookies will be saved to the plaintext cookie cache. Run `npm run nyra -- vault init` first to encrypt them.', 'warning');
  }

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-login-'));
  let context;
  try {
    context = await launchLoginContext(profileDir);
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

    print('Log in in the browser with the account for this session, including any email/2FA challenge.', 'system');
    print('Wait until the home feed is visible, then return to this terminal.', 'system');
    await waitForEnter('Press ENTER after login is complete: ');

    const state = await context.storageState();
    if (!state.cookies.some(cookie => cookie.name === 'auth_token')) {
      throw new Error(
        'No auth_token cookie was found. Login was not completed. ' +
        `You can retry or use \`npm run import-cookies -- --session ${session}\`.`,
      );
    }

    await credentials.saveTwitterState(session, state);
    print(`X session "${session}" saved${credentials.encrypted ? ' to the encrypted vault' : ''} (${state.cookies.length} cookies).`, 'success');
    if (session !== DEFAULT_SESSION) {
      print(`Reference it from X accounts in accounts.json: "session": "${session}".`, 'info');
    }
  } finally {
    if (context) await context.close().catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  print(`Login failed: ${error.message}`, 'error');
  process.exitCode = 1;
});
