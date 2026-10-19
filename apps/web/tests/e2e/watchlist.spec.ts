import type { Page } from '@playwright/test';
import { DEFAULT_WATCHLIST } from '@tradingnerd/core';
import { chartState, expect, openChart, test } from './fixtures';

/**
 * The watchlist (docs/SPEC.md §5.3), against the mock gateway: rows, live quotes with flashing
 * digits, switching the chart, keyboard, removing, reordering, folding, and saving.
 */
const panel = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const row = (page: Page, ticker: string) =>
  panel(page).getByRole('button', { name: ticker, exact: true });
const tickers = (page: Page) =>
  panel(page)
    .locator('button[data-symbol]')
    .evaluateAll((rows) => rows.map((element) => element.getAttribute('aria-label')));

const DEFAULT_TICKERS = (DEFAULT_WATCHLIST.sections[0]?.symbols ?? []).map((symbol) =>
  symbol.replace('BINANCE:', ''),
);

test("shows the user's coins under CRYPTO, the chart's symbol selected", async ({ page }) => {
  await openChart(page);
  await expect.poll(() => tickers(page)).toEqual(DEFAULT_TICKERS);
  await expect(panel(page).getByRole('button', { name: 'Crypto' })).toHaveText('Crypto');
  await expect(row(page, 'XRPUSDT')).toHaveAttribute('aria-current', 'true');
  for (const title of ['Symbol', 'Last', 'Chg', 'Chg%']) {
    await expect(panel(page).getByText(title, { exact: true })).toBeVisible();
  }
});

test('quotes Last, Chg and Chg% against the previous close, as in the reference', async ({
  page,
}) => {
  await openChart(page);
  // The mock's LINK quote is the reference's: 11.947, previous close 12.350.
  await expect(row(page, 'LINKUSDT')).toContainText('11.947');
  await expect(row(page, 'LINKUSDT')).toContainText('−0.403');
  await expect(row(page, 'LINKUSDT')).toContainText('−3.26%');
  const change = row(page, 'LINKUSDT').locator('[data-direction]').first();
  await expect(change).toHaveCSS('color', 'rgb(242, 54, 69)');
  // A coin priced to 6 decimals: Chg is cut to 5 (the reference's VET row, exactly).
  await expect(row(page, 'VETUSDT')).toHaveText(/^V\s*VETUSDT\s*0\.006731\s*−0\.00024\s*−3\.55%$/);
});

test('a new price flashes the digits that changed, green up and red down', async ({
  page,
  market,
}) => {
  await openChart(page);
  await expect(row(page, 'LINKUSDT')).toContainText('11.947');
  const flash = row(page, 'LINKUSDT').locator('span[data-direction]').first();

  await market.sendQuote('BINANCE:LINKUSDT', 11.952, 12.35);
  await expect(row(page, 'LINKUSDT')).toContainText('11.952');
  await expect(flash).toHaveText('52');
  await expect(flash).toHaveCSS('color', 'rgb(34, 171, 148)');

  await market.sendQuote('BINANCE:LINKUSDT', 11.951, 12.35);
  await expect(flash).toHaveText('1');
  await expect(flash).toHaveCSS('color', 'rgb(242, 54, 69)');

  // The same price again (the previous close moved) keeps the color until the price changes.
  await market.sendQuote('BINANCE:LINKUSDT', 11.951, 12.3);
  await expect(row(page, 'LINKUSDT')).toContainText('−0.349');
  await expect(flash).toHaveText('1');
  await expect(flash).toHaveCSS('color', 'rgb(242, 54, 69)');
});

test('clicking a row shows it on the chart', async ({ page, market }) => {
  await openChart(page);
  await row(page, 'LINKUSDT').click();
  await expect(row(page, 'LINKUSDT')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('banner')).toContainText('LINKUSDT');
  await expect(page.getByText('LINK / TetherUS · 1D · Binance')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('symbol')).toBe('BINANCE:LINKUSDT');
  await expect.poll(() => market.barRequests.at(-1)?.get('symbol')).toBe('BINANCE:LINKUSDT');
});

test('↑/↓ move through the list, switching the chart', async ({ page }) => {
  await openChart(page);
  await row(page, 'XRPUSDT').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'BATUSDT')).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('symbol')).toBe('BINANCE:BATUSDT');
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 'LINKUSDT')).toHaveAttribute('aria-current', 'true');
  // The chart's own keys still work: Ctrl/⌘ + ↑ zooms instead of moving.
  const before = (await chartState(page)).logicalRange;
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await expect.poll(async () => (await chartState(page)).logicalRange).not.toEqual(before);
  await expect(row(page, 'LINKUSDT')).toHaveAttribute('aria-current', 'true');
});

test('Delete and the right-click menu remove rows, and the list is saved', async ({
  page,
  market,
}) => {
  await openChart(page);
  await row(page, 'BATUSDT').click();
  await page.keyboard.press('Delete');
  await expect(row(page, 'BATUSDT')).toHaveCount(0);
  await expect(row(page, 'ARBUSDT')).toBeFocused();

  await row(page, 'MANAUSDT').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Remove from watchlist/ }).click();
  await expect(row(page, 'MANAUSDT')).toHaveCount(0);

  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections[0]?.symbols.length)
    .toBe(DEFAULT_TICKERS.length - 2);
  await openChart(page); // reload: the gateway kept it
  await expect
    .poll(() => tickers(page))
    .toEqual(DEFAULT_TICKERS.filter((ticker) => ticker !== 'BATUSDT' && ticker !== 'MANAUSDT'));
});

test('rows drag to a new place', async ({ page, market }) => {
  await openChart(page);
  await row(page, 'IOTAUSDT').dragTo(row(page, 'LINKUSDT'), { targetPosition: { x: 20, y: 4 } });
  await expect
    .poll(() => tickers(page))
    .toEqual(['XRPUSDT', 'IOTAUSDT', ...DEFAULT_TICKERS.slice(1, -1)]);
  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections[0]?.symbols[1])
    .toBe('BINANCE:IOTAUSDT');
});

test('a section folds away and stays folded', async ({ page, market }) => {
  await openChart(page);
  await panel(page).getByRole('button', { name: 'Crypto' }).click();
  await expect(row(page, 'LINKUSDT')).toHaveCount(0);
  await expect.poll(() => market.watchlistSaves.at(-1)?.sections[0]?.collapsed).toBe(true);
  await openChart(page);
  await expect(panel(page).getByRole('button', { name: 'Crypto' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('a symbol the exchange does not list shows in red, without prices', async ({
  page,
  market,
  consoleGuard,
}) => {
  consoleGuard.allow(/404/);
  market.watchlist = {
    sections: [
      {
        id: 'crypto',
        title: 'Crypto',
        collapsed: false,
        symbols: ['BINANCE:XRPUSDT', 'BINANCE:XCHUSDT'],
      },
    ],
  };
  await openChart(page);
  await expect(row(page, 'XCHUSDT')).toHaveAttribute('data-unavailable', 'true');
  await expect(row(page, 'XCHUSDT').locator('span').nth(2)).toHaveCSS('color', 'rgb(247, 82, 95)');
  await expect(row(page, 'XCHUSDT')).toHaveText(/^XXCHUSDT$/);
});

test('a list that could not load is retried, and never overwritten meanwhile', async ({
  page,
  market,
  consoleGuard,
}) => {
  consoleGuard.allow(/ERR_CONNECTION_REFUSED|Failed to load resource/);
  market.failWatchlistLoads(true);
  await openChart(page);
  await expect.poll(() => market.refusedWatchlistLoads()).toBeGreaterThan(0);
  expect(await tickers(page)).toEqual([]);
  // Nothing to edit, so nothing can be saved over the stored list.
  await page.keyboard.press('Delete');
  market.failWatchlistLoads(false);
  await expect.poll(() => tickers(page), { timeout: 10_000 }).toEqual(DEFAULT_TICKERS);
  expect(market.watchlistSaves).toEqual([]);
});

test('rows and columns line up with the reference', async ({ page }) => {
  await openChart(page);
  const box = async (locator: ReturnType<Page['locator']>) => {
    const value = await locator.boundingBox();
    if (!value) throw new Error('not visible');
    return value;
  };
  const aside = await box(panel(page));
  const first = await box(row(page, 'XRPUSDT'));
  const second = await box(row(page, 'LINKUSDT'));
  // docs/reference/01-chart-layout.png: 30 px rows, the list 81 px below the panel's top and
  // its first row under a 30 px pinned section header.
  expect(second.y - first.y).toBe(30);
  expect(first.height).toBe(30);
  expect(first.y - aside.y).toBe(111);
  expect(first.width).toBe(aside.width);
});
