import type { Page } from '@playwright/test';
import { chartState, chartTimeLabel, expect, openChart, STOCK_NOW, settle, test } from './fixtures';

/**
 * US stocks and funds (docs/SPEC.md §5.7): found under TradingView's Stocks and Funds tabs,
 * charted on New York's sessions 15 minutes late with TradingView's "D" sign, and the Alpaca
 * key asked for when there is none.
 */

const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add symbol' });
const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const result = (page: Page, id: string) =>
  addDialog(page).locator(`[role="option"][data-symbol="${id}"]`);

/** Opens the app on a weekday in the session (the default pinned clock is a Sunday). */
async function openOnMonday(page: Page, url = '/') {
  await page.clock.setFixedTime(STOCK_NOW);
  return openChart(page, url);
}

test('Stocks and Funds sit beside All and Crypto, each with its own sources', async ({ page }) => {
  await openOnMonday(page);
  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  const tabs = addDialog(page).getByRole('tab');
  await expect(tabs).toHaveText(['All', 'Stocks', 'Funds', 'Crypto']);

  await addDialog(page).getByRole('tab', { name: 'Funds' }).click();
  await addDialog(page).getByRole('combobox').fill('SPY');
  const spy = result(page, 'AMEX:SPY');
  await expect(spy).toContainText('SPY');
  await expect(spy).toContainText('State Street SPDR S&P 500 ETF Trust');
  await expect(spy).toContainText('fund etf');
  await expect(spy).toContainText('NYSE Arca');

  // Crypto ETFs are funds too; the pairs stay under Crypto.
  await addDialog(page).getByRole('combobox').fill('BTC');
  await expect(result(page, 'AMEX:GBTC')).toBeVisible();
  await expect(result(page, 'BINANCE:BTCUSDT')).toHaveCount(0);

  await addDialog(page).getByRole('tab', { name: 'Stocks' }).click();
  await addDialog(page).getByRole('button', { name: 'All sources' }).click();
  const sources = addDialog(page).getByRole('menuitemradio');
  await expect(sources).toHaveCount(5);
  for (const name of ['All sources', 'NASDAQ', 'NYSE', 'NYSE Arca & NYSE American', 'Cboe BZX']) {
    await expect(addDialog(page).getByRole('menuitemradio', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  // The crypto filters are for crypto only.
  await expect(addDialog(page).getByRole('button', { name: 'All types' })).toHaveCount(0);
});

test('a stock charts on New York time, 15 minutes late, with the "D" sign and no Sell/Buy', async ({
  page,
}) => {
  await openOnMonday(page, '/?symbol=NASDAQ:AAPL&interval=60');
  await expect(page.getByText('Apple Inc. · 1h · NASDAQ')).toBeVisible();
  const delayed = page.getByRole('img', { name: 'Data is delayed by 15 minutes' });
  await expect(delayed).toBeVisible();
  await expect(delayed).toHaveText('D');
  await expect(page.locator('[data-field="sell"]')).toBeHidden();

  // Hours from the 09:30 open; the latest is 10:30, all that 15-minute-old data reaches.
  const state = await chartState(page);
  expect(new Date((state.lastBar?.time ?? 0) * 1000).toISOString()).toBe(
    '2026-10-19T14:30:00.000Z',
  );
  expect(await chartTimeLabel(page, Date.parse('2026-10-19T13:30:00Z') / 1000)).toBe(
    "Mon 19 Oct '26  09:30",
  );
  // The 10:30 bar closes at 11:30 New York: the countdown runs to it.
  expect(state.lastPriceLabel?.countdown).toBe('29:55');
});

test("TradingView's countdown rules for delayed data and closed markets", async ({ page }) => {
  // Five-minute bars 15 minutes late have always closed by now: no countdown.
  await openOnMonday(page, '/?symbol=NASDAQ:AAPL&interval=5');
  await expect(page.getByText('Apple Inc. · 5 · NASDAQ')).toBeVisible();
  expect((await chartState(page)).lastPriceLabel?.countdown).toBeNull();

  // Saturday: the market is closed, so no bar is waiting to close.
  await page.clock.setFixedTime(Date.parse('2026-10-24T15:00:00Z'));
  await openChart(page, '/?symbol=NASDAQ:AAPL&interval=1D');
  await expect(page.getByText('Apple Inc. · 1D · NASDAQ')).toBeVisible();
  await settle(page);
  expect((await chartState(page)).lastPriceLabel?.countdown).toBeNull();
});

test('without a key a stock asks for one, and once saved the chart loads', async ({
  page,
  market,
  consoleGuard,
}) => {
  consoleGuard.allow(/status of 424/); // the gateway's "needs your Alpaca key"
  market.stockKey = { configured: false, source: null, keyId: null, sip: null };
  await page.clock.setFixedTime(STOCK_NOW);
  await page.goto('/?symbol=NYSE:BRK.B&interval=1D');
  const dialog = page.getByRole('dialog', { name: 'US stock data' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('US stock data needs your Alpaca key')).toBeVisible();

  await dialog.getByRole('textbox', { name: 'API key ID' }).fill('nope');
  await dialog.getByLabel('Secret key').fill('short');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toContainText("Alpaca didn't accept the key");

  await dialog.getByRole('textbox', { name: 'API key ID' }).fill('PKTESTKEYID123456789');
  await dialog.getByLabel('Secret key').fill('testsecret0000000000000000000000000000000');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toContainText('✓ Key works · free plan: 15 minutes delayed');
  expect(market.savedStockKeys.at(-1)).toEqual({
    keyId: 'PKTESTKEYID123456789',
    secret: 'testsecret0000000000000000000000000000000',
  });
  // Only the masked ID ever comes back.
  await expect(dialog).toContainText('••••6789');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Berkshire Hathaway Inc. · 1D · NYSE')).toBeVisible();
});

test("the ⋯ menu opens the stock data dialog, which shows the key's plan", async ({ page }) => {
  await openOnMonday(page);
  await watchlist(page).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'US stock data (Alpaca)…' }).click();
  const dialog = page.getByRole('dialog', { name: 'US stock data' });
  await expect(dialog).toContainText('Key ID ••••6789 · free plan: 15 minutes delayed');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
});

test('a stock goes into the watchlist and onto the chart', async ({ page, market }) => {
  await openOnMonday(page);
  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  await addDialog(page).getByRole('tab', { name: 'Stocks' }).click();
  await addDialog(page).getByRole('combobox').fill('AAPL');
  await result(page, 'NASDAQ:AAPL')
    .getByRole('button', { name: 'Add to watchlist' })
    .click({ modifiers: ['Shift'] });
  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections[0]?.symbols)
    .toContain('NASDAQ:AAPL');
  const row = watchlist(page).getByRole('button', { name: 'AAPL', exact: true });
  await expect(row).toContainText(/\d\.\d/);
  await market.sendQuote('NASDAQ:AAPL', 231.45, 229.1);
  await expect(row).toContainText('231.45');
  await row.click();
  await expect(page.getByText('Apple Inc. · 1D · NASDAQ')).toBeVisible();
});
