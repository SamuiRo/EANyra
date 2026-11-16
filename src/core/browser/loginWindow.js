/**
 * A normal headful browser window for logging into X by hand, shared by the
 * CLI (`npm run login`) and the web UI. It runs in a throwaway profile; only
 * the storage state is kept (encrypted in the vault by the caller).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

import { BROWSER, TWITTER } from '../../config/app.config.js';
import { print } from '../../shared/utils.js';

export function loginUrl() {
  try {
    const configured = new URL(TWITTER.loginUrl);
    if (configured.pathname === '/' || configured.pathname === '') return `${TWITTER.baseUrl}/i/flow/login`;
  } catch {
    // Playwright reports malformed custom URLs during navigation.
  }
  return TWITTER.loginUrl;
}

/**
 * Open the login window. Without scraper stealth patches or a custom user
 * agent; prefers the installed Chrome channel.
 * @returns {Promise<{ context: import('playwright').BrowserContext, profileDir: string,
 *                     close: () => Promise<void> }>}
 */
export async function openLoginWindow({ launcher = chromium } = {}) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eanyra-login-'));
  const options = {
    headless: false,
    viewport: null,
    args: [`--window-size=${BROWSER.viewport.width},${BROWSER.viewport.height}`],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let context;
  try {
    if (BROWSER.loginChannel) {
      try {
        context = await launcher.launchPersistentContext(profileDir, { ...options, channel: BROWSER.loginChannel });
      } catch (error) {
        print(`Could not open "${BROWSER.loginChannel}" (${error.message}). Falling back to bundled Chromium.`, 'warning');
      }
    }
    context ??= await launcher.launchPersistentContext(profileDir, options);
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(loginUrl(), { waitUntil: 'domcontentloaded', timeout: BROWSER.navigationTimeoutMs })
      .catch(error => print(`Login page did not finish loading: ${error.message}`, 'warning'));
  } catch (error) {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    context,
    profileDir,
    async close() {
      await context.close().catch(() => {});
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
