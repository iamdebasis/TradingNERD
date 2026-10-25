import type { Page } from '@playwright/test';
import {
  chartCall,
  chartState,
  DAY,
  expect,
  LAST_DAY,
  openChart,
  paneOrigin,
  spacingOf,
  test,
} from './fixtures';

const MINUS = '−';
const field = (page: Page, name: string) => page.locator(`[data-field="${name}"]`);
const legend = (page: Page) => page.locator('[data-book]');

test('opens on the latest bars with TradingView defaults', async ({ page, market }) => {
  const state = await openChart(page);
  expect(state.barCount).toBe(1_000);
  expect(state.lastBar?.time).toBe(LAST_DAY);
  expect(state.scrollPosition).toBeCloseTo(10); // 10-bar right margin
  expect(state.autoScale).toBe(true);
  expect(state.priceAxisWidth).toBe(72);
  if (!state.logicalRange) throw new Error('no visible range');
  expect(spacingOf(state.logicalRange, state.width)).toBeCloseTo(6); // 6 px bars
  expect(market.barRequests).toHaveLength(1);
  expect(market.barRequests[0]?.get('countBack')).toBe('1000');
  expect(market.barRequests[0]?.has('to')).toBe(false);
});

test('the legend shows the symbol and the latest bar with its change', async ({ page }) => {
  await openChart(page);
  await expect(field(page, 'title')).toHaveText('XRP / TetherUS · 1D · Binance');
  await expect(field(page, 'open')).toHaveText('1.3115');
  await expect(field(page, 'high')).toHaveText('1.3126');
  await expect(field(page, 'low')).toHaveText('1.2902');
  await expect(field(page, 'close')).toHaveText('1.2955');
  await expect(field(page, 'change')).toHaveText(`${MINUS}0.0160 (${MINUS}1.22%)`);
  await expect(legend(page)).toHaveAttribute('data-direction', 'down');
  await expect(legend(page)).toHaveAttribute('data-status', 'live');
});

test('the last-price label shows the price and the countdown to the daily close', async ({
  page,
}) => {
  await openChart(page);
  // The clock is pinned to 16:09:54 UTC, like the reference screenshot's 07:50:06.
  await expect
    .poll(async () => (await chartState(page)).lastPriceLabel)
    .toEqual({ price: 1.2955, text: '1.2955', countdown: '07:50:06', color: '#F23645' });
});

test('the legend follows the crosshair and returns to the latest bar', async ({ page, market }) => {
  await openChart(page);
  const index = 1_000 - 1 - 20; // 20 bars before the latest
  const x = await chartCall<number>(page, 'barX', index);
  const origin = await paneOrigin(page);
  await page.mouse.move(origin.x + x, origin.y + 300);
  const hovered = market.bars[market.bars.length - 1 - 20];
  await expect(field(page, 'close')).toHaveText(hovered?.close.toFixed(4) ?? '');
  await page.mouse.move(origin.x + x, origin.y - 20); // up into the toolbar
  await expect(field(page, 'close')).toHaveText('1.2955');
});

test('live updates move the last bar, the legend and the price label', async ({ page, market }) => {
  await openChart(page);
  await market.sendBar({
    time: LAST_DAY,
    open: 1.3115,
    high: 1.3226,
    low: 1.2902,
    close: 1.32,
    volume: 2e7,
  });
  await expect(field(page, 'close')).toHaveText('1.3200');
  await expect(field(page, 'high')).toHaveText('1.3226');
  await expect(legend(page)).toHaveAttribute('data-direction', 'up');
  await expect.poll(async () => (await chartState(page)).lastPriceLabel?.color).toBe('#089981');

  await market.sendBar({
    time: LAST_DAY + DAY,
    open: 1.32,
    high: 1.33,
    low: 1.31,
    close: 1.325,
    volume: 1,
  });
  await expect.poll(async () => (await chartState(page)).barCount).toBe(1_001);
  await expect(field(page, 'open')).toHaveText('1.3200');
});

test('a late correction rewrites an earlier bar instead of adding one', async ({
  page,
  market,
}) => {
  await openChart(page);
  await market.sendBar({
    time: LAST_DAY + DAY,
    open: 1.3,
    high: 1.31,
    low: 1.29,
    close: 1.3,
    volume: 1,
  });
  await expect.poll(async () => (await chartState(page)).barCount).toBe(1_001);
  await market.sendBar(
    { time: LAST_DAY, open: 1.3115, high: 1.3126, low: 1.2902, close: 1.2999, volume: 3e7 },
    true,
  );
  const x = await chartCall<number>(page, 'barX', 999);
  const origin = await paneOrigin(page);
  await page.mouse.move(origin.x + x, origin.y + 300);
  await expect(field(page, 'close')).toHaveText('1.2999');
  expect((await chartState(page)).barCount).toBe(1_001);
});

test('Sell and Buy show the best bid and ask with the spread', async ({ page, market }) => {
  await openChart(page);
  await expect(legend(page)).toHaveAttribute('data-book', 'false');
  await market.sendBook(1.2955, 1.2956);
  await expect(field(page, 'bid')).toHaveText('1.2955');
  await expect(field(page, 'ask')).toHaveText('1.2956');
  await expect(field(page, 'spread')).toHaveText('0.0001');
  await expect(legend(page)).toHaveAttribute('data-book', 'true');
  // The reference's boxes: 65.5 px each, 51 px apart.
  const width = async (name: string) => (await field(page, name).boundingBox())?.width ?? 0;
  expect(await width('sell')).toBeCloseTo(65.5, 1);
  expect(await width('buy')).toBeCloseTo(65.5, 1);
  expect(await width('spread')).toBeCloseTo(51, 1);
});

test('a long price widens Sell and Buy to fit, as TradingView does (XRPBTC in screenshot 20)', async ({
  page,
  market,
}) => {
  await openChart(page, '/?symbol=BINANCE:SHIBUSDT&interval=1D');
  await market.sendBook(0.0000159, 0.00001591);
  await expect(field(page, 'bid')).toHaveText('0.00001590');
  await expect(field(page, 'spread')).toHaveText('0.00000001');
  const box = async (name: string) => (await field(page, name).boundingBox()) ?? { x: 0, width: 0 };
  const [sell, spread, buy] = [await box('sell'), await box('spread'), await box('buy')];
  // TradingView's: 97 px boxes, 78 px apart; the price stays inside its box.
  expect(sell.width).toBeGreaterThan(92);
  expect(sell.width).toBeLessThan(102);
  expect(buy.width).toBeCloseTo(sell.width, 0);
  expect(spread.width).toBeGreaterThan(74);
  expect(spread.width).toBeLessThan(82);
  expect(spread.x).toBeGreaterThanOrEqual(sell.x + sell.width - 0.5);
  expect(buy.x).toBeGreaterThanOrEqual(spread.x + spread.width - 0.5);
  const price = (await field(page, 'bid').boundingBox()) ?? { x: 0, width: 0 };
  expect(price.x).toBeGreaterThan(sell.x);
  expect(price.x + price.width).toBeLessThan(sell.x + sell.width);
});

test('scrolling back loads older history, page by page, until the listing', async ({
  page,
  market,
}) => {
  await openChart(page);
  await chartCall(page, 'scrollBars', -900);
  await expect.poll(async () => (await chartState(page)).barCount).toBe(2_000);
  const older = market.barRequests[1];
  expect(older?.get('to')).toBe(String(LAST_DAY - 999 * DAY));
  expect(older?.get('countBack')).toBe('1000');

  await chartCall(page, 'scrollBars', -1_000);
  await expect.poll(async () => (await chartState(page)).barCount).toBe(2_500);
  await chartCall(page, 'scrollBars', -1_000);
  await page.waitForTimeout(300);
  expect(market.barRequests).toHaveLength(3); // the start of history was reached
  expect((await chartState(page)).firstBarTime).toBe(market.bars[0]?.time);
});

test('after the connection drops, it reconnects and refills recent bars', async ({
  page,
  market,
}) => {
  await openChart(page);
  await market.subscribed('bars');
  await expect(legend(page)).toHaveAttribute('data-status', 'live');
  const requestsBefore = market.barRequests.length;

  await market.drop();
  await expect(legend(page)).toHaveAttribute('data-status', 'reconnecting');
  await expect.poll(() => market.connections()).toBe(2);
  await expect(legend(page)).toHaveAttribute('data-status', 'live');
  await expect.poll(() => market.barRequests.length).toBe(requestsBefore + 1);
  expect(market.barRequests.at(-1)?.has('to')).toBe(false);
});

test('an exchange outage: the chart says so, then fills in what it missed', async ({
  page,
  market,
}) => {
  await openChart(page);
  await expect(legend(page)).toHaveAttribute('data-status', 'live');
  const requestsBefore = market.barRequests.length;
  // The gateway lost the exchange (docs/SPEC.md §8, M5), while this page's link stayed up.
  await market.sendBarsState('reconnecting');
  await expect(legend(page)).toHaveAttribute('data-status', 'reconnecting');
  await market.sendBarsState('live');
  await expect(legend(page)).toHaveAttribute('data-status', 'live');
  await expect.poll(() => market.barRequests.length).toBe(requestsBefore + 1);
  expect(market.barRequests.at(-1)?.has('to')).toBe(false); // the latest bars, through the gap
  expect(market.barRequests.at(-1)?.get('countBack')).toBe('1000');
  expect(market.connections()).toBe(1);
});

test('an unknown symbol shows a clear error', async ({ page, consoleGuard }) => {
  consoleGuard.allow(/status of 404/);
  await page.goto('/?symbol=BINANCE:NOPE');
  await expect(field(page, 'message')).toHaveText('Binance does not list this symbol');
  await expect(legend(page)).toHaveAttribute('data-status', 'error');
});

test('the URL picks symbol and interval in TradingView format', async ({ page, market }) => {
  await openChart(page, '/?symbol=binance:xrpusdt&interval=60');
  await expect(field(page, 'title')).toHaveText('XRP / TetherUS · 1h · Binance');
  expect(market.barRequests[0]?.get('resolution')).toBe('60');
  expect(market.barRequests[0]?.get('symbol')).toBe('BINANCE:XRPUSDT');
});
