import type { Locator, Page } from '@playwright/test';
import { expect, openChart, test } from './fixtures';

/**
 * Formulas of symbols, TradingView's spreads (docs/SPEC.md §5.11), against the mock gateway:
 * typed in the symbol search, charted, and kept in the watchlist with the names and formats of
 * the user's TradingView screenshot 22.
 */
const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const row = (page: Page, symbol: string) => watchlist(page).locator(`[data-symbol="${symbol}"]`);
const legend = (page: Page, name: string) => page.locator(`[data-field="${name}"]`);
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add symbol' });
const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Symbol search' });
const field = (dialog: Locator) => dialog.getByRole('combobox');
const result = (dialog: Locator, symbol: string) =>
  dialog.locator(`[role="option"][data-symbol="${symbol}"]`);
const formulaRow = (dialog: Locator) => dialog.locator('[role="option"][data-formula]');
const rowMenu = (page: Page) => page.getByRole('menu', { name: 'Symbol actions' });
const savedSymbols = (saves: { sections: { symbols: string[] }[] }[]) =>
  saves.at(-1)?.sections.flatMap((section) => section.symbols) ?? [];

/** TOTAL less TOTAL2: 2.6529T − 1.0417T now, and 2.6896T − 1.0598T at the last close. */
const TOTAL_LESS_TOTAL2 = 'CRYPTOCAP:TOTAL-CRYPTOCAP:TOTAL2';
/** XRP doubled: 2.591, from 2.623. */
const XRP_TWICE = 'BINANCE:XRPUSDT*2';
/** From the user's TradingView list: USDC from Euronext, which we don't have. */
const BROKEN = 'CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-EURONEXT:USDC';
const FIXED = 'CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-CRYPTOCAP:USDC';

test('symbol search takes a formula: the list finds the symbol being typed, a pick fills it in, Enter charts it', async ({
  page,
  market,
}) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Symbol search: XRPUSDT' }).click();
  const dialog = searchDialog(page);
  await field(dialog).fill('CRYPTOCAP:TOTAL / XRPU');
  // Below the formula's own row, the matches for XRPU, the symbol being typed.
  await expect.poll(() => market.searchRequests.at(-1)?.get('query')).toBe('XRPU');
  await expect(formulaRow(dialog)).toContainText('TOTAL/XRPU');
  await expect(formulaRow(dialog)).toContainText('spread');
  await expect(result(dialog, 'BINANCE:XRPUSDT')).toBeVisible();
  // A pick fills it in, with its exchange, and leaves the dialog open. The matches for the
  // symbol picked come late, as from a busy gateway: the row clicked is highlighted no more.
  await page.route(/\/api\/symbols\/search\?.*query=BINANCE%3AXRPUSDT/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fallback();
  });
  await result(dialog, 'BINANCE:XRPUSDT').click();
  await expect(field(dialog)).toHaveValue('CRYPTOCAP:TOTAL / BINANCE:XRPUSDT');
  await expect(field(dialog)).toBeFocused();
  await expect(formulaRow(dialog)).toHaveAttribute(
    'data-symbol',
    'CRYPTOCAP:TOTAL/BINANCE:XRPUSDT',
  );
  await expect(formulaRow(dialog)).toContainText('CRYPTOCAP:TOTAL/BINANCE:XRPUSDT');
  // Enter takes the formula's row.
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('symbol'))
    .toBe('CRYPTOCAP:TOTAL/BINANCE:XRPUSDT');
  await expect
    .poll(() => market.barRequests.at(-1)?.get('symbol'))
    .toBe('CRYPTOCAP:TOTAL/BINANCE:XRPUSDT');
  // TradingView's legend: the tickers, the interval, the first symbol's exchange.
  await expect(legend(page, 'title')).toHaveText('TOTAL/XRPUSDT · 1D · CRYPTOCAP');
  await expect(page.getByRole('button', { name: 'Symbol search: TOTAL/XRPUSDT' })).toBeVisible();
});

test('a pair typed with its slash stays a search; text no symbol matches reads as a formula', async ({
  page,
}) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Symbol search: XRPUSDT' }).click();
  const dialog = searchDialog(page);
  await field(dialog).fill('XRP/USDT');
  await expect(result(dialog, 'BINANCE:XRPUSDT')).toBeVisible();
  await expect(formulaRow(dialog)).toHaveCount(0);
  // TradingView's own example has no spaces: BTCUSDT/XRPUSDT matches no symbol, so it's a formula.
  await field(dialog).fill('BTCUSDT/XRPUSDT');
  await expect(formulaRow(dialog)).toHaveAttribute(
    'data-symbol',
    'BINANCE:BTCUSDT/BINANCE:XRPUSDT',
  );
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('symbol'))
    .toBe('BINANCE:BTCUSDT/BINANCE:XRPUSDT');
});

test('Add symbol adds a formula typed without exchanges, each found as the search finds it', async ({
  page,
  market,
}) => {
  await openChart(page);
  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  const dialog = addDialog(page);
  await field(dialog).fill('total - total2');
  await expect(formulaRow(dialog)).toHaveAttribute('data-symbol', TOTAL_LESS_TOTAL2);
  await expect(formulaRow(dialog)).toContainText('TOTAL-TOTAL2');
  await expect(formulaRow(dialog)).toContainText(TOTAL_LESS_TOTAL2);
  // The matches below fill the symbol in: nothing to add on them.
  await expect(result(dialog, 'CRYPTOCAP:TOTAL2').getByRole('button')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => savedSymbols(market.watchlistSaves).at(-1)).toBe(TOTAL_LESS_TOTAL2);
  // Added: its row offers remove and locate, and Enter adds it only once.
  await expect(
    formulaRow(dialog).getByRole('button', { name: 'Remove from watchlist' }),
  ).toBeVisible();
  const saves = market.watchlistSaves.length;
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(row(page, TOTAL_LESS_TOTAL2)).toBeVisible();
  expect(market.watchlistSaves.length).toBe(saves);
});

test("a formula is missing a symbol: its row says which, until it's typed", async ({ page }) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Symbol search: XRPUSDT' }).click();
  const dialog = searchDialog(page);
  await field(dialog).fill('BINANCE:BTCUSDT / NOPE');
  await expect(formulaRow(dialog)).toHaveAttribute('aria-disabled', 'true');
  await expect(formulaRow(dialog)).toContainText('No symbol NOPE here');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get('symbol')).toBeNull();
});

test("watchlist rows: the tickers, a gray letter, Last in the first symbol's style, Chg in full where it fits (screenshot 22)", async ({
  page,
  market,
}) => {
  market.watchlist = listOf([TOTAL_LESS_TOTAL2, XRP_TWICE]);
  await openChart(page);
  // Its change in full, −18,680,000,000, is wider than the column: in billions, never cut.
  await expect(row(page, TOTAL_LESS_TOTAL2)).toHaveText(
    /^TTOTAL-TOTAL2\s*1\.61T\s*−18\.68B\s*−1\.15%$/,
  );
  await expect(row(page, XRP_TWICE)).toHaveText(/^XXRPUSDT\*2\s*2\.5910\s*−0\.032\s*−1\.22%$/);
  // A row shows its formula on the chart.
  await row(page, XRP_TWICE).click();
  await expect(legend(page, 'title')).toHaveText('XRPUSDT*2 · 1D · Binance');
  await expect.poll(() => new URL(page.url()).searchParams.get('symbol')).toBe(XRP_TWICE);
});

test("the legend: Sell and Buy are the formula's value, and its letter stands for a logo", async ({
  page,
  market,
}) => {
  await openChart(page, `/?symbol=${encodeURIComponent(TOTAL_LESS_TOTAL2)}&interval=1D`);
  await expect(legend(page, 'title')).toHaveText('TOTAL-TOTAL2 · 1D · CRYPTOCAP');
  // The latest bar's close: TOTAL's 2.6529T less TOTAL2's 1.0417T.
  await expect(legend(page, 'close')).toHaveText('1.61T');
  await expect(page.locator('[data-book] > div').first()).toHaveText(/^TTOTAL-TOTAL2 · 1D/);
  await market.sendBook(1_611_175_686_697, 1_611_175_686_697);
  await expect(legend(page, 'bid')).toHaveText('1,611,175,686,697');
  await expect(legend(page, 'ask')).toHaveText('1,611,175,686,697');
  await expect(legend(page, 'spread')).toHaveText('0');
});

test("a formula with a symbol we lack says so, and its row menu offers CRYPTOCAP's in its place", async ({
  page,
  market,
  consoleGuard,
}) => {
  consoleGuard.allow(/status of 404/); // the formula we can't show
  market.flags = { flags: { [BROKEN]: 'red' }, lastColor: 'red' };
  market.watchlist = listOf(['BINANCE:XRPUSDT', BROKEN]);
  await openChart(page);
  const broken = row(page, BROKEN);
  await expect(broken).toHaveAttribute('data-unavailable', 'true');
  await expect(broken).toHaveAttribute(
    'title',
    "EURONEXT:USDC isn't available here; for USDC's market cap, use CRYPTOCAP:USDC",
  );
  await broken.click({ button: 'right' });
  const items = rowMenu(page).getByRole('menuitem');
  await expect(items.first()).toHaveText('Use CRYPTOCAP:USDC');
  await items.first().click();
  // One click: the fixed formula takes the row's place, its flag with it.
  await expect.poll(() => savedSymbols(market.watchlistSaves)).toEqual(['BINANCE:XRPUSDT', FIXED]);
  await expect.poll(() => market.flagSaves.at(-1)?.flags[FIXED]).toBe('red');
  // Live: its Last, Chg and Chg% show.
  await expect(row(page, FIXED)).toHaveText(/^TTOTAL3-USDT-USDC\s*\S+\s*\S+\s*−?\d+\.\d{2}%$/);
  await expect(row(page, FIXED)).not.toHaveAttribute('data-unavailable', 'true');
  await expect(row(page, FIXED)).toHaveAttribute('aria-label', 'TOTAL3-USDT-USDC');
  // A row with nothing to fix has no such item.
  await row(page, 'BINANCE:XRPUSDT').click({ button: 'right' });
  await expect(rowMenu(page).getByRole('menuitem').first()).toHaveText(/^Flag\/Unflag XRPUSDT/);
});

/** A watchlist of `symbols`, in one section. */
function listOf(symbols: string[]) {
  return { sections: [{ id: 'f', title: 'FORMULAS', collapsed: false, symbols }] };
}
