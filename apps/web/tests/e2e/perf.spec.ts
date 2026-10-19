import type { Page } from '@playwright/test';
import { DEFAULT_WATCHLIST } from '@tradingnerd/core';
import { expect, openChart, test } from './fixtures';

/**
 * Performance budgets (docs/SPEC.md §5.6), measured on real frames. They run as their own
 * project after the rest of the suite (playwright.config.ts), so other tests' load can't skew
 * the timing.
 */
test.use({ realClock: true });

const row = (page: Page, ticker: string) =>
  page
    .getByRole('complementary', { name: 'Watchlist' })
    .getByRole('button', { name: ticker, exact: true });

interface FrameStats {
  /** Each frame's callbacks plus the style and layout that follow them, in ms. */
  paints: number[];
  /** Time between frames, in ms. */
  gaps: number[];
  /** Frames the browser itself reports as long (over 50 ms). */
  longFrames: number[];
}

test('50 watchlist rows ticking at full speed cost under 2 ms per frame', async ({
  page,
  market,
}) => {
  const symbols = [
    ...(DEFAULT_WATCHLIST.sections[0]?.symbols ?? []),
    ...Array.from({ length: 28 }, (_, i) => `BINANCE:COIN${i}USDT`),
  ];
  market.watchlist = { sections: [{ id: 'crypto', title: 'Crypto', collapsed: false, symbols }] };
  await openChart(page);
  await expect.poll(() => market.quoteIds().size).toBe(50);
  await page.evaluate(() => {
    const stats: FrameStats = { paints: [], gaps: [], longFrames: [] };
    (window as unknown as { __frames: FrameStats }).__frames = stats;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) stats.longFrames.push(entry.duration);
    }).observe({ type: 'long-animation-frame' });
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const start = performance.now();
        callback(time);
        document.body.getBoundingClientRect(); // the style and layout the frame needs next
        stats.paints.push(performance.now() - start);
      });
    let last = performance.now();
    const tick = (now: number) => {
      stats.gaps.push(now - last);
      last = now;
      raf(tick);
    };
    raf(tick);
  });

  // For 3 s, every row gets a new price every 250 ms, the most the gateway sends. All 50 land
  // together, a worse case than the live feed, which spreads them out.
  const ids = [...market.quoteIds().values()];
  for (let step = 0; step < 12; step++) {
    for (const [i, id] of ids.entries()) {
      market.sendQuoteNow(id, 1 + i / 10 + step / 1000, 1 + i / 10);
    }
    await page.waitForTimeout(250);
  }
  await expect(row(page, 'COIN27USDT')).toContainText('5.911');

  const { paints, gaps, longFrames } = await page.evaluate(
    () => (window as unknown as { __frames: FrameStats }).__frames,
  );
  const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;
  // The budget: under 2 ms per frame (about 1 ms on the dev Mac), none near a 60 Hz frame's 16.7.
  expect(paints.length).toBeGreaterThanOrEqual(12);
  expect(median(paints)).toBeLessThan(2);
  expect(Math.max(...paints)).toBeLessThan(8);
  // And the page keeps up 60 fps with no visible hitch. Headless Chromium now and then skips two
  // vsyncs while the page is idle (a 50 ms gap with no long frame), so a hitch means over 100 ms.
  expect(median(gaps.slice(1))).toBeLessThan(20);
  expect([...longFrames, ...gaps.slice(1)].filter((duration) => duration > 100)).toEqual([]);
});
