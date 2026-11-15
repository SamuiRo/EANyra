/**
 * src/core/browser/Browser.js
 *
 * One Playwright Chromium process with an isolated context per X session.
 *
 * Auth strategy:
 *   Nothing is kept in a plaintext browser profile. Each session's cookies and
 *   local storage are loaded from the encrypted vault (see core/secrets) into
 *   a fresh context, and the refreshed state is written back after the run.
 *   Sessions never share cookies, so several own X accounts stay separated.
 *
 * Anti-detection layers:
 *   1. Chromium launch args disable automation signals at the process level.
 *   2. Init scripts patch navigator/window APIs before page JavaScript runs.
 *   3. Browser environment uses a fixed UA, viewport, locale, and timezone.
 *   4. humanBehavior.js handles human-like interaction.
 */

import { chromium }          from 'playwright';
import { BROWSER, TWITTER }  from '../../config/app.config.js';
import { print }             from '../../shared/utils.js';

export class Browser {
  #browser = null;

  async launch() {
    print('Launching browser…', 'system');
    this.#browser = await chromium.launch({
      headless: BROWSER.headless,
      // These flags are applied at the process level before page JavaScript runs.
      args: [
        ...BROWSER.launchArgs,
        `--window-size=${BROWSER.viewport.width},${BROWSER.viewport.height}`,
      ],
    });
    print(`Browser ready · ${BROWSER.viewport.width}x${BROWSER.viewport.height}`, 'success');
    return this;
  }

  /**
   * Open an isolated context for one X login.
   * @param {string} name
   * @param {{cookies: object[], origins: object[]}} storageState
   */
  async openSession(name, storageState) {
    if (!this.#browser) throw new Error('Browser not launched. Call launch() first.');
    if (!storageState?.cookies?.some(cookie => cookie.name === 'auth_token')) {
      throw Object.assign(
        new Error(`X session "${name}" is not logged in. Run \`npm run login -- --session ${name}\` or \`npm run import-cookies -- --session ${name}\`.`),
        { code: 'TWITTER_SESSION_MISSING' },
      );
    }
    const context = await this.#browser.newContext({
      storageState,
      userAgent:  BROWSER.userAgent,
      viewport:   BROWSER.viewport,
      locale:     BROWSER.locale,
      timezoneId: BROWSER.timezoneId,
      // Do not bypass CSP or HTTPS errors.
      bypassCSP:         false,
      ignoreHTTPSErrors: false,
      // Grant common permissions upfront so permission prompts never appear
      permissions: ['geolocation', 'notifications'],
    });
    await applyStealthScripts(context);
    return new BrowserSession(name, context);
  }

  async close() {
    if (this.#browser) {
      await this.#browser.close();
      this.#browser = null;
      print('Browser closed.', 'system');
    }
  }
}

export class BrowserSession {
  #context;

  constructor(name, context) {
    this.name = name;
    this.#context = context;
  }

  /**
   * Open a new page. Caller is responsible for closing when done.
   * @returns {Promise<import('playwright').Page>}
   */
  async newPage() {
    const page = await this.#context.newPage();
    await applyPageRouting(page);
    return page;
  }

  async hasAuth() {
    const cookies = await this.#context.cookies(TWITTER.baseUrl);
    return cookies.some(cookie => cookie.name === 'auth_token');
  }

  /** Current cookies and local storage, to be re-encrypted into the vault. */
  async storageState() {
    return this.#context.storageState();
  }

  async close() {
    await this.#context.close();
  }
}

/**
 * Inject stealth patches into every page/frame BEFORE any page JS executes.
 *
 * addInitScript runs in the renderer process and patches window/navigator
 * properties that Playwright's CDP layer cannot touch from the outside.
 */
async function applyStealthScripts(context) {
  await context.addInitScript(() => {
    // Remove the webdriver flag.
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Restore a plausible plugin array.
    // Headless Chrome has 0 plugins; real Chrome has 3+.
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

    // Keep browser languages consistent.
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Report "prompt" instead of "denied" for common permissions.
    // Headless Chrome silently denies all permissions; real browsers prompt.
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

    // Add canvas fingerprint noise.
    // Bot-detectors draw a hidden canvas and hash pixel data.
    // SwiftShader produces a deterministic hash that identifies headless.
    // We add imperceptible per-session noise to break that hash.
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        // Flip one bit every 200 bytes to break deterministic hashes.
        for (let i = 0; i < imageData.data.length; i += 200) {
          imageData.data[i] ^= 1;
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return originalToDataURL.call(this, type, quality);
    };

    // Use plausible WebGL renderer strings.
    // "Google SwiftShader" is a known headless renderer string.
    // Replace with plausible Intel GPU strings.
    const patchWebGL = (ctx) => {
      const original = ctx.prototype.getParameter;
      ctx.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';               // UNMASKED_VENDOR
        if (parameter === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER
        return original.call(this, parameter);
      };
    };
    patchWebGL(WebGLRenderingContext);
    if (typeof WebGL2RenderingContext !== 'undefined') {
      patchWebGL(WebGL2RenderingContext);
    }

    // Restore window.chrome when it is missing.
    if (!window.chrome) {
      window.chrome = {
        app:     { isInstalled: false },
        runtime: {},
      };
    }

    // Keep screen and window dimensions consistent.
    // In headless, screen.availWidth can be 0 or inconsistent.
    Object.defineProperty(screen, 'availWidth',  { get: () => window.innerWidth  });
    Object.defineProperty(screen, 'availHeight', { get: () => window.innerHeight });
  });
}

/**
 * Block analytics/telemetry endpoints that could flag automated traffic.
 * Core Twitter/X requests are unaffected.
 *
 * @param {import('playwright').Page} page
 */
async function applyPageRouting(page) {
  await page.route('**/*', route => {
    const url = route.request().url();
    if (BROWSER.blockedDomains.some(domain => url.includes(domain))) {
      return route.abort();
    }
    return route.continue();
  });
}
