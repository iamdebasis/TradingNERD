import type { Locator, Page } from '@playwright/test';
import { expect, openChart, test } from './fixtures';

/**
 * Bitstamp (docs/SPEC.md §5.12), the sixth exchange, against the mock gateway: found in search
 * and its source filter, charted as Bitstamp describes its pairs, and live in the watchlist,
 * formulas too, as the user's TradingView list has them.
 */
const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const row = (page: Page, symbol: string) => watchlist(page).locator(`[data-symbol="${symbol}"]`);
const legend = (page: Page, name: string) => page.locator(`[data-field="${name}"]`);
const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Symbol search' });
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add symbol' });
const results = (dialog: Locator) =>
  dialog
    .getByRole('option')
    .evaluateAll((rows) => rows.map((element) => element.getAttribute('data-symbol')));

test("Bitstamp's pairs are found by its name and charted as Bitstamp describes them", async ({
  page,
  market,
}) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Symbol search: XRPUSDT' }).click();
  const dialog = searchDialog(page);
  await dialog.getByRole('combobox').fill('BITSTAMP:XRP');
  await expect.poll(() => results(dialog)).toEqual(['BITSTAMP:XRPUSD', 'BITSTAMP:XRPBTC']);
  await expect(dialog.locator('[data-symbol="BITSTAMP:XRPUSD"]')).toContainText('Bitstamp');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  // Its own description, as TradingView shows Bitstamp's, and its five decimals.
  await expect(legend(page, 'title')).toHaveText('XRP / U.S. dollar · 1D · Bitstamp');
  await expect.poll(() => market.barRequests.at(-1)?.get('symbol')).toBe('BITSTAMP:XRPUSD');
  await market.sendBook(1.29352, 1.29359);
  await expect(legend(page, 'bid')).toHaveText('1.29352');
  await expect(legend(page, 'ask')).toHaveText('1.29359');
});

test('the source filter lists Bitstamp and shows its pairs alone', async ({ page, market }) => {
  await openChart(page);
  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  const dialog = addDialog(page);
  await dialog.getByRole('combobox').fill('XRP');
  await dialog.getByRole('button', { name: 'All sources' }).click();
  await dialog.getByRole('menuitemradio', { name: 'Bitstamp' }).click();
  await expect.poll(() => results(dialog)).toEqual(['BITSTAMP:XRPUSD', 'BITSTAMP:XRPBTC']);
  expect(market.searchRequests.at(-1)?.get('exchange')).toBe('BITSTAMP');
});

test('your Bitstamp rows from TradingView are live, and the formula made of one', async ({
  page,
  market,
}) => {
  market.watchlist = {
    sections: [
      {
        id: 'b',
        title: 'BITSTAMP',
        collapsed: false,
        symbols: ['BITSTAMP:XRPUSD', 'BITSTAMP:BTCUSD', 'CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD'],
      },
    ],
  };
  await openChart(page);
  // As Bitstamp's quotes read on 25 October: XRPUSD to five decimals, BTCUSD to two.
  await expect(row(page, 'BITSTAMP:XRPUSD')).toHaveText(/XRPUSD\s*1\.29475\s*−0\.00311\s*−0\.24%$/);
  await expect(row(page, 'BITSTAMP:BTCUSD')).toHaveText(
    /BTCUSD\s*80,344\.53\s*−427\.42\s*−0\.53%$/,
  );
  // TOTAL2 over Bitstamp's XRPUSD: in billions, as your TradingView list shows it (817.2B then).
  const formula = row(page, 'CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD');
  await expect(formula).toHaveText(/^TTOTAL2\/XRPUSD\s*804\.58B\s*−11\.96B\s*−1\.47%$/);
  await expect(formula).not.toHaveAttribute('data-unavailable', 'true');
});
