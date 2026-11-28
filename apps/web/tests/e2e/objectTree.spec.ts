import type { Locator, Page } from '@playwright/test';
import {
  type Bar,
  type Drawing,
  type DrawingTool,
  defaultVisibility,
  newDrawing,
} from '@tradingnerd/core';
import { chartBars, chartCall, chartState, expect, openChart, paneOrigin, test } from './fixtures';

/**
 * The Object tree, milestone D3c1 (docs/SPEC.md §5.27): the right toolbar's "Object tree and data
 * window" button and its panel in the watchlist's place; the chart's objects in paint order, the
 * top row at the back; selection shared with the chart; a row's padlock, eye and trash; dragging
 * drawings to change their visual order; renaming; the tree's menus; "Hide" and "Object Tree…"
 * in the chart's drawing menu; the left toolbar's Remove objects as TradingView's; and a removed
 * indicator's drawings dropped for every symbol (§11, item 159). Ctrl/⌘ is ControlOrMeta.
 */

const SYMBOL = 'BINANCE:XRPUSDT';
const SYMBOL_ROW = 'XRPUSDT · BINANCE, 1D';

interface Pt {
  x: number;
  y: number;
}

interface DrawingsDebug {
  drawings: Drawing[];
  selection: string[];
  shapes: { id: string; pane: number }[];
}

type DebugWindow = {
  __tradingNerd?: { chart: { debugDrawings(): DrawingsDebug } | null };
};

async function drawingsState(page: Page): Promise<DrawingsDebug> {
  const state = await page.evaluate(
    () => (window as unknown as DebugWindow).__tradingNerd?.chart?.debugDrawings() ?? null,
  );
  if (!state) throw new Error('The chart is not mounted');
  return state;
}

const drawingsOf = async (page: Page) => (await drawingsState(page)).drawings;
const selectionOf = async (page: Page) => (await drawingsState(page)).selection;
const idsOf = async (page: Page) => (await drawingsOf(page)).map((drawing) => drawing.id);
const shownIds = async (page: Page) =>
  [...new Set((await drawingsState(page)).shapes.map((shape) => shape.id))].sort();
const find = async (page: Page, id: string) =>
  (await drawingsOf(page)).find((drawing) => drawing.id === id);

async function pointOf(page: Page, bar: number, price: number): Promise<Pt> {
  const origin = await paneOrigin(page);
  const x = await chartCall<number | null>(page, 'barX', bar);
  const y = await chartCall<number | null>(page, 'priceToY', price);
  if (x === null || y === null) throw new Error(`Bar ${bar} at ${price} is not on the chart`);
  return { x: origin.x + x, y: origin.y + y };
}

async function spots(page: Page) {
  const state = await chartState(page);
  const range = state.logicalRange;
  const prices = state.priceRange;
  if (!range || !prices) throw new Error('The chart has no range yet');
  return {
    left: Math.round(range.from + (range.to - range.from) * 0.3),
    right: Math.round(range.from + (range.to - range.from) * 0.6),
    low: prices.from + (prices.to - prices.from) * 0.3,
    high: prices.from + (prices.to - prices.from) * 0.7,
    mid: prices.from + (prices.to - prices.from) * 0.5,
  };
}
type Spots = Awaited<ReturnType<typeof spots>>;

async function stored(
  page: Page,
  id: string,
  tool: DrawingTool,
  points: [number, number][],
  more: Partial<Drawing> = {},
): Promise<Drawing> {
  const bars = await chartBars(page);
  return {
    ...newDrawing(
      id,
      tool,
      points.map(([bar, price]) => ({ time: (bars[bar] as Bar).time, price })),
    ),
    ...more,
  };
}

/** Two trend lines apart from each other: `a` low on the left, `b` higher on the right. */
async function twoLines(
  page: Page,
  { left, right, low, high, mid }: Spots,
  b: Partial<Drawing> = {},
) {
  const quarter = Math.round((right - left) / 4);
  return [
    await stored(page, 'a', 'trend-line', [
      [left, low],
      [left + quarter, mid],
    ]),
    await stored(
      page,
      'b',
      'trend-line',
      [
        [right - quarter, mid],
        [right, high],
      ],
      b,
    ),
  ];
}

/** The chart, opened with these drawings stored for its symbol. */
async function openWith(
  page: Page,
  market: { drawings: Map<string, Drawing[]> },
  make: (at: Spots) => Promise<Drawing[]>,
): Promise<Spots> {
  await openChart(page);
  const at = await spots(page);
  const drawings = await make(at);
  market.drawings.set(SYMBOL, drawings);
  await page.reload();
  await openChart(page);
  await expect.poll(async () => (await drawingsOf(page)).length).toBe(drawings.length);
  return at;
}

async function middleOf(page: Page, drawing: Drawing): Promise<Pt> {
  const bars = await chartBars(page);
  const bar = (time: number) => bars.findIndex((item) => item.time === time);
  const [p, q] = drawing.points;
  if (!p || !q) throw new Error('not a line');
  const from = await pointOf(page, bar(p.time), p.price);
  const to = await pointOf(page, bar(q.time), q.price);
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

const panelsOf = (page: Page) => page.getByRole('navigation', { name: 'Panels' });
const treeButton = (page: Page) =>
  panelsOf(page).getByRole('button', { name: 'Object tree and data window' });
const treePanel = (page: Page) => page.getByRole('complementary', { name: 'Object tree panel' });
const treeOf = (page: Page) => treePanel(page).getByRole('tree', { name: 'Objects' });
/** The tree's rows' names, top to bottom. */
const rowsOf = (page: Page) => treeOf(page).getByRole('treeitem').locator('[class*="label"]');
/** A row by its key: "symbol", "d:<drawing id>" or "i:<indicator id>". */
const rowOf = (page: Page, key: string) => treeOf(page).locator(`[data-row="${key}"]`);
const drawingTools = (page: Page) => page.getByRole('navigation', { name: 'Drawing tools' });

async function openTree(page: Page): Promise<void> {
  await treeButton(page).click();
  await expect(treePanel(page)).toBeVisible();
}

async function addIndicator(page: Page, name: 'Relative Strength Index' | 'Volume') {
  await page.getByRole('banner').getByRole('button', { name: 'Indicators', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Indicators, metrics, and strategies' });
  await dialog.getByRole('option', { name }).click();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
}

/** Drags a row to just before another (or after it, the last row), in steps, as a hand does. */
async function dragRow(page: Page, from: string, to: string, where: 'before' | 'after') {
  const source = await rowOf(page, from).boundingBox();
  const target = await rowOf(page, to).boundingBox();
  if (!source || !target) throw new Error('no rows');
  await page.mouse.move(source.x + 80, source.y + source.height / 2);
  await page.mouse.down();
  const y = where === 'before' ? target.y + 4 : target.y + target.height - 4;
  await page.mouse.move(source.x + 90, y, { steps: 8 });
  await page.mouse.up();
}

const menuItems = (menu: Locator) => menu.locator(':scope > [role="menuitem"]');
const treeMenu = (page: Page) => page.getByRole('menu', { name: 'Object tree' });

test.describe('the Object tree’s panel (D3c)', () => {
  test('opens from the right toolbar in the watchlist’s place; alerts take its place; its button closes it', async ({
    page,
  }) => {
    await openChart(page);
    await expect(treeButton(page)).toHaveAttribute('aria-pressed', 'false');
    await openTree(page);
    await expect(treeButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('complementary', { name: 'Watchlist' })).toBeHidden();
    // Its switch: the Object tree; the Data window comes later.
    const tabs = treePanel(page).getByRole('tablist');
    await expect(tabs.getByRole('tab', { name: 'Object tree' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(tabs.getByRole('tab', { name: 'Data window' })).toBeDisabled();
    // Nothing selected: Clone is greyed out. The symbol's row alone, in bold.
    await expect(treePanel(page).getByRole('button', { name: 'Clone' })).toBeDisabled();
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW]);
    await expect(rowOf(page, 'symbol').locator('[class*="label"]')).toHaveCSS('font-weight', '600');
    // Kept open across a reload, as the alert manager is.
    await page.reload();
    await openChart(page);
    await expect(treePanel(page)).toBeVisible();
    // The alert manager takes its place; closed, it leaves the watchlist, not the tree.
    const alerts = page.getByRole('complementary', { name: 'Alerts panel' });
    await panelsOf(page).getByRole('button', { name: 'Alerts' }).click();
    await expect(alerts).toBeVisible();
    await expect(treePanel(page)).toBeHidden();
    await panelsOf(page).getByRole('button', { name: 'Alerts' }).click();
    await expect(page.getByRole('complementary', { name: 'Watchlist' })).toBeVisible();
    await expect(treePanel(page)).toBeHidden();
    // Its own button takes the place back from the alert manager.
    await panelsOf(page).getByRole('button', { name: 'Alerts' }).click();
    await treeButton(page).click();
    await expect(treePanel(page)).toBeVisible();
    await expect(alerts).toBeHidden();
    // A click on its lit button closes it: the watchlist shows again.
    await treeButton(page).click();
    await expect(treePanel(page)).toBeHidden();
    await expect(page.getByRole('complementary', { name: 'Watchlist' })).toBeVisible();
  });

  test('lists the chart’s objects in paint order, the top row at the back, each pane in turn', async ({
    page,
    market,
  }) => {
    await openChart(page);
    await addIndicator(page, 'Relative Strength Index');
    await addIndicator(page, 'Volume');
    const at = await spots(page);
    const lines = await twoLines(page, at, { name: 'Neckline' });
    market.drawings.set(SYMBOL, [
      ...lines,
      await stored(page, 'u', 'horizontal-line', [[at.left, at.mid]], { below: true }),
      await stored(page, 'r', 'horizontal-line', [[at.left, 50]], { pane: 'rsi-1' }),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(4);
    await openTree(page);
    await expect(rowsOf(page)).toHaveText([
      // The price pane: the drawing sent under the bars, the bars, Volume over them, then the
      // drawings over everything, the last drawn at the bottom.
      'Horizontal line',
      SYMBOL_ROW,
      'Vol · XRP',
      'Trendline',
      'Neckline',
      // RSI's pane after it.
      'RSI 14 close',
      'Horizontal line',
    ]);
    await expect(treeOf(page).getByRole('treeitem')).toHaveCount(7);
    expect(
      await treeOf(page)
        .locator('[data-row]')
        .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.row)),
    ).toEqual(['d:u', 'symbol', 'i:volume-1', 'd:a', 'd:b', 'i:rsi-1', 'd:r']);
  });
});

test.describe('selecting in the Object tree (D3c)', () => {
  test('selects on the chart from its rows, with Ctrl/⌘ and Shift, and its rows from the chart', async ({
    page,
    market,
  }) => {
    await openWith(page, market, async (at) => [
      await stored(page, 'u', 'horizontal-line', [[at.left, at.mid]], { below: true }),
      ...(await twoLines(page, at)),
    ]);
    await openTree(page);
    await rowOf(page, 'd:a').click();
    await expect.poll(() => selectionOf(page)).toEqual(['a']);
    await expect(rowOf(page, 'd:a')).toHaveAttribute('aria-selected', 'true');
    // The chart shows it selected: its floating toolbar, as TradingView's does.
    await expect(page.getByRole('toolbar', { name: 'Drawing toolbar' })).toBeVisible();
    await rowOf(page, 'd:b').click({ modifiers: ['ControlOrMeta'] });
    await expect.poll(() => selectionOf(page)).toEqual(['a', 'b']);
    await rowOf(page, 'd:a').click({ modifiers: ['ControlOrMeta'] });
    await expect.poll(() => selectionOf(page)).toEqual(['b']);
    // Shift: every drawing from the row last clicked (a, by its Ctrl/⌘ + click), across the
    // symbol's row, which isn't one.
    await rowOf(page, 'd:u').click({ modifiers: ['Shift'] });
    await expect.poll(async () => (await selectionOf(page)).sort()).toEqual(['a', 'u']);
    await expect(rowOf(page, 'symbol')).toHaveAttribute('aria-selected', 'false');
    // From the chart: a click on b's line selects its row alone.
    const b = await find(page, 'b');
    if (!b) throw new Error('no b');
    const at = await middleOf(page, b);
    await page.mouse.click(at.x, at.y);
    await expect(rowOf(page, 'd:b')).toHaveAttribute('aria-selected', 'true');
    await expect(rowOf(page, 'd:a')).toHaveAttribute('aria-selected', 'false');
    // The symbol's row: selected in the tree alone, the drawings let go.
    await rowOf(page, 'symbol').click();
    await expect.poll(() => selectionOf(page)).toEqual([]);
    await expect(rowOf(page, 'symbol')).toHaveAttribute('aria-selected', 'true');
    await expect(rowOf(page, 'd:b')).toHaveAttribute('aria-selected', 'false');
  });

  test('dims the rows that can’t join the drawings selected while Ctrl/⌘ is held', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    await openTree(page);
    await rowOf(page, 'd:a').click();
    await expect.poll(() => selectionOf(page)).toEqual(['a']);
    await page.keyboard.down('ControlOrMeta');
    await expect(rowOf(page, 'symbol')).toHaveAttribute('data-dim', 'true');
    await expect(rowOf(page, 'd:b')).not.toHaveAttribute('data-dim', 'true');
    await page.keyboard.up('ControlOrMeta');
    await expect(rowOf(page, 'symbol')).not.toHaveAttribute('data-dim', 'true');
  });
});

test.describe('a row’s buttons (D3c)', () => {
  test('hides, shows, locks and removes a drawing from its row, each an undo step', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    await openTree(page);
    const row = rowOf(page, 'd:a');
    // Its buttons show under the pointer only.
    await expect(row.getByRole('button', { name: 'Hide' })).toBeHidden();
    await row.hover();
    await row.getByRole('button', { name: 'Hide' }).click();
    await expect.poll(async () => (await find(page, 'a'))?.hidden).toBe(true);
    await expect.poll(() => shownIds(page)).toEqual(['b']);
    await expect(row).toHaveAttribute('data-hidden', 'true');
    // A hidden row keeps its crossed eye without the pointer.
    await page.mouse.move(5, 300);
    await expect(row.getByRole('button', { name: 'Show' })).toBeVisible();
    await row.getByRole('button', { name: 'Show' }).click();
    await expect.poll(() => shownIds(page)).toEqual(['a', 'b']);
    // Locked: its padlock stays, and it can't be removed until it's unlocked.
    await row.hover();
    await row.getByRole('button', { name: 'Lock' }).click();
    await expect.poll(async () => (await find(page, 'a'))?.locked).toBe(true);
    await expect(row.getByRole('button', { name: 'Remove' })).toBeDisabled();
    await page.mouse.move(5, 300);
    await expect(row.getByRole('button', { name: 'Unlock' })).toBeVisible();
    await row.getByRole('button', { name: 'Unlock' }).click();
    await row.hover();
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => idsOf(page)).toEqual(['b']);
    await expect(row).toHaveCount(0);
    await expect.poll(() => market.drawings.get(SYMBOL)?.map((d) => d.id)).toEqual(['b']);
    // Undo brings it back, then unlocks it again, one step at a time.
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(() => idsOf(page)).toEqual(['a', 'b']);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await find(page, 'a'))?.locked).toBe(true);
  });

  test('hides, shows and removes an indicator from its row', async ({ page }) => {
    await openChart(page);
    await addIndicator(page, 'Volume');
    await openTree(page);
    const row = rowOf(page, 'i:volume-1');
    await row.hover();
    // An indicator has no padlock.
    await expect(row.getByRole('button', { name: 'Lock' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Hide' }).click();
    await expect(page.locator('[data-indicator="volume-1"]')).toHaveAttribute(
      'data-hidden',
      'true',
    );
    await expect(row).toHaveAttribute('data-hidden', 'true');
    await row.getByRole('button', { name: 'Show' }).click();
    await expect(page.locator('[data-indicator="volume-1"]')).not.toHaveAttribute(
      'data-hidden',
      'true',
    );
    await row.hover();
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('[data-indicator="volume-1"]')).toHaveCount(0);
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW]);
  });
});

test.describe('dragging and renaming in the Object tree (D3c)', () => {
  test('drags a drawing to change its visual order, across the bars too, as one undo step', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at, { name: 'Neckline' }));
    await openTree(page);
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW, 'Trendline', 'Neckline']);
    // Below Neckline: in front of it.
    await dragRow(page, 'd:a', 'd:b', 'after');
    await expect.poll(() => idsOf(page)).toEqual(['b', 'a']);
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW, 'Neckline', 'Trendline']);
    // Above the symbol's row: under the bars.
    await dragRow(page, 'd:a', 'symbol', 'before');
    await expect.poll(async () => (await find(page, 'a'))?.below).toBe(true);
    await expect(rowsOf(page)).toHaveText(['Trendline', SYMBOL_ROW, 'Neckline']);
    await expect
      .poll(() => market.drawings.get(SYMBOL)?.find((d) => d.id === 'a')?.below)
      .toBe(true);
    // The row dragged is selected, as TradingView's is.
    await expect.poll(() => selectionOf(page)).toEqual(['a']);
    // Each drop is one undo step.
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await find(page, 'a'))?.below).toBe(false);
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW, 'Neckline', 'Trendline']);
  });

  test('renames a drawing: its row clicked again once selected, Rename, and its settings’ title', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    await openTree(page);
    const row = rowOf(page, 'd:a');
    const field = row.getByRole('textbox', { name: 'Name' });
    await row.click();
    await expect.poll(() => selectionOf(page)).toEqual(['a']);
    // A second click, not a double click, on the row selected.
    await page.waitForTimeout(700);
    await row.click();
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Trendline');
    await field.fill('Neckline');
    await field.press('Enter');
    await expect(row).toContainText('Neckline');
    await expect.poll(async () => (await find(page, 'a'))?.name).toBe('Neckline');
    await expect.poll(() => market.drawings.get(SYMBOL)?.[0]?.name).toBe('Neckline');
    // Rename from its menu; Escape leaves the name as it was.
    await row.click({ button: 'right' });
    await treeMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await field.fill('Something else');
    await field.press('Escape');
    await expect(field).toBeHidden();
    await expect(row).toContainText('Neckline');
    // A double click opens its settings, titled with its name; the pencil renames it for Ok.
    await row.dblclick();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Neckline');
    await expect(field).toBeHidden();
    await dialog.getByRole('button', { name: 'Rename' }).click();
    const title = dialog.getByRole('textbox', { name: 'Name' });
    await expect(title).toHaveValue('Neckline');
    await title.fill('Support');
    await title.press('Enter');
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Support');
    // Escape in the field left the dialog open; Ok keeps the name, as one undo step.
    await dialog.getByRole('button', { name: 'Ok' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await find(page, 'a'))?.name).toBe('Support');
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await find(page, 'a'))?.name).toBe('Neckline');
    // An empty name gives the tool's back.
    await row.click({ button: 'right' });
    await treeMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
    await field.fill('   ');
    await field.press('Enter');
    await expect.poll(async () => (await find(page, 'a'))?.name).toBe('');
    await expect(row).toContainText('Trendline');
  });
});

test.describe('the menus (D3c)', () => {
  test('a drawing’s row menu, several drawings’, and an indicator’s', async ({ page, market }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    await addIndicator(page, 'Volume');
    await openTree(page);
    // One drawing: its right-click selects it.
    await rowOf(page, 'd:a').click({ button: 'right' });
    await expect.poll(() => selectionOf(page)).toEqual(['a']);
    // TradingView's tree menu (43000795451 image 2): Create a group of drawings before Clone.
    await expect(menuItems(treeMenu(page))).toHaveText([
      'Template',
      'Visual order',
      'Visibility on intervals',
      'Create a group of drawings',
      /^Clone(⌘Drag|Ctrl\+Drag)$/,
      /^Copy(⌘C|Ctrl\+C)$/,
      'Rename',
      'Lock',
      'Hide',
      /^Remove(⌫|Del)$/,
      'Settings…',
    ]);
    await page.keyboard.press('Escape');
    // Several: no Rename; Hide hides them all.
    await rowOf(page, 'd:b').click({ modifiers: ['ControlOrMeta'] });
    await expect.poll(() => selectionOf(page)).toEqual(['a', 'b']);
    await rowOf(page, 'd:b').click({ button: 'right' });
    await expect(menuItems(treeMenu(page))).toHaveText([
      'Template',
      'Visual order',
      'Visibility on intervals',
      'Create a group of drawings',
      /^Clone(⌘Drag|Ctrl\+Drag)$/,
      /^Copy(⌘C|Ctrl\+C)$/,
      'Lock',
      'Hide',
      /^Remove(⌫|Del)$/,
      'Settings…',
    ]);
    await treeMenu(page).getByRole('menuitem', { name: 'Hide' }).click();
    await expect.poll(() => shownIds(page)).toEqual([]);
    // A hidden drawing's menu shows it again.
    await rowOf(page, 'd:a').click({ button: 'right' });
    await treeMenu(page).getByRole('menuitem', { name: 'Show' }).click();
    await expect.poll(() => shownIds(page)).toEqual(['a']);
    // Its drawing removed while the menu is open (Delete): the menu closes, and undo leaves it so.
    await rowOf(page, 'd:a').click({ button: 'right' });
    await expect(treeMenu(page)).toBeVisible();
    await page.keyboard.press('Delete');
    await expect.poll(() => idsOf(page)).toEqual(['b']);
    await expect(treeMenu(page)).toBeHidden();
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(() => idsOf(page)).toEqual(['a', 'b']);
    await expect(treeMenu(page)).toBeHidden();
    // An indicator's: Hide, Remove and Settings…, which opens its settings.
    await rowOf(page, 'i:volume-1').click({ button: 'right' });
    await expect(menuItems(treeMenu(page))).toHaveText(['Hide', 'Remove', 'Settings…']);
    await treeMenu(page).getByRole('menuitem', { name: 'Settings…' }).click();
    await expect(page.getByRole('dialog', { name: 'Vol' })).toBeVisible();
  });

  test('the toolbar’s Clone clones the drawings selected, selecting the copies', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    await openTree(page);
    await rowOf(page, 'd:a').click();
    await treePanel(page).getByRole('button', { name: 'Clone' }).click();
    await expect.poll(async () => (await idsOf(page)).length).toBe(3);
    const [, , copy] = await idsOf(page);
    await expect.poll(() => selectionOf(page)).toEqual([copy]);
    await expect(rowOf(page, `d:${copy}`)).toHaveAttribute('aria-selected', 'true');
  });

  test('the chart’s drawing menu hides a drawing, and opens the Object tree over the alerts', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a, b] = await drawingsOf(page);
    if (!a || !b) throw new Error('no drawings');
    const at = await middleOf(page, a);
    await page.mouse.click(at.x, at.y, { button: 'right' });
    const menu = page.getByRole('menu', { name: 'Drawing', exact: true });
    await menu.getByRole('menuitem', { name: 'Hide' }).click();
    await expect.poll(() => shownIds(page)).toEqual(['b']);
    // Hidden, it leaves the selection.
    await expect.poll(() => selectionOf(page)).toEqual([]);
    await panelsOf(page).getByRole('button', { name: 'Alerts' }).click();
    const other = await middleOf(page, b);
    await page.mouse.click(other.x, other.y, { button: 'right' });
    await menu.getByRole('menuitem', { name: 'Object Tree…' }).click();
    await expect(treePanel(page)).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Alerts panel' })).toBeHidden();
    await expect(rowOf(page, 'd:a')).toHaveAttribute('data-hidden', 'true');
    await expect(rowOf(page, 'd:b')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('Remove objects (D3c)', () => {
  test('removes drawings, indicators or both; locked drawings only with Always remove locked drawings', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at, { locked: true }));
    await addIndicator(page, 'Volume');
    await drawingTools(page).getByRole('button', { name: 'Remove objects' }).click();
    const menu = page.getByRole('menu', { name: 'Remove objects' });
    // The locked one isn't counted.
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Remove 1 drawing',
      'Remove 1 indicator',
      'Remove 1 drawing & 1 indicator',
    ]);
    const always = menu.getByRole('menuitemcheckbox', { name: 'Always remove locked drawings' });
    await expect(always).toHaveAttribute('aria-checked', 'false');
    // The switch leaves the menu open, counting the locked one now.
    await always.click();
    await expect(always).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Remove 2 drawings',
      'Remove 1 indicator',
      'Remove 2 drawings & 1 indicator',
    ]);
    await menu.getByRole('menuitem', { name: 'Remove 2 drawings & 1 indicator' }).click();
    await expect.poll(() => idsOf(page)).toEqual([]);
    await expect(page.locator('[data-indicator="volume-1"]')).toHaveCount(0);
    // Undo brings the drawings back; the switch stays on.
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(() => idsOf(page)).toEqual(['a', 'b']);
    await drawingTools(page).getByRole('button', { name: 'Remove objects' }).click();
    await expect(always).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitem', { name: 'Remove 0 indicators' })).toBeDisabled();
    // Off again: the locked one stays.
    await always.click();
    await menu.getByRole('menuitem', { name: 'Remove 1 drawing', exact: true }).click();
    await expect.poll(() => idsOf(page)).toEqual(['b']);
  });

  test('removing an indicator drops its drawings for every symbol at the gateway (§11, item 159)', async ({
    page,
    market,
  }) => {
    await openChart(page);
    await addIndicator(page, 'Relative Strength Index');
    const at = await spots(page);
    market.drawings.set(SYMBOL, [
      await stored(page, 'x', 'horizontal-line', [[at.left, at.mid]]),
      await stored(page, 'r', 'horizontal-line', [[at.left, 50]], { pane: 'rsi-1' }),
    ]);
    market.drawings.set('BINANCE:LINKUSDT', [
      await stored(page, 'k', 'horizontal-line', [[at.left, at.mid]]),
      await stored(page, 'l', 'horizontal-line', [[at.left, 40]], { pane: 'rsi-1' }),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(() => idsOf(page)).toEqual(['x', 'r']);
    const legend = page.locator('[data-indicator="rsi-1"]');
    await legend.hover();
    await legend.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => idsOf(page)).toEqual(['x']);
    await expect.poll(() => market.droppedPanes).toEqual([['rsi-1']]);
    expect(market.drawings.get('BINANCE:LINKUSDT')?.map((d) => d.id)).toEqual(['k']);
    // A new RSI takes the same id: the other symbol's old drawing doesn't come back on it.
    await addIndicator(page, 'Relative Strength Index');
    await page
      .getByRole('complementary', { name: 'Watchlist' })
      .getByRole('button', { name: 'LINKUSDT', exact: true })
      .click();
    await expect.poll(() => idsOf(page)).toEqual(['k']);
  });
});

/** Drags a row onto another's middle (into a group), or to just before or after it at `x`. */
async function dragTo(
  page: Page,
  from: string,
  to: string,
  where: 'onto' | 'before' | 'after',
  x?: number,
) {
  const source = await rowOf(page, from).boundingBox();
  const target = await rowOf(page, to).boundingBox();
  if (!source || !target) throw new Error('no rows');
  await page.mouse.move(source.x + 80, source.y + source.height / 2);
  await page.mouse.down();
  const y =
    where === 'onto'
      ? target.y + target.height / 2
      : where === 'before'
        ? target.y + 4
        : target.y + target.height - 4;
  await page.mouse.move(x ?? source.x + 90, y, { steps: 8 });
  await page.mouse.up();
}

/** Each drawing as "id" or "id(group/…)" with its groups' names, in drawing order. */
const shapeOf = async (page: Page) =>
  (await drawingsOf(page)).map((d) =>
    d.groups.length ? `${d.id}(${d.groups.map((g) => g.name).join('/')})` : d.id,
  );

const GROUP_1 = { id: 'g1', name: 'Group 1' };

/** Two trend lines in Group 1. */
async function grouped(page: Page, at: Spots, a: Partial<Drawing> = {}) {
  const [first, second] = await twoLines(page, at);
  if (!first || !second) throw new Error('no lines');
  return [
    { ...first, ...a, groups: [GROUP_1] },
    { ...second, groups: [GROUP_1] },
  ];
}

test.describe('groups of drawings (D3c2)', () => {
  test('makes a group from the tree’s toolbar where the frontmost drawing is, picked, folded and renamed', async ({
    page,
    market,
  }) => {
    await openWith(page, market, async (at) => [
      ...(await twoLines(page, at)),
      await stored(page, 'c', 'horizontal-line', [[at.left, at.high]]),
    ]);
    await openTree(page);
    const create = treePanel(page).getByRole('button', { name: 'Create a group of drawings' });
    await expect(create).toBeDisabled();
    // a and c, b between them: the group forms where c is, a just behind it.
    await rowOf(page, 'd:a').click();
    await rowOf(page, 'd:c').click({ modifiers: ['ControlOrMeta'] });
    await create.click();
    await expect.poll(() => shapeOf(page)).toEqual(['b', 'a(Group 1)', 'c(Group 1)']);
    await expect
      .poll(() => market.drawingSaves.at(-1)?.drawings[2]?.groups[0]?.name)
      .toBe('Group 1');
    const id = (await find(page, 'a'))?.groups[0]?.id ?? '';
    const head = rowOf(page, `g:${id}`);
    await expect(rowsOf(page)).toHaveText([
      SYMBOL_ROW,
      'Trendline',
      'Group 1',
      'Trendline',
      'Horizontal line',
    ]);
    await expect(rowOf(page, 'd:a')).toHaveAttribute('aria-level', '2');
    // Picked: its row in the selected blue, its drawings' lighter, both selected on the chart.
    await expect(head).toHaveAttribute('data-selected', 'self');
    await expect(rowOf(page, 'd:a')).toHaveAttribute('data-selected', 'inside');
    await expect.poll(async () => (await selectionOf(page)).sort()).toEqual(['a', 'c']);
    // A group picked isn't cloned (TradingView greys Clone out).
    await expect(treePanel(page).getByRole('button', { name: 'Clone' })).toBeDisabled();
    // Folded, its drawings' rows go, and stay folded after a reload.
    await head.getByRole('button', { name: 'Collapse group' }).click();
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW, 'Trendline', 'Group 1']);
    await page.reload();
    await openChart(page);
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW, 'Trendline', 'Group 1']);
    await head.getByRole('button', { name: 'Expand group' }).click();
    await expect(rowsOf(page)).toHaveCount(5);
    // F2 renames it on each of its drawings; undo gives the name back.
    await head.click();
    await head.press('F2');
    const field = treePanel(page).getByRole('textbox', { name: 'Name' });
    await expect(field).toHaveValue('Group 1');
    await field.fill('Levels');
    await field.press('Enter');
    await expect.poll(() => shapeOf(page)).toEqual(['b', 'a(Levels)', 'c(Levels)']);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(() => shapeOf(page)).toEqual(['b', 'a(Group 1)', 'c(Group 1)']);
    // A second group is "Group 2".
    await rowOf(page, 'd:b').click();
    await create.click();
    await expect.poll(() => shapeOf(page)).toEqual(['b(Group 2)', 'a(Group 1)', 'c(Group 1)']);
  });

  test('a group’s eye, padlock and trash act on all in it, partly hidden or locked showing open', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => grouped(page, at));
    await openTree(page);
    const head = rowOf(page, 'g:g1');
    const button = (row: Locator, name: string) => row.getByRole('button', { name, exact: true });
    // a hidden alone: the group's eye stays open; a click hides both, another shows both.
    await rowOf(page, 'd:a').hover();
    await button(rowOf(page, 'd:a'), 'Hide').click();
    await expect.poll(() => shownIds(page)).toEqual(['b']);
    await head.hover();
    await button(head, 'Hide').click();
    await expect.poll(() => shownIds(page)).toEqual([]);
    await page.mouse.move(5, 5);
    await expect(button(head, 'Show')).toBeVisible();
    await button(head, 'Show').click();
    await expect.poll(() => shownIds(page)).toEqual(['a', 'b']);
    // a locked alone: the padlock stays open; a click locks both, and the trash greys out.
    await rowOf(page, 'd:a').hover();
    await button(rowOf(page, 'd:a'), 'Lock').click();
    await head.hover();
    await button(head, 'Lock').click();
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.locked))
      .toEqual([true, true]);
    await expect(button(head, 'Remove')).toBeDisabled();
    await button(head, 'Unlock').click();
    await button(head, 'Remove').click();
    await expect.poll(() => idsOf(page)).toEqual([]);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(() => idsOf(page)).toEqual(['a', 'b']);
  });

  test('drags a drawing onto a group’s row, first in it, and out after its last row', async ({
    page,
    market,
  }) => {
    await openWith(page, market, async (at) => {
      const [a, b] = await twoLines(page, at);
      if (!a || !b) throw new Error('no lines');
      return [{ ...a, groups: [GROUP_1] }, b];
    });
    await openTree(page);
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW, 'Group 1', 'Trendline', 'Trendline']);
    // Folded, it stays folded as b goes in, first (TradingView's Help Center, nested groups).
    await rowOf(page, 'g:g1').getByRole('button', { name: 'Collapse group' }).click();
    await dragTo(page, 'd:b', 'g:g1', 'onto');
    await expect.poll(() => shapeOf(page)).toEqual(['b(Group 1)', 'a(Group 1)']);
    await expect(rowsOf(page)).toHaveText([SYMBOL_ROW, 'Group 1']);
    await rowOf(page, 'g:g1').getByRole('button', { name: 'Expand group' }).click();
    // Out again: after the last row, the pointer at the top level's indent.
    const list = await treeOf(page).boundingBox();
    if (!list) throw new Error('no tree');
    await dragTo(page, 'd:a', 'd:a', 'after', list.x + 10);
    await expect.poll(() => shapeOf(page)).toEqual(['b(Group 1)', 'a']);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(() => shapeOf(page)).toEqual(['b(Group 1)', 'a(Group 1)']);
  });

  test('a paste joins the group picked, and a clone its own group’s front', async ({
    page,
    market,
  }) => {
    await openWith(page, market, async (at) => [
      ...(await grouped(page, at)),
      await stored(page, 'c', 'horizontal-line', [[at.left, at.high]]),
    ]);
    await openTree(page);
    await rowOf(page, 'g:g1').click();
    await expect.poll(async () => (await selectionOf(page)).sort()).toEqual(['a', 'b']);
    await page.keyboard.press('ControlOrMeta+KeyC');
    await page.keyboard.press('ControlOrMeta+KeyV');
    await expect
      .poll(async () => (await shapeOf(page)).map((item) => item.replace(/^d\w+/, 'copy')))
      .toEqual(['a(Group 1)', 'b(Group 1)', 'copy(Group 1)', 'copy(Group 1)', 'c']);
    // The tree's Clone on a drawing of the group: the copy at the group's front.
    await rowOf(page, 'd:a').click({ button: 'right' });
    await treeMenu(page)
      .getByRole('menuitem', { name: /^Clone/ })
      .click();
    await expect
      .poll(async () => (await shapeOf(page)).map((item) => item.replace(/^d\w+/, 'copy')))
      .toEqual([
        'a(Group 1)',
        'b(Group 1)',
        'copy(Group 1)',
        'copy(Group 1)',
        'copy(Group 1)',
        'c',
      ]);
    // A drawing of the group with one outside it: no Visual order, as TradingView's menu.
    await rowOf(page, 'd:a').click();
    await rowOf(page, 'd:c').click({ modifiers: ['ControlOrMeta'] });
    await rowOf(page, 'd:c').click({ button: 'right' });
    await expect(
      treeMenu(page).getByRole('menuitem', { name: 'Visibility on intervals' }),
    ).toBeVisible();
    await expect(treeMenu(page).getByRole('menuitem', { name: 'Visual order' })).toHaveCount(0);
  });

  test('Delete removes a group picked, its hidden drawing too, from its row or the chart', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => grouped(page, at, { hidden: true }));
    await openTree(page);
    // From its row, which has the keyboard once clicked.
    await rowOf(page, 'g:g1').click();
    await expect.poll(() => selectionOf(page)).toEqual(['b']);
    await page.keyboard.press('Delete');
    await expect.poll(() => idsOf(page)).toEqual([]);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(() => idsOf(page)).toEqual(['a', 'b']);
    // From the chart's keys, the tree no longer focused.
    await rowOf(page, 'g:g1').click();
    await expect.poll(() => selectionOf(page)).toEqual(['b']);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Delete');
    await expect.poll(() => idsOf(page)).toEqual([]);
  });

  test('a group’s menu, and its settings titled with its name, which they rename', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => grouped(page, at));
    await openTree(page);
    await rowOf(page, 'g:g1').click({ button: 'right' });
    await expect(menuItems(treeMenu(page))).toHaveText([
      'Rename',
      'Lock',
      'Hide',
      /^Remove(⌫|Del)$/,
      'Settings…',
    ]);
    await treeMenu(page).getByRole('menuitem', { name: 'Settings…' }).click();
    await expect(page.getByRole('dialog', { name: 'Group 1' })).toBeVisible();
    // Renamed in its title, the dialog's name follows the field: found by its role alone.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab')).toHaveText(['Style', 'Displacement', 'Visibility']);
    await dialog.getByRole('button', { name: 'Rename' }).click();
    const name = dialog.getByRole('textbox', { name: 'Name' });
    await name.fill('Weekly analysis');
    await name.press('Enter');
    await dialog.getByRole('button', { name: 'Ok' }).click();
    await expect.poll(() => shapeOf(page)).toEqual(['a(Weekly analysis)', 'b(Weekly analysis)']);
    await expect(rowOf(page, 'g:g1')).toContainText('Weekly analysis');
  });

  test('marks a drawing hidden on this interval with an orange crossed eye, and its group', async ({
    page,
    market,
  }) => {
    const off = defaultVisibility();
    off.days = { ...off.days, on: false };
    await openWith(page, market, async (at) => {
      const [a, b] = await twoLines(page, at, { visibility: off });
      if (!a || !b) throw new Error('no lines');
      return [a, { ...b, groups: [GROUP_1] }];
    });
    await openTree(page);
    await page.mouse.move(5, 5);
    const eye = rowOf(page, 'd:b').getByRole('button', { name: 'Hide' });
    await expect(rowOf(page, 'd:b')).toHaveAttribute('data-off');
    await expect(eye).toHaveAttribute('data-interval');
    await expect(eye).toBeVisible();
    await expect(eye).toHaveCSS('color', 'rgb(251, 140, 0)');
    await expect(rowOf(page, 'g:g1')).toHaveAttribute('data-off');
    await expect(rowOf(page, 'd:a')).not.toHaveAttribute('data-off');
  });

  test('a pitchfork’s kinds in its menu, the one it is checked', async ({ page, market }) => {
    await openWith(page, market, async (at) => [
      await stored(page, 'p', 'pitchfork', [
        [at.left, at.mid],
        [at.right, at.high],
        [at.right, at.low],
      ]),
    ]);
    await openTree(page);
    await rowOf(page, 'd:p').click({ button: 'right' });
    for (const kind of ['Original', 'Schiff', 'Modified Schiff', 'Inside']) {
      await expect(treeMenu(page).getByRole('menuitem', { name: kind, exact: true })).toBeVisible();
    }
    await treeMenu(page).getByRole('menuitem', { name: 'Schiff', exact: true }).click();
    await expect.poll(async () => (await find(page, 'p'))?.tool).toBe('schiff-pitchfork');
  });

  test('the floating toolbar for drawings of different tools offers their background and text colors', async ({
    page,
    market,
  }) => {
    await openWith(page, market, async (at) => [
      ...(await twoLines(page, at)),
      await stored(page, 'c', 'parallel-channel', [
        [at.left, at.low],
        [at.right, at.low],
        [at.left, at.mid],
      ]),
    ]);
    await openTree(page);
    await rowOf(page, 'd:a').click();
    await rowOf(page, 'd:c').click({ modifiers: ['ControlOrMeta'] });
    const toolbar = page.getByRole('toolbar', { name: 'Drawing toolbar' });
    await expect(toolbar.getByRole('button', { name: 'Background color' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Text color' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Templates' })).toHaveCount(0);
    // One tool: none of them, Templates back.
    await rowOf(page, 'd:b').click({ modifiers: ['ControlOrMeta'] });
    await rowOf(page, 'd:c').click({ modifiers: ['ControlOrMeta'] });
    await expect(toolbar.getByRole('button', { name: 'Templates' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Background color' })).toHaveCount(0);
  });
});
