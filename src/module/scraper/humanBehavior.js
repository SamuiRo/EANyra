/**
 * src/module/scraper/humanBehavior.js
 *
 * Human-like page interaction helpers for TwitterScraper.
 *
 * Why a separate file:
 *   These functions operate on a Playwright `page` object and have no
 *   dependency on scraper-specific selectors or state. Keeping them separate
 *   makes them reusable and keeps TwitterScraper focused on extraction logic.
 *
 * What makes scroll/mouse patterns detectable:
 *   - window.scrollBy(0, exactPixels) called at perfectly regular intervals
 *   - Mouse cursor that never moves (stays at 0,0 the entire session)
 *   - Page that loads and immediately starts scrolling with zero reading time
 *   - Scroll always starting from the very top with no "settling" movement
 */

import { sleep, jitter } from '../../shared/utils.js';

// ─── Mouse movement ───────────────────────────────────────────────────────────

/**
 * Move the mouse in a curved arc from (x1,y1) to (x2,y2) over ~n steps.
 * A real human never moves the mouse in a straight line — the path curves
 * slightly and accelerates/decelerates.
 *
 * @param {import('playwright').Page} page
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {{ steps?: number }} [opts]
 */
export async function humanMouseMove(page, x1, y1, x2, y2, { steps = 12 } = {}) {
  // Bézier control point — offset perpendicular to the straight-line path.
  const cx = (x1 + x2) / 2 + (Math.random() - 0.5) * 80;
  const cy = (y1 + y2) / 2 + (Math.random() - 0.5) * 60;

  for (let i = 1; i <= steps; i++) {
    const t  = i / steps;
    // Ease in-out: slow start, fast middle, slow end
    const et = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    // Quadratic Bézier point
    const x = (1 - et) * (1 - et) * x1 + 2 * (1 - et) * et * cx + et * et * x2;
    const y = (1 - et) * (1 - et) * y1 + 2 * (1 - et) * et * cy + et * et * y2;

    await page.mouse.move(x, y);
    await sleep(Math.floor(10 + Math.random() * 15)); // 10–25 ms per step
  }
}

/**
 * Perform a few small random mouse micro-movements — simulates the natural
 * small drift of a hand resting on a mouse while reading.
 *
 * @param {import('playwright').Page} page
 * @param {{ baseX?: number, baseY?: number }} [opts]
 */
export async function mouseIdle(page, { baseX = 400, baseY = 400 } = {}) {
  const moves = 2 + Math.floor(Math.random() * 3); // 2–4 micro-moves
  let cx = baseX, cy = baseY;
  for (let i = 0; i < moves; i++) {
    cx += (Math.random() - 0.5) * 30;
    cy += (Math.random() - 0.5) * 20;
    await page.mouse.move(cx, cy);
    await sleep(60 + Math.floor(Math.random() * 120));
  }
}

// ─── Scroll ───────────────────────────────────────────────────────────────────

/**
 * Scroll down in a human-like manner:
 *   - Non-uniform scroll amount (viewport × 0.6–1.1, never exact)
 *   - Occasional small upward "correction" scroll (humans overshoot and back up)
 *   - Brief pause before scrolling (reading time simulation)
 *   - Mouse position moves to a realistic Y before the scroll gesture
 *
 * Replace the plain window.scrollBy() calls in TwitterScraper with this.
 *
 * @param {import('playwright').Page} page
 * @param {{ scrollDelayMs?: number }} [opts]
 */
export async function humanScroll(page, { scrollDelayMs = 2500 } = {}) {
  // ── 1. Reading pause before scrolling ───────────────────────────────────
  // Humans read for a moment before scrolling — 1.5–4 s depending on content.
  const readMs = 1_500 + Math.floor(Math.random() * 2_500);
  await sleep(readMs);

  // ── 2. Move mouse to a mid-page position (humans grab mouse before scrolling)
  const viewportSize = page.viewportSize() ?? { width: 1280, height: 900 };
  const mouseX = 200 + Math.floor(Math.random() * (viewportSize.width - 400));
  const mouseY = 300 + Math.floor(Math.random() * 300);
  await page.mouse.move(mouseX, mouseY);
  await sleep(80 + Math.floor(Math.random() * 120));

  // ── 3. Scroll amount: 60–110% of viewport height, never a round number ──
  const factor   = 0.6 + Math.random() * 0.5;
  const scrollPx = Math.floor(viewportSize.height * factor) + Math.floor(Math.random() * 40 - 20);

  await page.evaluate((px) => window.scrollBy({ top: px, behavior: 'smooth' }), scrollPx);

  // ── 4. Jitter wait while smooth-scroll animation plays ──────────────────
  await jitter(scrollDelayMs, scrollDelayMs + 800);

  // ── 5. Occasional small upward correction (≈15% of scrolls) ─────────────
  if (Math.random() < 0.15) {
    const backPx = 40 + Math.floor(Math.random() * 80);
    await sleep(300 + Math.floor(Math.random() * 400));
    await page.evaluate((px) => window.scrollBy({ top: -px, behavior: 'smooth' }), backPx);
    await sleep(400 + Math.floor(Math.random() * 300));
    // Scroll back down past the correction so we still make net progress
    await page.evaluate((px) => window.scrollBy({ top: px, behavior: 'smooth' }), backPx + 20);
    await sleep(300);
  }

  // ── 6. Idle mouse micro-movement while page settles ──────────────────────
  if (Math.random() < 0.4) {
    await mouseIdle(page, { baseX: mouseX, baseY: mouseY });
  }
}

/**
 * Simulate the very start of a page visit:
 *   - Small initial scroll to show the browser this isn't a zero-interaction bot
 *   - Random pause as if the user glanced at the top of the profile
 *   - Occasional hover over the header area
 *
 * Call this once after waitForSelector() resolves, before the collection loop.
 *
 * @param {import('playwright').Page} page
 */
export async function simulatePageLanding(page) {
  const viewportSize = page.viewportSize() ?? { width: 1280, height: 900 };

  // Move mouse somewhere on the page (arrives from "outside" at top-left)
  await humanMouseMove(
    page,
    0, 0,
    200 + Math.floor(Math.random() * 400),
    100 + Math.floor(Math.random() * 200),
  );

  // Pause as if reading the profile header — 2–5 s
  await jitter(2_000, 5_000);

  // Tiny scroll to show engagement before the main loop starts
  const initialScroll = 80 + Math.floor(Math.random() * 120);
  await page.evaluate((px) => window.scrollBy({ top: px, behavior: 'smooth' }), initialScroll);
  await sleep(600 + Math.floor(Math.random() * 600));

  // Occasionally move mouse toward the tweet area
  if (Math.random() < 0.6) {
    await humanMouseMove(
      page,
      200, 150,
      300 + Math.floor(Math.random() * 200),
      300 + Math.floor(Math.random() * 200),
    );
    await sleep(300 + Math.floor(Math.random() * 500));
  }
}