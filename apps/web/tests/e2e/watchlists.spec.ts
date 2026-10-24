import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, openChart, test } from './fixtures';

/**
 * Several watchlists, as on TradingView (docs/SPEC.md §5.9): the list menu from the list's
 * name, MY WATCHLISTS with stars and downloads, new lists, copies, renames, clearing, "Open
 * list…" (⇧W) and deleting, and TradingView's .txt in and out.
 */

const panel = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const listMenu = (page: Page) => page.getByRole('menu', { name: 'Watchlist menu' });
const tickers = (page: Page) =>
  panel(page).locator('[data-symbol] [data-field="ticker"]').allTextContents();

async function openListMenu(page: Page) {
  await panel(page)
    .getByRole('button', { name: /: list menu$/ })
    .click();
  await expect(listMenu(page)).toBeVisible();
}

const myLists = (page: Page) => listMenu(page).getByRole('menuitemradio').allTextContents();

/** A list exported by TradingView (the user's, 2026-10-24). */
const TRADINGVIEW_FILE =
  '###MARKET CAP WISE,GLASSNODE:BTC_HASHRATE,CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD,CRYPTOCAP:SUI,' +
  'CRYPTOCAP:HBAR,CRYPTOCAP:LUNC,CRYPTOCAP:BTC.D,CRYPTOCAP:ETH.D,CRYPTOCAP:USDT.D,CRYPTOCAP:XRP.D,' +
  'BITSTAMP:USDTUSD,BYBIT:SNTUSDT.P,BINANCE:VETUSDT,BINANCE:SHIBUSDT,BINANCE:PEPEUSDT,' +
  '###CRYPTO ETFS,AMEX:GBTC,AMEX:XXRP,AMEX:ETHE,OTC:LTCN,NASDAQ:HYPG,AMEX:GSOL,OTC:FILG,OTC:BCHG,' +
  'OTC:GBAT,OTC:MANA,AMEX:SBIT,NASDAQ:ETHA,NASDAQ:IBIT,NASDAQ:THYP,NYSE:STWD,OTC:NTDOY,NASDAQ:CSX,' +
  'NYSE:IRM,NYSE:SUI,AMEX:AVUV,NASDAQ:NTES,AMEX:IJS,NYSE:DLR,NYSE:AMT,NASDAQ:HGX,NASDAQ:GSOX,' +
  'NASDAQ:GSOXNR,NASDAQ:GSOXTR,###USA SECTOR WISE 🇺🇸,CBOE:SIXT,CBOE:SIXRE,CBOE:SIXC,CBOE:SIXM,' +
  'CBOE:SIXU,CBOE:SIXR,CBOE:SIXB,CBOE:SIXE,CBOE:SIXI,CBOE:SIXV,CBOE:SIXY,###USA PRIVATE CREDIT';

test("the list's name opens TradingView's list menu, with MY WATCHLISTS", async ({ page }) => {
  await openChart(page);
  await openListMenu(page);
  await expect(listMenu(page).getByRole('menuitem')).toHaveText([
    'Make a copy…',
    'Rename',
    'Add section',
    'Clear list',
    'Create new list…',
    'Upload list…',
    'Open list…⇧ W',
  ]);
  await expect(listMenu(page).getByText('My watchlists')).toBeVisible();
  const open = listMenu(page).getByRole('menuitemradio', { name: 'Watchlist' });
  await expect(open).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(listMenu(page)).toHaveCount(0);
});

test('Create new list opens an empty list; MY WATCHLISTS switches back', async ({
  page,
  market,
}) => {
  await openChart(page);
  const before = await tickers(page);
  await openListMenu(page);
  await listMenu(page).getByRole('menuitem', { name: 'Create new list…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create new list' });
  await dialog.getByRole('textbox', { name: 'List name' }).fill('Swing trades');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(panel(page).getByRole('button', { name: 'Swing trades: list menu' })).toBeVisible();
  await expect(panel(page).getByText('This list is empty. Add symbols with +.')).toBeVisible();
  expect(await tickers(page)).toEqual([]);

  await openListMenu(page);
  expect(await myLists(page)).toEqual(['Swing trades', 'Watchlist']);
  await listMenu(page).getByRole('menuitemradio', { name: 'Watchlist' }).click();
  await expect.poll(() => tickers(page)).toEqual(before);
  expect(market.activeId).toBe('watchlist');
});

test('Make a copy names it "Watchlist (1)" and opens it, with the same symbols', async ({
  page,
  market,
}) => {
  await openChart(page);
  const before = await tickers(page);
  await openListMenu(page);
  await listMenu(page).getByRole('menuitem', { name: 'Make a copy…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a copy' });
  await expect(dialog.getByRole('textbox', { name: 'List name' })).toHaveValue('Watchlist (1)');
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(panel(page).getByRole('button', { name: 'Watchlist (1): list menu' })).toBeVisible();
  await expect.poll(() => tickers(page)).toEqual(before);
  expect(market.lists.map((list) => list.name)).toEqual(['Watchlist', 'Watchlist (1)']);
});

test('Rename types the name in place; Clear list empties it after asking', async ({
  page,
  market,
}) => {
  await openChart(page);
  await openListMenu(page);
  await listMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
  const input = panel(page).getByRole('textbox', { name: 'List name' });
  await input.fill('Crypto');
  await input.press('Enter');
  await expect(panel(page).getByRole('button', { name: 'Crypto: list menu' })).toBeVisible();
  expect(market.lists[0]?.name).toBe('Crypto');

  await openListMenu(page);
  await listMenu(page).getByRole('menuitem', { name: 'Clear list' }).click();
  const confirm = page.getByRole('dialog', { name: 'Clear list' });
  await expect(confirm).toContainText('Remove every symbol and section from “Crypto”?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect((await tickers(page)).length).toBeGreaterThan(0);
  await openListMenu(page);
  await listMenu(page).getByRole('menuitem', { name: 'Clear list' }).click();
  await page
    .getByRole('dialog', { name: 'Clear list' })
    .getByRole('button', { name: 'Clear' })
    .click();
  await expect.poll(() => tickers(page)).toEqual([]);
  await expect.poll(() => market.watchlistSaves.at(-1)?.sections).toEqual([]);
});

test('a star puts a list first; ⤓ downloads it as TradingView .txt', async ({ page, market }) => {
  market.lists.push({
    id: 'mag7',
    name: 'Mag 7',
    favorite: false,
    sections: [
      { id: 's1', title: 'BIG TECH', collapsed: false, symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
    ],
  });
  await openChart(page);
  await openListMenu(page);
  expect(await myLists(page)).toEqual(['Mag 7', 'Watchlist']);
  // A list's star and download show under the mouse.
  await listMenu(page).getByRole('menuitemradio', { name: 'Watchlist' }).hover();
  await listMenu(page).getByRole('button', { name: 'Star Watchlist' }).click();
  await expect.poll(() => myLists(page)).toEqual(['Watchlist', 'Mag 7']);
  await expect(listMenu(page).getByRole('button', { name: 'Star Watchlist' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(market.lists[0]?.favorite).toBe(true);

  const download = page.waitForEvent('download');
  await listMenu(page).getByRole('menuitemradio', { name: 'Mag 7' }).hover();
  await listMenu(page).getByRole('button', { name: 'Download Mag 7' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Mag 7.txt');
  expect(readFileSync(await file.path(), 'utf8')).toBe('###BIG TECH,NASDAQ:AAPL,NASDAQ:MSFT');
});

test("Upload list reads TradingView's .txt into a new list, and it downloads back the same", async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(/404/); // the symbols we don't chart
  await openChart(page);
  await openListMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await listMenu(page).getByRole('menuitem', { name: 'Upload list…' }).click();
  await (await chooser).setFiles({
    name: 'MARKET LISTS.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(TRADINGVIEW_FILE),
  });
  await expect(panel(page).getByRole('button', { name: 'MARKET LISTS: list menu' })).toBeVisible();
  await expect(panel(page).getByRole('status')).toHaveText(
    'Uploaded “MARKET LISTS”: 53 symbols in 4 sections',
  );
  const headers = panel(page).locator('section > button[aria-expanded]');
  await expect(headers).toHaveText([
    'MARKET CAP WISE',
    'CRYPTO ETFS',
    'USA SECTOR WISE 🇺🇸',
    'USA PRIVATE CREDIT',
  ]);
  // Kept, in red: the ones we can't chart; GBTC charts.
  const spread = panel(page).locator('[data-symbol="CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD"]');
  await expect(spread).toHaveAttribute('data-unavailable', 'true');
  await expect(spread.locator('[data-field="ticker"]')).toHaveText('TOTAL2/BITSTAMP:XRPUSD');
  await expect(panel(page).locator('[data-symbol="AMEX:GBTC"]')).not.toHaveAttribute(
    'data-unavailable',
  );

  await openListMenu(page);
  const download = page.waitForEvent('download');
  await listMenu(page).getByRole('menuitemradio', { name: 'MARKET LISTS' }).hover();
  await listMenu(page).getByRole('button', { name: 'Download MARKET LISTS' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('MARKET LISTS.txt');
  expect(readFileSync(await file.path(), 'utf8')).toBe(TRADINGVIEW_FILE);
});

test('symbols above the first section have no header, as on TradingView', async ({ page }) => {
  await openChart(page);
  await openListMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await listMenu(page).getByRole('menuitem', { name: 'Upload list…' }).click();
  await (await chooser).setFiles({
    name: 'quick.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('BINANCE:XRPUSDT\nBINANCE:LINKUSDT\n###LATER\nBINANCE:OPUSDT\nXRPUSDT\n'),
  });
  await expect(panel(page).getByRole('status')).toHaveText(
    'Uploaded “quick”: 3 symbols in 1 section; 1 left out (repeats or no exchange)',
  );
  await expect(panel(page).locator('section > button[aria-expanded]')).toHaveText(['LATER']);
  expect(await tickers(page)).toEqual(['XRPUSDT', 'LINKUSDT', 'OPUSDT']);
});

test('Open list (⇧W) finds a list, opens it, and deletes another after asking', async ({
  page,
  market,
}) => {
  market.lists.push(
    { id: 'mag7', name: 'Mag 7', favorite: false, sections: [] },
    { id: 'w2', name: 'w2', favorite: false, sections: [] },
  );
  await openChart(page);
  await page.keyboard.press('Shift+W');
  const dialog = page.getByRole('dialog', { name: 'Open list' });
  const lists = dialog.getByRole('list', { name: 'Your watchlists' });
  await expect(lists.getByRole('listitem')).toHaveCount(3);
  await dialog.getByRole('searchbox', { name: 'Search lists' }).fill('mag');
  await expect(lists.getByRole('listitem')).toHaveCount(1);
  await dialog.getByRole('searchbox', { name: 'Search lists' }).fill('');

  await lists.getByRole('listitem').filter({ hasText: 'w2' }).hover();
  await dialog.getByRole('button', { name: 'Delete w2' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete list' });
  await expect(confirm).toContainText('Delete “w2” and its sections?');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(lists.getByRole('listitem')).toHaveCount(2);
  expect(market.lists.map((list) => list.id)).toEqual(['watchlist', 'mag7']);

  await lists.getByRole('button', { name: /^Mag 7/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Mag 7: list menu' })).toBeVisible();
});

test("the last list can't be deleted", async ({ page }) => {
  await openChart(page);
  await openListMenu(page);
  await listMenu(page).getByRole('menuitem', { name: 'Open list…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open list' });
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
});

test('Add section from the list menu starts one above the selected row', async ({ page }) => {
  await openChart(page);
  await openListMenu(page);
  await listMenu(page).getByRole('menuitem', { name: 'Add section' }).click();
  const name = panel(page).getByRole('textbox', { name: 'Section name' });
  await expect(name).toBeFocused();
  await name.fill('FIRST');
  await name.press('Enter');
  await expect(panel(page).locator('section > button[aria-expanded]').first()).toHaveText('Crypto');
  await expect(panel(page).locator('section > button[aria-expanded]').nth(1)).toHaveText('FIRST');
});
