import type { Page } from '@playwright/test';
import {
  chartState,
  chartTimeLabel,
  expect,
  openChart,
  PRE_MARKET_NOW,
  STOCK_NOW,
  settle,
  test,
} from './fixtures';

/**
 * TradingView's extended hours and market status for stocks (docs/SPEC.md §5.7–5.8): Chart
 * settings' Session, pre/post market backgrounds and Timezone; the legend's status pill, the
 * pre/post-market price line and the watchlist's dots.
 */

const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Chart settings' });
const legendPill = (page: Page) => page.locator('[data-field="status"]').first();
const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });

async function openAt(page: Page, now: number, url: string) {
  await page.clock.setFixedTime(now);
  return openChart(page, url);
}

async function choose(page: Page, field: string, option: string) {
  await settingsDialog(page).getByRole('button', { name: field }).click();
  await page.getByRole('listbox', { name: field }).getByRole('option', { name: option }).click();
}

const PRE_ORANGE = 'rgba(255, 152, 0, 0.08)';
const POST_BLUE = 'rgba(41, 98, 255, 0.08)';

test("Chart settings opens from the top bar's Settings button, with the Symbol tab's fields", async ({
  page,
}) => {
  await openAt(page, STOCK_NOW, '/?symbol=NASDAQ:AAPL&interval=5');
  await expect(page.getByText('Apple Inc. · 5 · NASDAQ')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = settingsDialog(page);
  await expect(dialog.getByRole('button', { name: 'Symbol' })).toBeVisible();
  await expect(dialog.getByText('Data modification')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Session' })).toHaveText('Regular trading hours');
  await expect(dialog.getByText('Pre/post market hours background')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Pre-market hours background/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Post-market hours background/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Timezone' })).toHaveText('Exchange');
  await dialog.getByRole('button', { name: 'Ok' }).click();
  await expect(dialog).toHaveCount(0);
});

test('a crypto chart has no session to choose, only the time zone', async ({ page }) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = settingsDialog(page);
  await expect(dialog.getByRole('button', { name: 'Timezone' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Session' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('extended trading hours: pre- and post-market bars on intraday charts, shaded orange and blue', async ({
  page,
  market,
}) => {
  await openAt(page, STOCK_NOW, '/?symbol=NASDAQ:AAPL&interval=5');
  await expect(page.getByText('Apple Inc. · 5 · NASDAQ')).toBeVisible();
  expect((await chartState(page)).sessionBands).toEqual([]);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await choose(page, 'Session', 'Extended trading hours');
  await expect.poll(() => market.barRequests.at(-1)?.get('session')).toBe('extended');
  // Monday's pre-market (from 04:00 New York, 08:00Z) is on the chart, on an orange band.
  await settle(page);
  await expect
    .poll(async () => (await chartState(page)).sessionBands.map((band) => band.color))
    .toContain(PRE_ORANGE);
  // Scrolled back, Friday's post-market sits on a blue one.
  await page.mouse.move(400, 300);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(-400, 0);
  await expect
    .poll(async () => (await chartState(page)).sessionBands.map((band) => band.color))
    .toContain(POST_BLUE);

  await settingsDialog(page).getByRole('button', { name: 'Ok' }).click();
  // Kept, as TradingView keeps a layout's settings.
  await page.reload();
  await expect(page.getByText('Apple Inc. · 5 · NASDAQ')).toBeVisible();
  await expect.poll(() => market.barRequests.at(-1)?.get('session')).toBe('extended');
});

test('Cancel puts the old settings back', async ({ page, market }) => {
  await openAt(page, STOCK_NOW, '/?symbol=NASDAQ:AAPL&interval=5');
  await expect(page.getByText('Apple Inc. · 5 · NASDAQ')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await choose(page, 'Session', 'Extended trading hours');
  await expect.poll(() => market.barRequests.at(-1)?.get('session')).toBe('extended');
  await settingsDialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => market.barRequests.at(-1)?.has('session')).toBe(false);
  await settle(page);
  expect((await chartState(page)).sessionBands).toEqual([]);
});

test('day charts stay on the regular sessions with extended hours on', async ({ page, market }) => {
  await openAt(page, STOCK_NOW, '/?symbol=NASDAQ:AAPL&interval=5');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await choose(page, 'Session', 'Extended trading hours');
  await settingsDialog(page).getByRole('button', { name: 'Ok' }).click();
  await page.getByRole('button', { name: 'D', exact: true }).click();
  await expect(page.getByText('Apple Inc. · 1D · NASDAQ')).toBeVisible();
  expect(market.barRequests.at(-1)?.get('resolution')).toBe('1D');
  expect(market.barRequests.at(-1)?.has('session')).toBe(false);
  await settle(page);
  expect((await chartState(page)).sessionBands).toEqual([]);
});

test("the time axis shows the exchange's time, or the zone chosen", async ({ page }) => {
  await openAt(page, STOCK_NOW, '/?symbol=NASDAQ:AAPL&interval=60');
  await expect(page.getByText('Apple Inc. · 1h · NASDAQ')).toBeVisible();
  const open = Date.parse('2026-10-19T13:30:00Z') / 1000;
  expect(await chartTimeLabel(page, open)).toBe("Mon 19 Oct '26  09:30");
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await choose(page, 'Timezone', '(UTC+2) Berlin');
  await expect.poll(() => chartTimeLabel(page, open)).toBe("Mon 19 Oct '26  15:30");
  await expect(settingsDialog(page).getByRole('button', { name: 'Timezone' })).toHaveText(
    '(UTC+2) Berlin',
  );
});

test('pre-market: the legend\'s sunrise, the "Pre" price line, and the watchlist\'s orange dot and D', async ({
  page,
  market,
}) => {
  market.stockNow = PRE_MARKET_NOW;
  market.watchlist = {
    sections: [{ id: 'us', title: 'US', collapsed: false, symbols: ['NASDAQ:AAPL', 'AMEX:SPY'] }],
  };
  await openAt(page, PRE_MARKET_NOW, '/?symbol=NASDAQ:AAPL&interval=5');
  await expect(page.getByText('Apple Inc. · 5 · NASDAQ')).toBeVisible();
  await expect(legendPill(page)).toHaveAttribute('data-market', 'pre');
  await expect(page.getByRole('img', { name: 'Pre-market' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Data is delayed by 15 minutes' })).toHaveText('D');
  await expect
    .poll(async () => (await chartState(page)).extendedPriceLabel)
    .toMatchObject({ tag: 'Pre', color: '#FB8C00' });

  const row = watchlist(page).locator('[data-symbol="NASDAQ:AAPL"]');
  await expect(row.locator('[data-field="delayed"]')).toHaveText('D');
  await expect(row.locator('[data-field="market"]')).toHaveAttribute('data-market', 'pre');
  await expect(row.locator('[data-field="market"]')).toHaveCSS(
    'background-color',
    'rgb(255, 152, 0)',
  );
});

test('in the regular session: a green dot in the legend, no pre/post line and no watchlist dot', async ({
  page,
  market,
}) => {
  market.watchlist = {
    sections: [{ id: 'us', title: 'US', collapsed: false, symbols: ['NASDAQ:AAPL'] }],
  };
  await openAt(page, STOCK_NOW, '/?symbol=NASDAQ:AAPL&interval=5');
  await expect(page.getByText('Apple Inc. · 5 · NASDAQ')).toBeVisible();
  await expect(legendPill(page)).toHaveAttribute('data-market', 'open');
  await expect(page.getByRole('img', { name: 'Market open' })).toBeVisible();
  await settle(page);
  expect((await chartState(page)).extendedPriceLabel).toBeNull();
  const row = watchlist(page).locator('[data-symbol="NASDAQ:AAPL"]');
  await expect(row.locator('[data-field="delayed"]')).toHaveText('D');
  await expect(row.locator('[data-field="market"]')).toHaveCount(0);
});

test('a weekend is closed: gray in the legend and the watchlist', async ({ page, market }) => {
  market.watchlist = {
    sections: [{ id: 'us', title: 'US', collapsed: false, symbols: ['NASDAQ:AAPL'] }],
  };
  await openAt(page, Date.parse('2026-10-24T15:00:00Z'), '/?symbol=NASDAQ:AAPL&interval=1D');
  await expect(page.getByText('Apple Inc. · 1D · NASDAQ')).toBeVisible();
  await expect(legendPill(page)).toHaveAttribute('data-market', 'closed');
  await expect(page.getByRole('img', { name: 'Market closed' })).toBeVisible();
  const dot = watchlist(page).locator('[data-symbol="NASDAQ:AAPL"] [data-field="market"]');
  await expect(dot).toHaveAttribute('data-market', 'closed');
  await expect(dot).toHaveCSS('background-color', 'rgb(156, 156, 156)');
});

test('crypto is always open: no D and no dot', async ({ page }) => {
  await openChart(page);
  await expect(legendPill(page)).toHaveAttribute('data-market', 'open');
  await expect(page.locator('[data-field="delayed"]:visible')).toHaveCount(0);
  await expect(watchlist(page).locator('[data-field="market"]')).toHaveCount(0);
});
