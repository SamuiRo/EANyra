/**
 * login.js — Interactive Twitter login helper
 *
 * Run ONCE to authenticate manually in a real browser window.
 * The session (cookies, localStorage) is saved to BROWSER_DATA_PATH
 * and reused by the scraper automatically on every subsequent run.
 *
 * Usage:
 *   node src/login.js
 *
 * Steps:
 *   1. A Chrome window will open → twitter.com/login
 *   2. Log in manually (including 2FA if needed)
 *   3. Wait until your feed is fully loaded
 *   4. Press ENTER in the terminal to save the session and close
 */

import { chromium } from 'playwright';
import readline     from 'readline';
import fs           from 'fs/promises';
import path         from 'path';
import { BROWSER, TWITTER } from './config/app.config.js';
import { banner, print, ensureDir } from './shared/utils.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(prompt, () => { rl.close(); resolve(); }),
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  banner('EANyra — Login Helper', 'One-time manual authentication');

  await ensureDir(BROWSER.dataPath);

  print('Launching browser in HEADFUL mode...', 'system');

  // For headful login we strip --use-gl=swiftshader — it is a headless renderer
  // flag that Twitter's bot-detection recognises even in a visible window.
  const headfulArgs = [
    ...BROWSER.launchArgs.filter(arg => arg !== '--use-gl=swiftshader'),
    `--window-size=${BROWSER.viewport.width},${BROWSER.viewport.height}`,
  ];

  const context = await chromium.launchPersistentContext(BROWSER.dataPath, {
    headless:   false,
    userAgent:  BROWSER.userAgent,
    // viewport:   BROWSER.viewport,
    // locale:     BROWSER.locale,
    // timezoneId: BROWSER.timezoneId,
    // args:       headfulArgs,
    // bypassCSP:         false,
    // ignoreHTTPSErrors: false,
    // permissions: ['geolocation', 'notifications'],
  });

  // ── Apply full stealth scripts (same as Browser.js) ───────────────────────
  // login.js previously only patched navigator.webdriver — Twitter's login flow
  // checks several other signals (plugins, canvas, WebGL, window.chrome) before
  // even showing the password field. Applying the full set here removes those
  // signals during the manual login session.
  await context.addInitScript(() => {
    // 1. Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // 2. Restore plugin array (headless has 0 plugins)
    const fakePlugins = [
      { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client',      filename: 'internal-nacl-plugin' },
    ];
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        fakePlugins.item      = i => fakePlugins[i];
        fakePlugins.namedItem = n => fakePlugins.find(p => p.name === n) ?? null;
        fakePlugins.refresh   = () => {};
        return fakePlugins;
      },
    });

    // 3. Language consistency
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    // 4. Permissions API — report "prompt" instead of "denied"
    const originalQuery = window.Permissions?.prototype?.query;
    if (originalQuery) {
      window.Permissions.prototype.query = function (params) {
        const alwaysPrompt = ['notifications', 'geolocation', 'camera', 'microphone'];
        if (alwaysPrompt.includes(params?.name)) {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return originalQuery.call(this, params);
      };
    }

    // 5. Canvas fingerprint noise
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 200) {
          imageData.data[i] ^= 1;
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return originalToDataURL.call(this, type, quality);
    };

    // 6. WebGL renderer strings
    const patchWebGL = (cls) => {
      const original = cls.prototype.getParameter;
      cls.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return original.call(this, parameter);
      };
    };
    patchWebGL(WebGLRenderingContext);
    if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext);

    // 7. window.chrome object
    if (!window.chrome) {
      window.chrome = { app: { isInstalled: false }, runtime: {} };
    }

    // 8. Consistent screen dimensions
    Object.defineProperty(screen, 'availWidth',  { get: () => window.innerWidth  });
    Object.defineProperty(screen, 'availHeight', { get: () => window.innerHeight });
  });

  const page = await context.newPage();

  print(`Navigating to ${TWITTER.loginUrl}`, 'info');
  await page.goto(TWITTER.loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout:   BROWSER.navigationTimeoutMs,
  });

  console.log('\n');
  print('═══════════════════════════════════════════════════════', 'system');
  print('  A browser window has opened.', 'system');
  print('  1. Log in to your Twitter account (2FA is fine)', 'system');
  print('  2. Wait until your home feed is fully loaded', 'system');
  print('  3. Come back here and press ENTER to save the session', 'system');
  print('═══════════════════════════════════════════════════════', 'system');
  console.log('\n');

  await waitForEnter('  → Press ENTER when logged in and feed is visible: ');

  // Verify we landed on the feed
  const currentUrl = page.url();
  const isLoggedIn = currentUrl.includes('/home') || currentUrl.includes('twitter.com');
  if (!isLoggedIn) {
    print(`Warning: current URL is "${currentUrl}" — session may not be saved correctly.`, 'warning');
  }

  // Export cookies for reference / manual inspection
  const cookies     = await context.cookies();
  const cookiesPath = path.resolve(BROWSER.cookiesPath);
  await ensureDir(path.dirname(cookiesPath));
  await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2), 'utf-8');

  print(`Session saved to: ${BROWSER.dataPath}`, 'success');
  print(`Cookies exported to: ${cookiesPath}`, 'success');
  print(`Found ${cookies.length} cookies.`, 'data');

  const authCookie = cookies.find(c => c.name === 'auth_token');
  if (authCookie) {
    print('auth_token cookie found — login successful ✓', 'success');
  } else {
    print(
      'auth_token cookie NOT found — you may not be logged in properly. ' +
      'Try running login.js again.',
      'warning',
    );
  }

  await context.close();

  print('Done! You can now run the scraper:', 'success');
  print('  npm run scrape   → single run', 'info');
  print('  npm start        → daemon mode (scheduled)', 'info');
}

main().catch(err => {
  print(`Login script failed: ${err.message}`, 'error');
  console.error(err);
  process.exit(1);
});