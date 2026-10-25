import type { Locator, Page } from '@playwright/test';
import { CAP_QUOTES, capScale, chartPriceLabel, expect, openChart, test } from './fixtures';

/**
 * CRYPTOCAP's market caps and dominance (docs/SPEC.md §5.10), against the mock gateway, with
 * the values and formats of the user's TradingView screenshots 20–22.
 */
const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const row = (page: Page, symbol: string) => watchlist(page).locator(`[data-symbol="${symbol}"]`);
const field = (page: Page, name: string) => page.locator(`[data-field="${name}"]`);
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add symbol' });
const option = (dialog: Locator, symbol: string) =>
  dialog.locator(`[role="option"][data-symbol="${symbol}"]`);

/** The mock's latest daily bar, scaled to TOTAL2: O 1.3115 H 1.3126 L 1.2902 C 1.2955. */
const TOTAL2 = (price: number) => price * capScale('CRYPTOCAP:TOTAL2');

test("TOTAL2's legend and price scale read like TradingView's: names and trillions", async ({
  page,
}) => {
  await openChart(page, '/?symbol=CRYPTOCAP:TOTAL2&interval=1D');
  await expect(field(page, 'title')).toHaveText(
    'Crypto Total Market Cap Excluding BTC, $ · 1D · CRYPTOCAP',
  );
  // The live bar's prices in trillions (1.05T, 1.06T, 1.04T, 1.04T), its change in billions.
  await expect(field(page, 'open')).toHaveText('1.05T');
  await expect(field(page, 'high')).toHaveText('1.06T');
  await expect(field(page, 'low')).toHaveText('1.04T');
  await expect(field(page, 'close')).toHaveText('1.04T');
  await expect(field(page, 'change')).toHaveText(/^[+−]\d+(\.\d+)?B \([+−]\d+\.\d{2}%\)$/);
  expect(await chartPriceLabel(page, 1.8e12)).toBe('1.8T');
  expect(await chartPriceLabel(page, 1.76e12)).toBe('1.76T');
  expect(await chartPriceLabel(page, TOTAL2(1.2955))).toBe('1.04T');
  // CRYPTOCAP's badge, not a coin's logo.
  await expect(page.locator('[data-book] svg circle')).toHaveAttribute('fill', '#2962FF');
});

test('Sell and Buy show the whole market cap, digit by digit', async ({ page, market }) => {
  await openChart(page, '/?symbol=CRYPTOCAP:TOTAL2&interval=1D');
  const value = CAP_QUOTES['CRYPTOCAP:TOTAL2']?.last ?? 0;
  await market.sendBook(value, value);
  await expect(field(page, 'bid')).toHaveText('1,041,724,313,303');
  await expect(field(page, 'ask')).toHaveText('1,041,724,313,303');
  await expect(field(page, 'spread')).toHaveText('0');
  // The boxes grow to fit the number, side by side (screenshot 21: 140 px each, 24 px apart).
  const box = async (name: string) => (await field(page, name).boundingBox()) ?? { x: 0, width: 0 };
  const [sell, spread, buy] = [await box('sell'), await box('spread'), await box('buy')];
  expect(sell.width).toBeGreaterThan(130);
  expect(sell.width).toBeLessThan(150);
  expect(buy.width).toBeCloseTo(sell.width, 0);
  expect(spread.x).toBeGreaterThanOrEqual(sell.x + sell.width - 0.5);
  expect(buy.x).toBeGreaterThanOrEqual(spread.x + spread.width - 0.5);
  expect(buy.x - (sell.x + sell.width)).toBeGreaterThan(18);
  expect(buy.x - (sell.x + sell.width)).toBeLessThan(30);
});

test("a dominance keeps its decimals and the coin's logo", async ({ page }) => {
  await openChart(page, '/?symbol=CRYPTOCAP:BTC.D&interval=1D');
  await expect(field(page, 'title')).toHaveText('Market Cap BTC Dominance, % · 1D · CRYPTOCAP');
  await expect(field(page, 'close')).toHaveText(/^\d+\.\d{2}$/);
  expect(await chartPriceLabel(page, 60.734)).toBe('60.73');
  await expect(page.locator('[data-book] svg circle[fill="#2962FF"]')).toHaveCount(0);
});

test('watchlist rows: market caps in T and B, dominance in its decimals', async ({
  page,
  market,
}) => {
  market.watchlist = {
    sections: [
      {
        id: 'caps',
        title: 'MARKET CAP WISE',
        collapsed: false,
        symbols: ['CRYPTOCAP:TOTAL', 'CRYPTOCAP:TOTAL2', 'CRYPTOCAP:BTC.D'],
      },
    ],
  };
  await openChart(page);
  // Screenshot 21: TOTAL 2.65T −36.71B −1.36%; TOTAL2 1.04T −18.03B −1.70%.
  await expect(row(page, 'CRYPTOCAP:TOTAL')).toHaveText(/TOTAL\s*2\.65T\s*−36\.71B\s*−1\.36%$/);
  await expect(row(page, 'CRYPTOCAP:TOTAL2')).toHaveText(/TOTAL2\s*1\.04T\s*−18\.03B\s*−1\.70%$/);
  // Screenshot 20: BTC.D 60.73 0.13 0.21%.
  await expect(row(page, 'CRYPTOCAP:BTC.D')).toHaveText(/BTC\.D\s*60\.73\s*0\.13\s*0\.21%$/);
  // TOTAL's badge; BTC.D asks for Bitcoin's logo.
  await expect(row(page, 'CRYPTOCAP:TOTAL').locator('svg circle')).toHaveAttribute(
    'fill',
    '#2962FF',
  );
  await expect(row(page, 'CRYPTOCAP:BTC.D').locator('svg circle[fill="#2962FF"]')).toHaveCount(0);
  await expect(row(page, 'CRYPTOCAP:BTC.D')).not.toHaveAttribute('data-unavailable', 'true');
});

test('search finds TOTAL and its kin under CRYPTOCAP, typed as an index', async ({ page }) => {
  await openChart(page);
  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  await addDialog(page).getByRole('combobox').fill('TOTAL');
  const total = option(addDialog(page), 'CRYPTOCAP:TOTAL');
  await expect(total).toBeVisible();
  await expect(total).toContainText('Crypto Total Market Cap, $');
  await expect(total).toContainText('index crypto');
  await expect(total).toContainText('CRYPTOCAP');
  await expect(total.locator('svg circle').first()).toHaveAttribute('fill', '#2962FF');
  const symbols = await addDialog(page)
    .getByRole('option')
    .evaluateAll((rows) => rows.map((element) => element.getAttribute('data-symbol')));
  expect(symbols.slice(0, 3)).toEqual(['CRYPTOCAP:TOTAL', 'CRYPTOCAP:TOTAL2', 'CRYPTOCAP:TOTAL3']);
});
