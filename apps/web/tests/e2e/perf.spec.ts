import type { Page } from '@playwright/test';
import { type Bar, DEFAULT_WATCHLIST } from '@tradingnerd/core';
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
  /** Each frame's callbacks plus the style and layout that follow them, in ms, per frame. */
  paints: number[];
  /** Time between frames, in ms. */
  gaps: number[];
  /** Frames the browser itself reports as long (over 50 ms). */
  longFrames: number[];
}

/** Records every frame from now on: what its callbacks cost, and the gaps between frames. */
async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stats: FrameStats = { paints: [], gaps: [], longFrames: [] };
    (window as unknown as { __frames: FrameStats }).__frames = stats;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) stats.longFrames.push(entry.duration);
    }).observe({ type: 'long-animation-frame' });
    // Every callback of a frame gets the same timestamp: their costs add up to the frame's.
    const perFrame = new Map<number, number>();
    (window as unknown as { __perFrame: Map<number, number> }).__perFrame = perFrame;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const start = performance.now();
        callback(time);
        document.body.getBoundingClientRect(); // the style and layout the frame needs next
        perFrame.set(time, (perFrame.get(time) ?? 0) + performance.now() - start);
      });
    let last = performance.now();
    const tick = (now: number) => {
      stats.gaps.push(now - last);
      last = now;
      raf(tick);
    };
    raf(tick);
  });
}

async function frames(page: Page): Promise<FrameStats> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: FrameStats; __perFrame: Map<number, number> };
    return { ...w.__frames, paints: [...w.__perFrame.values()] };
  });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ??
  0;

interface TestChart {
  setBars(bars: Bar[]): void;
  latest(): { bar: Bar } | null;
  debugState(): { logicalRange: { from: number; to: number } | null; barCount: number };
}
const testChart = () =>
  (window as unknown as { __tradingNerd: { chart: TestChart } }).__tradingNerd.chart;

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
  await recordFrames(page);

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

  const { paints, gaps, longFrames } = await frames(page);
  // The budget: under 2 ms per frame (about 1 ms on the dev Mac), none near a 60 Hz frame's 16.7.
  expect(paints.length).toBeGreaterThanOrEqual(12);
  expect(median(paints)).toBeLessThan(2);
  expect(Math.max(...paints)).toBeLessThan(8);
  // And the page keeps up 60 fps with no visible hitch. Headless Chromium now and then skips two
  // vsyncs while the page is idle (a 50 ms gap with no long frame), so a hitch means over 100 ms.
  expect(median(gaps.slice(1))).toBeLessThan(20);
  expect([...longFrames, ...gaps.slice(1)].filter((duration) => duration > 100)).toEqual([]);
});

test('panning and zooming through 20,000 bars keeps up 60 fps', async ({ page }) => {
  await openChart(page);
  // 20,000 daily bars ending on the mock's last one, set on the chart as a session sets them.
  await page.evaluate(`(${testChart})().setBars((() => {
    const last = (${testChart})().latest().bar.time;
    const bars = [];
    let close = 1.3;
    for (let i = 0; i < 20000; i++) {
      const open = close;
      close = open * (1 + Math.sin(i * 12.9898) * 0.02);
      const time = last - (19999 - i) * 86400;
      bars.push({ time, open, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * 0.99, close, volume: 1000 + (i % 97) });
    }
    return bars;
  })())`);
  const pane = await page.getByRole('main', { name: 'Chart' }).boundingBox();
  if (!pane) throw new Error('no chart');
  const [x, y] = [pane.x + pane.width / 2, pane.y + pane.height / 2];
  await page.mouse.move(x, y);
  const before = await page.evaluate(`(${testChart})().debugState().logicalRange`);
  await recordFrames(page);

  // About 3 s of steady input: zoom out to thousands of bars, swipe and drag through them,
  // zoom back in. A plain wheel zooms; a sideways one pans.
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 120);
  const zoomedOut = (await page.evaluate(`(${testChart})().debugState()`)) as {
    logicalRange: { from: number; to: number };
    barCount: number;
  };
  expect(zoomedOut.barCount).toBe(20_000);
  expect(zoomedOut.logicalRange.to - zoomedOut.logicalRange.from).toBeGreaterThan(1_000);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(-200, 0);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) await page.mouse.move(x - i * 12, y);
  await page.mouse.up();
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(500); // the glide after the last swipe ends

  const after = (await page.evaluate(`(${testChart})().debugState().logicalRange`)) as {
    from: number;
    to: number;
  };
  expect(after).not.toEqual(before);
  const { paints, gaps, longFrames } = await frames(page);
  const ms = (value: number) => `${value.toFixed(1)} ms`;
  console.log(
    `20,000 bars: ${paints.length} frames drawn; per frame median ${ms(median(paints))}, 95th ${ms(percentile(paints, 0.95))}, worst ${ms(Math.max(...paints))}; gaps median ${ms(median(gaps.slice(1)))}, 95th ${ms(percentile(gaps.slice(1), 0.95))}; ${longFrames.length} long frames (> 50 ms)`,
  );
  // Frames came steadily: a 60 Hz frame is 16.7 ms; drawing one stays far under that.
  expect(paints.length).toBeGreaterThan(60);
  expect(median(paints)).toBeLessThan(4);
  expect(percentile(paints, 0.95)).toBeLessThan(10);
  expect(median(gaps.slice(1))).toBeLessThan(20);
  expect(percentile(gaps.slice(1), 0.95)).toBeLessThan(34);
  expect(longFrames.filter((duration) => duration > 100)).toEqual([]);
});

test('switching symbol or interval shows the new chart in under 150 ms', async ({ page }) => {
  await openChart(page);
  // From the click to the first frame drawn with the new bars.
  await page.evaluate(() => {
    const w = window as unknown as {
      __tradingNerd: { chart: TestChart };
      __switches: number[];
      __clickAt: number;
    };
    const chart = w.__tradingNerd.chart;
    const setBars = chart.setBars.bind(chart);
    w.__switches = [];
    document.addEventListener(
      'click',
      () => {
        w.__clickAt = performance.now();
      },
      true,
    );
    chart.setBars = (bars) => {
      setBars(bars);
      requestAnimationFrame(() => w.__switches.push(performance.now() - w.__clickAt));
    };
  });
  const switches = () =>
    page.evaluate(() => (window as unknown as { __switches: number[] }).__switches.length);
  const toolbar = page.getByRole('banner').getByRole('group', { name: 'Intervals' });
  const steps = [
    () => row(page, 'LINKUSDT').click(),
    () => row(page, 'ARBUSDT').click(),
    () => row(page, 'XRPUSDT').click(),
    () => toolbar.getByRole('button', { name: '1h', exact: true }).click(),
    () => toolbar.getByRole('button', { name: '4h', exact: true }).click(),
    () => toolbar.getByRole('button', { name: 'D', exact: true }).click(),
  ];
  for (const [i, step] of steps.entries()) {
    await step();
    await expect.poll(switches).toBe(i + 1);
  }
  const times = await page.evaluate(
    () => (window as unknown as { __switches: number[] }).__switches,
  );
  console.log(`Switches: ${times.map((ms) => `${Math.round(ms)} ms`).join(', ')}`);
  expect(Math.max(...times)).toBeLessThan(150);
});
