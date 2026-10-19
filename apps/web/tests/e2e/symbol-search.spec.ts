import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { expect, openChart, test } from './fixtures';

/**
 * TradingView's "Add symbol" dialog and the chart's symbol search (docs/SPEC.md §5.4), against
 * the mock gateway, which ranks its catalog with the gateway's own search.
 */
const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add symbol' });
const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Symbol search' });
const field = (dialog: Locator) => dialog.getByRole('combobox');
const result = (dialog: Locator, symbol: string) =>
  dialog.locator(`[role="option"][data-symbol="${symbol}"]`);
const results = (dialog: Locator) =>
  dialog
    .getByRole('option')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-symbol')));
const savedSymbols = (saves: { sections: { symbols: string[] }[] }[]) =>
  saves.at(-1)?.sections.flatMap((section) => section.symbols) ?? [];

async function openAddSymbol(page: Page) {
  await openChart(page);
  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  await expect(addDialog(page)).toBeVisible();
  await expect(field(addDialog(page))).toBeFocused();
}

const XRP_PAIRS = [
  'BINANCE:XRPUSDT',
  'COINBASE:XRPUSD',
  'BINANCE:XRPUSDC',
  'BINANCE:XRPEUR',
  'BINANCE:XRPTRY',
  'BINANCE:XRPBTC',
  'BINANCE:XRPU',
];

test('typing XRP lists every exchange, one row per pair, the matches highlighted', async ({
  page,
}) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('XRP');
  // Most traded first: XRPUSDT across five exchanges, then Coinbase and Kraken's XRPUSD, …
  await expect.poll(() => results(addDialog(page))).toEqual(XRP_PAIRS);

  const xrp = result(addDialog(page), 'BINANCE:XRPUSDT');
  await expect(xrp).toContainText('XRP / TetherUS');
  await expect(xrp).toContainText('spot crypto');
  await expect(xrp).toContainText('Binance');
  await expect(xrp.locator('mark').first()).toHaveText('XRP');
  await expect(xrp.locator('mark').first()).toHaveCSS('color', 'rgb(41, 98, 255)');

  // The other exchanges listing XRPUSDT, most traded first, each one a price source to pick.
  await xrp.getByRole('button', { name: /Show the exchanges/ }).click();
  await expect
    .poll(() => results(addDialog(page)))
    .toEqual([
      'BINANCE:XRPUSDT',
      'OKX:XRPUSDT',
      'BYBIT:XRPUSDT',
      'KRAKEN:XRPUSDT',
      'COINBASE:XRPUSDT',
      ...XRP_PAIRS.slice(1),
    ]);
  const okx = result(addDialog(page), 'OKX:XRPUSDT');
  await expect(okx).toContainText('OKX');
  await expect(okx.getByRole('button', { name: 'Add to watchlist' })).toBeEnabled();
  await xrp.getByRole('button', { name: /Hide the exchanges/ }).click();
  await expect(result(addDialog(page), 'OKX:XRPUSDT')).toHaveCount(0);
});

test('rows already in the watchlist offer remove and locate', async ({ page, market }) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('XRP');
  const xrp = result(addDialog(page), 'BINANCE:XRPUSDT');
  await expect(xrp.getByRole('button', { name: 'Show in watchlist' })).toBeVisible();
  await expect(
    result(addDialog(page), 'BINANCE:XRPUSDC').getByRole('button', { name: 'Add to watchlist' }),
  ).toBeEnabled();

  await xrp.getByRole('button', { name: 'Remove from watchlist' }).click();
  await expect.poll(() => savedSymbols(market.watchlistSaves)).not.toContain('BINANCE:XRPUSDT');
  await expect(xrp.getByRole('button', { name: 'Add to watchlist' })).toBeVisible();
  await expect(watchlist(page).getByRole('button', { name: 'XRPUSDT', exact: true })).toHaveCount(
    0,
  );
  // Typing carries on where it was.
  await expect(field(addDialog(page))).toBeFocused();
});

test('Enter adds the top match and keeps the dialog open; ↓ picks; Shift+Enter adds and closes', async ({
  page,
  market,
}) => {
  await openAddSymbol(page);
  const input = field(addDialog(page));
  await input.fill('xrp/usdc');
  await expect(result(addDialog(page), 'BINANCE:XRPUSDC')).toBeVisible();
  await page.keyboard.press('Enter');
  // Added at the end of the section, as the row below the last one.
  await expect.poll(() => savedSymbols(market.watchlistSaves).at(-1)).toBe('BINANCE:XRPUSDC');
  await expect(addDialog(page)).toBeVisible();
  await expect(
    result(addDialog(page), 'BINANCE:XRPUSDC').getByRole('button', { name: 'Show in watchlist' }),
  ).toBeVisible();

  await input.fill('XRP');
  await expect.poll(() => results(addDialog(page))).toEqual(XRP_PAIRS);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(result(addDialog(page), 'BINANCE:XRPTRY')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(result(addDialog(page), 'BINANCE:XRPEUR')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Shift+Enter');
  await expect(addDialog(page)).toHaveCount(0);
  await expect
    .poll(() => savedSymbols(market.watchlistSaves).slice(-2))
    .toEqual(['BINANCE:XRPUSDC', 'BINANCE:XRPEUR']);
  await expect(watchlist(page).getByRole('button', { name: 'XRPEUR', exact: true })).toBeVisible();
});

test('Shift+click adds and closes; Escape and a press outside close', async ({ page, market }) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('XRP');
  await result(addDialog(page), 'BINANCE:XRPBTC').click({ modifiers: ['Shift'] });
  await expect(addDialog(page)).toHaveCount(0);
  await expect.poll(() => savedSymbols(market.watchlistSaves).at(-1)).toBe('BINANCE:XRPBTC');

  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  await page.keyboard.press('Escape');
  await expect(addDialog(page)).toHaveCount(0);

  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  await page.mouse.click(5, 500); // outside the dialog
  await expect(addDialog(page)).toHaveCount(0);
});

test('locate shows the symbol in the watchlist and on the chart', async ({ page }) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('link');
  await result(addDialog(page), 'BINANCE:LINKUSDT')
    .getByRole('button', { name: 'Show in watchlist' })
    .click();
  await expect(addDialog(page)).toHaveCount(0);
  await expect(
    watchlist(page).getByRole('button', { name: 'LINKUSDT', exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('symbol')).toBe('BINANCE:LINKUSDT');
});

test("the source filter shows one exchange's pairs; Escape closes the menu first", async ({
  page,
  market,
}) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('XRP');
  await addDialog(page).getByRole('button', { name: 'All sources' }).click();
  await addDialog(page).getByRole('menuitemradio', { name: 'Kraken' }).click();
  await expect.poll(() => results(addDialog(page))).toEqual(['KRAKEN:XRPUSD', 'KRAKEN:XRPUSDT']);
  expect(market.searchRequests.at(-1)?.get('exchange')).toBe('KRAKEN');
  await expect(addDialog(page).getByRole('button', { name: 'Kraken' })).toBeVisible();

  await addDialog(page).getByRole('button', { name: 'Kraken' }).click();
  await expect(addDialog(page).getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(addDialog(page).getByRole('menu')).toHaveCount(0);
  await expect(addDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(addDialog(page)).toHaveCount(0);
});

test('symbol search, from the pill or a letter typed on the chart, switches the chart', async ({
  page,
  market,
}) => {
  await openChart(page);
  await page.getByRole('button', { name: 'Symbol search: XRPUSDT' }).click();
  await expect(searchDialog(page)).toBeVisible();
  await expect(searchDialog(page).getByText('to add symbol and close dialog')).toHaveCount(0);
  await field(searchDialog(page)).fill('LDO');
  const ldo = result(searchDialog(page), 'BINANCE:LDOUSDT');
  await expect(ldo).toBeVisible();
  await expect(ldo.getByRole('button')).toHaveCount(0); // nothing to add here
  await page.keyboard.press('Enter');
  await expect(searchDialog(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('symbol')).toBe('BINANCE:LDOUSDT');
  await expect.poll(() => market.barRequests.at(-1)?.get('symbol')).toBe('BINANCE:LDOUSDT');

  // As on TradingView, a letter typed on the chart starts a search with it.
  await page.locator('main').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('x');
  await expect(searchDialog(page)).toBeVisible();
  await expect(field(searchDialog(page))).toHaveValue('x');
  await expect.poll(() => results(searchDialog(page))).toContain('BINANCE:XRPUSDT');
  await page.keyboard.press('Escape');
  await expect(searchDialog(page)).toHaveCount(0);
});

test("a pair only exchanges without live data list can't be picked yet", async ({
  page,
  market,
}) => {
  market.liveExchanges.delete('KRAKEN'); // as when an exchange's feed isn't built
  await openChart(page);
  await page.getByRole('button', { name: 'Symbol search: XRPUSDT' }).click();
  await field(searchDialog(page)).fill('XBT');
  const xbt = result(searchDialog(page), 'KRAKEN:XBTUSD');
  await expect(xbt).toHaveAttribute('aria-disabled', 'true');
  await expect(xbt).toHaveAttribute('title', "Live data from Kraken isn't available yet");
  await page.keyboard.press('Enter');
  await xbt.click({ force: true }); // a person can still click it; nothing happens
  await expect(searchDialog(page)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('symbol')).toBeNull();
});

test('nothing matching says so', async ({ page }) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('ZZZZ');
  await expect(addDialog(page).getByRole('status')).toHaveText('No symbols match your criteria');
});

test('the most traded pairs show before typing, and scrolling loads more', async ({
  page,
  market,
}) => {
  await openAddSymbol(page);
  await expect.poll(async () => (await results(addDialog(page))).length).toBe(50);
  expect((await results(addDialog(page)))[0]).toBe('BINANCE:BTCUSDT');
  await addDialog(page)
    .getByRole('listbox')
    .evaluate((list) => {
      list.scrollTop = list.scrollHeight;
    });
  await expect.poll(async () => (await results(addDialog(page))).length).toBeGreaterThan(50);
  expect(market.searchRequests.at(-1)?.get('offset')).toBe('50');
});

test('the dialog is laid out as in the reference', async ({ page }) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('XRP');
  await expect.poll(() => results(addDialog(page))).toEqual(XRP_PAIRS);
  const dialog = await box(addDialog(page));
  const at = async (locator: Locator) => {
    const b = await box(locator);
    return { x: b.x - dialog.x, y: b.y - dialog.y, width: b.width, height: b.height };
  };
  // docs/reference/04-add-symbol.png, in CSS px from the dialog's top-left.
  expect({ width: dialog.width, height: dialog.height }).toEqual({ width: 840, height: 680 });
  expect(await at(addDialog(page).locator('div:has(> [role="combobox"])'))).toEqual({
    x: 20,
    y: 68,
    width: 800,
    height: 40,
  });
  expect(await at(addDialog(page).getByRole('tab', { name: 'All' }))).toEqual({
    x: 20,
    y: 124,
    width: expect.closeTo(40, 0),
    height: 28,
  });
  const first = await at(result(addDialog(page), 'BINANCE:XRPUSDT'));
  expect(first).toMatchObject({ x: 0, y: 205, height: 40 });
  const single = result(addDialog(page), 'BINANCE:XRPTRY');
  const plus = await at(single.getByRole('button', { name: 'Add to watchlist' }));
  expect(plus).toMatchObject({ x: 751, width: 28 });
  const locate = await at(
    result(addDialog(page), 'BINANCE:XRPUSDT').getByRole('button', { name: 'Show in watchlist' }),
  );
  expect(locate.x).toBe(787);
});

// ---- pixels: what the reference and ours share, compared device pixel by device pixel ----

const REFERENCE = fileURLToPath(
  new URL('../../../../docs/reference/04-add-symbol.png', import.meta.url),
);
/** The reference crop starts 7 CSS px left of and 9 above the dialog. */
const CROP = { left: 7, top: 9, width: 849, height: 695 };

function grayDifference(a: PNG, b: PNG, x0: number, y0: number, x1: number, y1: number) {
  // CSS px rectangle, relative to the dialog; compared at 2× on the green channel (grays).
  let total = 0;
  let count = 0;
  for (let y = (CROP.top + y0) * 2; y < (CROP.top + y1) * 2; y++) {
    for (let x = (CROP.left + x0) * 2; x < (CROP.left + x1) * 2; x++) {
      const i = (y * a.width + x) * 4 + 1;
      total += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
      count++;
    }
  }
  return total / count;
}

test('title, search field, chips, filters and footer match the reference pixel for pixel', async ({
  page,
}) => {
  await openAddSymbol(page);
  // As in the reference: "XRP" typed, the Crypto chip chosen (so "All" is plain).
  await addDialog(page).getByRole('tab', { name: 'Crypto' }).click();
  await field(addDialog(page)).fill('XRP');
  await expect.poll(() => results(addDialog(page))).toEqual(XRP_PAIRS);
  await page.mouse.move(5, 5);
  const dialog = await box(addDialog(page));
  const ours = PNG.sync.read(
    await page.screenshot({
      clip: {
        x: dialog.x - CROP.left,
        y: dialog.y - CROP.top,
        width: CROP.width,
        height: CROP.height,
      },
    }),
  );
  const reference = PNG.sync.read(readFileSync(REFERENCE));
  expect([ours.width, ours.height]).toEqual([reference.width, reference.height]);
  const regions: [string, number, number, number, number][] = [
    ['title', 18, 20, 132, 50],
    ['close', 792, 20, 820, 48],
    ['search field, up to the text cursor', 18, 66, 86, 110],
    ['search field, after the text cursor', 92, 66, 822, 110],
    ['"All" chip', 18, 122, 62, 154],
    ['filters', 18, 164, 420, 200],
    ['footer', 0, 640, 840, 680],
  ];
  for (const [name, x0, y0, x1, y1] of regions) {
    expect(grayDifference(ours, reference, x0, y0, x1, y1), name).toBeLessThan(1.5);
  }
});

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error('not visible');
  return value;
}

test('a pair from another exchange is added, ticks in the watchlist and charts', async ({
  page,
  market,
}) => {
  await openAddSymbol(page);
  await field(addDialog(page)).fill('XBT');
  const xbt = result(addDialog(page), 'KRAKEN:XBTUSD');
  await expect(xbt).toContainText('Kraken');
  await xbt.getByRole('button', { name: 'Add to watchlist' }).click({ modifiers: ['Shift'] });
  await expect(addDialog(page)).toHaveCount(0);
  await expect.poll(() => savedSymbols(market.watchlistSaves).at(-1)).toBe('KRAKEN:XBTUSD');

  const row = watchlist(page).getByRole('button', { name: 'XBTUSD', exact: true });
  await expect(row).toContainText(/\d\.\d/); // its quote arrived
  await market.sendQuote('KRAKEN:XBTUSD', 82_706.7, 81_000);
  await expect(row).toContainText('82706.7');
  await row.click();
  await expect(page.getByText('Bitcoin / US Dollar · 1D · Kraken')).toBeVisible();
  await expect.poll(() => market.barRequests.at(-1)?.get('symbol')).toBe('KRAKEN:XBTUSD');
});

test('the same pair can come from any exchange: the chart says which', async ({ page }) => {
  await openChart(page, '/?symbol=OKX:XRPUSDT');
  await expect(page.getByText('XRP / TetherUS · 1D · OKX')).toBeVisible();
  await openChart(page, '/?symbol=COINBASE:XRPUSD');
  await expect(page.getByText('XRP / US Dollar · 1D · Coinbase')).toBeVisible();
});
