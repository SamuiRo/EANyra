/**
 * src/core/browser/Browser.js
 *
 * Playwright persistent browser context wrapper with anti-detection.
 *
 * Auth strategy:
 *   Session data (cookies, localStorage, IndexedDB) persists automatically
 *   in BROWSER.dataPath. A gitignored cookie cache restores Twitter auth when
 *   Chromium drops auth_token while saving the persistent profile.
 *
 * Anti-detection layers:
 *   1. Chromium launch args disable automation signals at the process level.
 *   2. Init scripts patch navigator/window APIs before page JavaScript runs.
 *   3. Browser environment uses a fixed UA, viewport, locale, and timezone.
 *   4. humanBehavior.js handles human-like interaction.
 */

import { chromium }          from 'playwright';
import { BROWSER }           from '../../config/app.config.js';
import {
  hasTwitterAuth,
  restoreCachedTwitterAuth,
} from './sessionCookies.js';
import { print, ensureDir }  from '../../shared/utils.js';

export class Browser {
  #context = null;

  async launch() {
    print('Launching browser…', 'system');
    await ensureDir(BROWSER.dataPath);

    this.#context = await chromium.launchPersistentContext(BROWSER.dataPath, {
      headless:   BROWSER.headless,
      userAgent:  BROWSER.userAgent,
      viewport:   BROWSER.viewport,
      locale:     BROWSER.locale,
      timezoneId: BROWSER.timezoneId,

      // These flags are applied at the process level before page JavaScript runs.
      args: [
        ...BROWSER.launchArgs,
        `--window-size=${BROWSER.viewport.width},${BROWSER.viewport.height}`,
      ],

      // Do not bypass CSP or HTTPS errors.
      bypassCSP:         false,
      ignoreHTTPSErrors: false,

      // Grant common permissions upfront so permission prompts never appear
      permissions: ['geolocation', 'notifications'],
    });

    try {
      if (await restoreCachedTwitterAuth(this.#context)) {
        print(`Restored Twitter session from ${BROWSER.cookiesPath}.`, 'success');
      }
    } catch (error) {
      print(`Twitter cookie fallback unavailable: ${error.message}`, 'debug');
    }

    await this.#applyStealthScripts();
    print(
      `Browser ready · ${BROWSER.viewport.width}x${BROWSER.viewport.height} · ${BROWSER.dataPath}`,
      'success',
    );
    return this;
  }

  /**
   * Open a new page. Caller is responsible for closing when done.
   * @returns {Promise<import('playwright').Page>}
   */
  async newPage() {
    if (!this.#context) throw new Error('Browser not launched. Call launch() first.');
    const page = await this.#context.newPage();
    await this.#applyPageRouting(page);
    return page;
  }

  async close() {
    if (this.#context) {
      try {
        if (!await hasTwitterAuth(this.#context)) {
          print(
            'Twitter auth_token is absent before browser close; the next run will try the cookie fallback.',
            'warning',
          );
        }
      } catch (error) {
        print(`Could not inspect Twitter session before browser close: ${error.message}`, 'debug');
      }
      await this.#context.close();
      this.#context = null;
      print('Browser closed.', 'system');
    }
  }

  /**
   * Inject stealth patches into every page/frame BEFORE any page JS executes.
   *
   * addInitScript runs in the renderer process and patches window/navigator
   * properties that Playwright's CDP layer cannot touch from the outside.
   */
  async #applyStealthScripts() {
    await this.#context.addInitScript(() => {
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
  async #applyPageRouting(page) {
    await page.route('**/*', route => {
      const url = route.request().url();
      if (BROWSER.blockedDomains.some(domain => url.includes(domain))) {
        return route.abort();
      }
      return route.continue();
    });
  }
}
