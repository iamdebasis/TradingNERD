import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_WATCHLIST } from '@tradingnerd/core';
import { PNG } from 'pngjs';
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

async function boxOf(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error('not visible');
  return value;
}

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

test("Delete and a row's remove button remove rows, and the list is saved", async ({
  page,
  market,
}) => {
  await openChart(page);
  await row(page, 'BATUSDT').click();
  await page.keyboard.press('Delete');
  await expect(row(page, 'BATUSDT')).toHaveCount(0);
  await expect(row(page, 'ARBUSDT')).toBeFocused();

  // TradingView's row menu has no "Remove" (docs/reference/07-watchlist-row-menu.png).
  await row(page, 'MANAUSDT').hover();
  await panel(page).getByRole('button', { name: 'Remove from watchlist' }).click();
  await expect(row(page, 'MANAUSDT')).toHaveCount(0);

  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections[0]?.symbols.length)
    .toBe(DEFAULT_TICKERS.length - 2);
  await openChart(page); // reload: the gateway kept it
  await expect
    .poll(() => tickers(page))
    .toEqual(DEFAULT_TICKERS.filter((ticker) => ticker !== 'BATUSDT' && ticker !== 'MANAUSDT'));
});

test("a row under the mouse turns the separators' gray and offers a remove button", async ({
  page,
  market,
}) => {
  await openChart(page);
  const link = row(page, 'LINKUSDT');
  await link.hover();
  await expect(link).toHaveCSS('background-color', 'rgb(46, 46, 46)');
  const remove = panel(page).getByRole('button', { name: 'Remove from watchlist' });
  await expect(remove).toHaveCount(1); // the hovered row's only
  await expect(remove).toHaveCSS('background-color', 'rgb(74, 74, 74)');
  // docs/reference/05-watchlist-hover.png: 22 px, 7 px from the row's right edge, centered.
  const [button, line] = [await boxOf(remove), await boxOf(link)];
  expect([button.width, button.height]).toEqual([22, 22]);
  expect(line.x + line.width - (button.x + button.width)).toBe(7);
  expect(button.y - line.y).toBe(3.5);

  // The chart's own row keeps its selection color under the mouse.
  await row(page, 'XRPUSDT').hover();
  await expect(row(page, 'XRPUSDT')).toHaveCSS('background-color', 'rgb(19, 46, 97)');

  await link.hover();
  await remove.click();
  await expect(link).toHaveCount(0);
  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections[0]?.symbols.includes('BINANCE:LINKUSDT'))
    .toBe(false);
  await expect(row(page, 'XRPUSDT')).toHaveAttribute('aria-current', 'true');
});

test('the remove button matches the reference pixel for pixel', async ({ page }) => {
  await openChart(page);
  await row(page, 'LINKUSDT').hover();
  const button = await boxOf(panel(page).getByRole('button', { name: 'Remove from watchlist' }));
  const ours = PNG.sync.read(await page.screenshot({ clip: button }));
  const reference = PNG.sync.read(
    readFileSync(
      fileURLToPath(new URL('../../../../docs/reference/05-watchlist-hover.png', import.meta.url)),
    ),
  );
  // The reference's button, at 2×: its top-left at (578, 337). Grays, so the green channel.
  let total = 0;
  for (let y = 0; y < 44; y++) {
    for (let x = 0; x < 44; x++) {
      const a = ours.data[(y * ours.width + x) * 4 + 1] ?? 0;
      const b = reference.data[((337 + y) * reference.width + 578 + x) * 4 + 1] ?? 0;
      total += Math.abs(a - b);
    }
  }
  expect([ours.width, ours.height]).toEqual([44, 44]);
  expect(total / (44 * 44)).toBeLessThan(1.5);
});

// ---- flags (docs/reference/06-watchlist-flags.png, 07-watchlist-row-menu.png) ----

const palette = (page: Page) => page.getByRole('group', { name: 'Flag color' });
const rowMenu = (page: Page) => page.getByRole('menu', { name: 'Symbol actions' });
const away = (page: Page) => page.mouse.move(600, 500);

test("a click on a set flag takes it off; on a row's gray one it flags in the last color", async ({
  page,
  market,
}) => {
  market.flags = { flags: { 'BINANCE:LINKUSDT': 'blue' }, lastColor: 'green' };
  await openChart(page);
  const flagged = panel(page).getByRole('button', { name: 'LINKUSDT: Blue flag' });
  await expect(flagged).toHaveCSS('color', 'rgb(42, 121, 255)');
  await flagged.click();
  await expect.poll(() => market.flagSaves.at(-1)).toEqual({ flags: {}, lastColor: 'green' });

  await row(page, 'BATUSDT').hover();
  const shadow = panel(page).getByRole('button', { name: 'Flag BATUSDT' });
  await expect(shadow).toHaveCSS('color', 'rgb(74, 74, 74)'); // the header's gray
  await shadow.click();
  await expect.poll(() => market.flagSaves.at(-1)?.flags).toEqual({ 'BINANCE:BATUSDT': 'green' });
  await away(page);
  await expect(panel(page).getByRole('button', { name: 'BATUSDT: Green flag' })).toHaveCSS(
    'color',
    'rgb(129, 199, 132)',
  );
});

test("resting on a flag shows TradingView's colors: one recolors it and is the next flag's", async ({
  page,
  market,
}) => {
  market.flags = { flags: { 'BINANCE:LINKUSDT': 'red' }, lastColor: 'red' };
  await openChart(page);
  const flag = panel(page).getByRole('button', { name: 'LINKUSDT: Red flag' });
  await flag.hover();
  await expect(palette(page)).toBeVisible();
  // As in the reference: the row highlighted, the flag a darker red, its color the ring.
  await expect(row(page, 'LINKUSDT')).toHaveCSS('background-color', 'rgb(46, 46, 46)');
  await expect(flag).toHaveCSS('color', 'rgb(242, 54, 69)');
  const dots = palette(page).getByRole('button');
  expect(
    await dots.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label'))),
  ).toEqual(['Red (remove the flag)', 'Blue', 'Green', 'Yellow', 'Purple', 'Cyan', 'Pink']);
  expect(
    await dots.evaluateAll((items) => items.map((item) => getComputedStyle(item).boxShadow)),
  ).toEqual(['rgb(255, 82, 82) 0px 0px 0px 2px inset', ...Array(6).fill('none')]);

  await palette(page).getByRole('button', { name: 'Purple' }).click();
  await expect(palette(page)).toHaveCount(0);
  await expect
    .poll(() => market.flagSaves.at(-1))
    .toEqual({ flags: { 'BINANCE:LINKUSDT': 'purple' }, lastColor: 'purple' });

  // Leaving the flag hides them; its own color takes the flag off.
  const purple = panel(page).getByRole('button', { name: 'LINKUSDT: Purple flag' });
  await purple.hover();
  await expect(palette(page)).toBeVisible();
  await away(page);
  await expect(palette(page)).toHaveCount(0);
  await purple.hover();
  await palette(page).getByRole('button', { name: 'Purple (remove the flag)' }).click();
  await expect.poll(() => market.flagSaves.at(-1)?.flags).toEqual({});
});

test('the colors point at the flag, centered on its row, their dots as measured', async ({
  page,
  market,
}) => {
  market.flags = { flags: { 'BINANCE:BATUSDT': 'red' }, lastColor: 'red' };
  await openChart(page);
  const bat = row(page, 'BATUSDT');
  const flag = panel(page).getByRole('button', { name: 'BATUSDT: Red flag' });
  await flag.hover();
  await expect(palette(page)).toBeVisible();
  const [line, button] = [await boxOf(bat), await boxOf(flag)];
  expect([button.x, button.width, button.height]).toEqual([line.x, 16, 29]);
  const icon = await boxOf(flag.locator('svg'));
  expect([icon.x - line.x, icon.y - line.y, icon.width, icon.height]).toEqual([0, 8, 12, 13]);
  const body = await boxOf(palette(page).locator('div').first());
  expect([body.x - line.x, body.y - line.y, body.width, body.height]).toEqual([21, -1.5, 176, 32]);
  const dots = await palette(page)
    .getByRole('button')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().x));
  expect(dots.map((x) => x - body.x)).toEqual([8, 32, 56, 80, 104, 128, 152]);
});

test('⌥↵ flags and unflags the selected row', async ({ page, market }) => {
  market.flags = { flags: {}, lastColor: 'cyan' };
  await openChart(page);
  await row(page, 'LINKUSDT').click();
  await page.keyboard.press('Alt+Enter');
  await expect.poll(() => market.flagSaves.at(-1)?.flags).toEqual({ 'BINANCE:LINKUSDT': 'cyan' });
  await page.keyboard.press('Alt+Enter');
  await expect.poll(() => market.flagSaves.at(-1)?.flags).toEqual({});
});

test("a row's right-click menu is TradingView's: flag, colors, unflag all, add section, add symbol", async ({
  page,
  market,
}) => {
  market.flags = {
    flags: { 'BINANCE:LINKUSDT': 'red', 'BINANCE:BATUSDT': 'blue' },
    lastColor: 'red',
  };
  await openChart(page);
  await row(page, 'LINKUSDT').click({ button: 'right' });
  const menu = rowMenu(page);
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Flag/Unflag LINKUSDT⌥ ↵',
    'Unflag all symbols',
    'Add section',
    'Add symbol',
  ]);
  await expect(menu.getByRole('button', { name: 'Red (remove the flag)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await menu.getByRole('button', { name: 'Green' }).click();
  await expect(menu).toHaveCount(0);
  await expect
    .poll(() => market.flagSaves.at(-1))
    .toEqual({
      flags: { 'BINANCE:LINKUSDT': 'green', 'BINANCE:BATUSDT': 'blue' },
      lastColor: 'green',
    });

  await row(page, 'LINKUSDT').click({ button: 'right' });
  await rowMenu(page)
    .getByRole('menuitem', { name: /^Flag\/Unflag LINKUSDT/ })
    .click();
  await expect.poll(() => market.flagSaves.at(-1)?.flags).toEqual({ 'BINANCE:BATUSDT': 'blue' });
  await row(page, 'XRPUSDT').click({ button: 'right' });
  await rowMenu(page).getByRole('menuitem', { name: 'Unflag all symbols' }).click();
  await expect.poll(() => market.flagSaves.at(-1)?.flags).toEqual({});
});

test('Add section starts a section above the row, its name typed at once', async ({
  page,
  market,
}) => {
  await openChart(page);
  await row(page, 'MANAUSDT').click({ button: 'right' });
  await rowMenu(page).getByRole('menuitem', { name: 'Add section' }).click();
  const name = panel(page).getByRole('textbox', { name: 'Section name' });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Section 1');
  await page.keyboard.type('Metaverse');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections.map((s) => [s.title, s.symbols[0]]))
    .toEqual([
      ['Crypto', 'BINANCE:XRPUSDT'],
      ['Metaverse', 'BINANCE:MANAUSDT'],
    ]);

  // A double-click on a section renames it, leaving it open.
  await panel(page).getByRole('button', { name: 'Metaverse', exact: true }).dblclick();
  await expect(name).toBeFocused();
  await page.keyboard.type('Games');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections[1])
    .toMatchObject({ title: 'Games', collapsed: false });
  await expect(row(page, 'MANAUSDT')).toBeVisible();

  // Escape keeps the name it had.
  const saves = market.watchlistSaves.length;
  await panel(page).getByRole('button', { name: 'Games', exact: true }).dblclick();
  await expect(name).toBeFocused();
  await page.keyboard.type('Nope');
  await page.keyboard.press('Escape');
  await expect(name).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Games', exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(market.watchlistSaves.slice(saves).map((save) => save.sections[1]?.title)).not.toContain(
    'Nope',
  );
});

test("Add symbol from a row's menu adds right after that row", async ({ page, market }) => {
  await openChart(page);
  await row(page, 'LINKUSDT').click({ button: 'right' });
  await rowMenu(page).getByRole('menuitem', { name: 'Add symbol' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add symbol' });
  await dialog.getByRole('combobox').fill('XRPUSDC');
  await dialog
    .locator('[role="option"][data-symbol="BINANCE:XRPUSDC"]')
    .getByRole('button', { name: 'Add to watchlist' })
    .click();
  await expect
    .poll(() => market.watchlistSaves.at(-1)?.sections[0]?.symbols.slice(0, 4))
    .toEqual(['BINANCE:XRPUSDT', 'BINANCE:LINKUSDT', 'BINANCE:XRPUSDC', 'BINANCE:BATUSDT']);
});

test("a flag belongs to the symbol: it stays when the row goes and shows when it's back", async ({
  page,
  market,
}) => {
  market.flags = { flags: { 'BINANCE:BATUSDT': 'pink' }, lastColor: 'red' };
  await openChart(page);
  await row(page, 'BATUSDT').click();
  await page.keyboard.press('Delete');
  await expect(row(page, 'BATUSDT')).toHaveCount(0);
  expect(market.flagSaves).toEqual([]);

  await panel(page).getByRole('button', { name: 'Add symbol' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add symbol' });
  await dialog.getByRole('combobox').fill('BATUSDT');
  await dialog
    .locator('[role="option"][data-symbol="BINANCE:BATUSDT"]')
    .getByRole('button', { name: 'Add to watchlist' })
    .click({ modifiers: ['Shift'] });
  await expect(panel(page).getByRole('button', { name: 'BATUSDT: Pink flag' })).toBeVisible();
});

const FLAGS_REFERENCE = fileURLToPath(
  new URL('../../../../docs/reference/06-watchlist-flags.png', import.meta.url),
);
const MENU_REFERENCE = fileURLToPath(
  new URL('../../../../docs/reference/07-watchlist-row-menu.png', import.meta.url),
);

/** Mean green-channel difference over a 2× box, ours at (ox, oy), the reference's at (rx, ry). */
function grayDiff(
  ours: PNG,
  ox: number,
  oy: number,
  ref: PNG,
  rx: number,
  ry: number,
  w: number,
  h: number,
) {
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ours.data[((oy + y) * ours.width + ox + x) * 4 + 1] ?? 0;
      const b = ref.data[((ry + y) * ref.width + rx + x) * 4 + 1] ?? 0;
      total += Math.abs(a - b);
    }
  }
  return total / (w * h);
}

test('flags and their colors match the reference pixel for pixel', async ({ page, market }) => {
  market.flags = {
    flags: { 'BINANCE:LINKUSDT': 'red', 'BINANCE:BATUSDT': 'red' },
    lastColor: 'red',
  };
  await openChart(page);
  await away(page);
  const reference = PNG.sync.read(readFileSync(FLAGS_REFERENCE));
  const aside = await boxOf(panel(page));

  // The column titles' gray flag, from the line under them (the reference's at y 128, 2×).
  const columns = await boxOf(panel(page).getByText('Symbol', { exact: true }).locator('..'));
  const lineY = columns.y + columns.height - 1;
  const header = PNG.sync.read(
    await page.screenshot({ clip: { x: aside.x, y: lineY - 24, width: 16, height: 24 } }),
  );
  expect(grayDiff(header, 0, 0, reference, 12, 128 - 48, 32, 48), 'header flag').toBeLessThan(1.5);

  // A red flag's shape: the same pixels are red (the reference's first row at y 209, 2×).
  const link = await boxOf(row(page, 'LINKUSDT'));
  const flag = PNG.sync.read(
    await page.screenshot({ clip: { x: link.x, y: link.y, width: 16, height: 29 } }),
  );
  const red = (png: PNG, x: number, y: number) => {
    const i = (y * png.width + x) * 4;
    return (png.data[i] ?? 0) > 150 && (png.data[i + 1] ?? 0) < 130;
  };
  let mismatched = 0;
  for (let y = 0; y < 58; y++) {
    for (let x = 0; x < 32; x++)
      if (red(flag, x, y) !== red(reference, 12 + x, 209 + y)) mismatched++;
  }
  expect(mismatched, 'red flag pixels that differ').toBeLessThan(8);

  // The colors, resting on a red row's flag under a plain one (the reference's at y 629, 2×):
  // their gray halo, arrow and bubble between the dots. (Right of it, the reference row's own
  // price shows, so the halo is compared above.)
  const bat = await boxOf(row(page, 'BATUSDT'));
  await panel(page).getByRole('button', { name: 'BATUSDT: Red flag' }).hover();
  await expect(palette(page)).toBeVisible();
  const shot = PNG.sync.read(
    await page.screenshot({ clip: { x: bat.x, y: bat.y - 8, width: 216, height: 44 } }),
  );
  const regions: [string, number, number, number, number][] = [
    ['halo and bubble above the dots', 30, -12, 372, 22],
    ['arrow', 28, 14, 18, 32],
    ['between the first dots', 90, 14, 16, 32],
  ];
  for (const [name, rx, ry, w, h] of regions) {
    // Our shot starts 8 px (16 at 2×) above the row.
    expect(grayDiff(shot, rx, ry + 16, reference, 12 + rx, 629 + ry, w, h), name).toBeLessThan(1.5);
  }
});

test("the row menu matches TradingView's pixel for pixel", async ({ page, market }) => {
  market.flags = { flags: { 'BINANCE:OPUSDT': 'red' }, lastColor: 'red' };
  await openChart(page);
  const op = await boxOf(row(page, 'OPUSDT'));
  await page.mouse.click(op.x + 120, op.y + 15, { button: 'right' });
  const menu = rowMenu(page);
  await expect(menu).toBeVisible();
  const box = await boxOf(menu);
  expect(box.width).toBe(252);
  // As in the reference, the pointer rests on the colors' row.
  const dots = await boxOf(
    menu.getByRole('button', { name: 'Red (remove the flag)' }).locator('..'),
  );
  await page.mouse.move(box.x + 230, dots.y + 8);
  const ours = PNG.sync.read(await page.screenshot({ clip: box }));
  const reference = PNG.sync.read(readFileSync(MENU_REFERENCE));
  // The reference menu's top-left at (246, 60), 2×. Its middle group (lists, compare, notes) isn't
  // ours, so the last group sits 218 px (2×) higher here. The red ring drawn on it is left out:
  // it crosses the dividers between x 88 and 357.
  const regions: [string, number, number, number, number, number][] = [
    ['top and "Flag/Unflag "', 0, 0, 220, 76, 0],
    ['its shortcut', 380, 0, 124, 76, 0],
    ['the colors row, left of the dots', 0, 76, 82, 64, 0],
    ['the colors row, right of the dots', 454, 76, 50, 64, 0],
    ...[0, 1, 2, 3, 4, 5].map((gap): [string, number, number, number, number, number] => [
      `between dots ${gap + 1} and ${gap + 2}`,
      118 + gap * 56,
      76,
      20,
      64,
      0,
    ]),
    ['"Unflag all symbols"', 0, 140, 504, 66, 0],
    ['the first line, left of the ring', 0, 206, 84, 20, 0],
    ['the first line, right of the ring', 360, 206, 144, 20, 0],
    ['the second line, left of the ring', 0, 424, 84, 16, 218],
    ['the second line, right of the ring', 360, 424, 144, 16, 218],
    ['"Add section" and "Add symbol"', 0, 440, 504, 148, 218],
  ];
  for (const [name, x, y, w, h, shift] of regions) {
    expect(grayDiff(ours, x, y - shift, reference, 246 + x, 60 + y, w, h), name).toBeLessThan(1.5);
  }
  // The dots' shapes, the first one ringed: the same pixels stand out from the row.
  const ink = (png: PNG, x: number, y: number) => {
    const i = (y * png.width + x) * 4;
    return [0, 1, 2].some((c) => Math.abs((png.data[i + c] ?? 0) - 46) > 40);
  };
  let mismatched = 0;
  for (let y = 80; y < 136; y++) {
    for (let x = 82; x < 454; x++)
      if (ink(ours, x, y) !== ink(reference, 246 + x, 60 + y)) mismatched++;
  }
  expect(mismatched, 'dot pixels that differ').toBeLessThan(40);
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
  await expect(row(page, 'XCHUSDT').locator('[data-field="ticker"]')).toHaveCSS(
    'color',
    'rgb(247, 82, 95)',
  );
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
