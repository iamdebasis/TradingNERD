import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { type Drawing, type DrawingTool, newDrawing } from '@tradingnerd/core';
import { PNG } from 'pngjs';
import {
  chartBars,
  chartCall,
  chartState,
  expect,
  openChart,
  paneOrigin,
  settle,
  test,
} from './fixtures';

/**
 * The drawing tools, milestone D1 (docs/SPEC.md §5.27): the left toolbar and its menus, the nine
 * Lines tools, selecting, moving, editing and deleting, Shift, cloning, the magnet, Keep drawing,
 * the locks, hiding, removing, undo and redo, drawings kept per symbol and on indicator panes,
 * the floating toolbar and the settings dialog; and the toolbar and menu against the user's
 * screenshot of TradingView (docs/reference/08-drawing-lines-menu.png).
 */

const SYMBOL = 'BINANCE:XRPUSDT';

/** The drawings' state as the chart reports it (ChartController.debugDrawings). */
interface DrawingsDebug {
  drawings: Drawing[];
  selection: string[];
  placing: { tool: string; points: { time: number; price: number }[] } | null;
  dragging: string | null;
  hover: string | null;
  cursor: string | null;
  settings: {
    tool: string | null;
    cursor: string;
    magnetOn: boolean;
    magnet: string;
    keepDrawing: boolean;
    lockAll: boolean;
    hideAll: boolean;
  };
  shapes: {
    id: string;
    pane: number;
    points: ({ x: number; y: number } | null)[];
    handles: { x: number; y: number }[];
    lines: { x: number; y: number }[][];
  }[];
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

/** The page point of a bar and a price on the price pane. */
async function pointOf(page: Page, bar: number, price: number): Promise<{ x: number; y: number }> {
  const origin = await paneOrigin(page);
  const x = await chartCall<number | null>(page, 'barX', bar);
  const y = await chartCall<number | null>(page, 'priceToY', price);
  if (x === null || y === null) throw new Error(`Bar ${bar} at ${price} is not on the chart`);
  return { x: origin.x + x, y: origin.y + y };
}

/** A drawing's shape on the price pane, its points, handles and lines in page px. */
async function shapeOf(page: Page, id: string) {
  const origin = await paneOrigin(page);
  const shape = (await drawingsState(page)).shapes.find(
    (item) => item.id === id && item.pane === 0,
  );
  if (!shape) throw new Error(`Drawing ${id} isn't shown`);
  const move = (p: { x: number; y: number }) => ({ x: origin.x + p.x, y: origin.y + p.y });
  return {
    points: shape.points.map((p) => (p ? move(p) : null)),
    handles: shape.handles.map(move),
    lines: shape.lines.map((line) => line.map(move)),
  };
}

/** The middle of a two-point drawing's line, in page px. */
async function middleOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const [p, q] = (await shapeOf(page, id)).points;
  if (!p || !q) throw new Error(`Drawing ${id} has no line`);
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/** Two bars and prices well inside the view. */
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

const toolbarOf = (page: Page) => page.getByRole('navigation', { name: 'Drawing tools' });
const floatingOf = (page: Page) => page.getByRole('toolbar', { name: 'Drawing toolbar' });

/** Opens a toolbar group's menu by its tab, which shows while the group is hovered. */
async function openGroup(page: Page, group: string): Promise<Locator> {
  const tab = toolbarOf(page).getByRole('button', {
    name: group,
    exact: true,
    includeHidden: true,
  });
  await tab.locator('..').hover();
  await tab.click();
  const menu = page.getByRole('menu', { name: group });
  await expect(menu).toBeVisible();
  return menu;
}

async function chooseLineTool(page: Page, name: string): Promise<void> {
  const menu = await openGroup(page, 'Trend line tools');
  await menu.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
}

const clickAt = (page: Page, p: { x: number; y: number }) => page.mouse.click(p.x, p.y);

/** Draws a two-point tool with a click, a move and a click. */
async function drawTwoPoints(
  page: Page,
  a: { x: number; y: number },
  b: { x: number; y: number },
): Promise<void> {
  await clickAt(page, a);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await clickAt(page, b);
}

/** Drags with the left button from one point to another, keys held throughout. */
async function dragFrom(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  keys: ('Shift' | 'ControlOrMeta')[] = [],
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  for (const key of keys) await page.keyboard.up(key);
}

/** A drawing as the gateway would hold it, at bars and prices of the mock's history. */
async function stored(
  page: Page,
  id: string,
  tool: DrawingTool,
  points: [number, number][],
  pane: string | null = null,
): Promise<Drawing> {
  const bars = await chartBars(page);
  return newDrawing(
    id,
    tool,
    points.map(([bar, price]) => ({ time: (bars[bar] as { time: number }).time, price })),
    pane,
  );
}

test.describe('drawing the Lines tools', () => {
  test('draws a trend line with two clicks, selects it, and saves it for the symbol', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Trendline');
    const before = (await chartState(page)).logicalRange;
    await drawTwoPoints(page, await pointOf(page, left, low), await pointOf(page, right, high));
    const [line] = await drawingsOf(page);
    expect(line?.tool).toBe('trend-line');
    const bars = await chartBars(page);
    expect(line?.points.map((p) => p.time)).toEqual([bars[left]?.time, bars[right]?.time]);
    expect(line?.points[0]?.price).toBeCloseTo(low, 2);
    expect((await drawingsState(page)).selection).toEqual([line?.id]);
    // Drawing never moved the chart.
    expect((await chartState(page)).logicalRange).toEqual(before);
    // The tool went back to the cursor, and the drawing was saved for the symbol.
    expect((await drawingsState(page)).settings.tool).toBeNull();
    await expect.poll(() => market.drawingSaves.at(-1)?.drawings.length).toBe(1);
    expect(market.drawingSaves.at(-1)?.symbol).toBe(SYMBOL);
  });

  test('draws in one stroke: press, drag and let go', async ({ page }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Ray');
    const before = (await chartState(page)).logicalRange;
    await dragFrom(page, await pointOf(page, left, low), await pointOf(page, right, high));
    const [ray] = await drawingsOf(page);
    expect(ray?.tool).toBe('ray');
    expect(ray?.style.extendRight).toBe(true);
    expect((await chartState(page)).logicalRange).toEqual(before);
  });

  test('places each one-click tool with a single click', async ({ page }) => {
    await openChart(page);
    const { left, mid } = await spots(page);
    for (const name of ['Horizontal line', 'Horizontal ray', 'Vertical line', 'Crossline']) {
      await chooseLineTool(page, name);
      await clickAt(page, await pointOf(page, left, mid));
    }
    expect((await drawingsOf(page)).map((d) => [d.tool, d.points.length])).toEqual([
      ['horizontal-line', 1],
      ['horizontal-ray', 1],
      ['vertical-line', 1],
      ['cross-line', 1],
    ]);
    // A horizontal line crosses the whole pane.
    const id = (await drawingsOf(page))[0]?.id as string;
    const shape = (await drawingsState(page)).shapes.find((s) => s.id === id);
    expect(shape?.lines[0]?.[0]?.x).toBeLessThan(0);
    expect(shape?.lines[0]?.[1]?.x).toBeGreaterThan((await chartState(page)).paneWidth);
  });

  test('extends an Extended line to the pane’s edges; an Info line shows its stats', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Extended line');
    await drawTwoPoints(page, await pointOf(page, left, low), await pointOf(page, right, high));
    await chooseLineTool(page, 'Info line');
    await drawTwoPoints(page, await pointOf(page, left, high), await pointOf(page, right, low));
    const [extended, info] = await drawingsOf(page);
    const [line] = (await shapeOf(page, extended?.id as string)).lines;
    const pane = await paneOrigin(page);
    expect(Math.min(line?.[0]?.x ?? 0, line?.[1]?.x ?? 0)).toBeLessThan(pane.x + 1);
    expect(info?.style.alwaysShowStats).toBe(true);
    expect(info?.style.stats).toMatchObject({ priceRange: true, barsRange: true, angle: true });
  });

  test('chooses the Lines tools with ⌥T, ⌥H, ⌥J, ⌥V and ⌥C', async ({ page }) => {
    await openChart(page);
    const tools: [string, string][] = [
      ['Alt+KeyT', 'trend-line'],
      ['Alt+KeyH', 'horizontal-line'],
      ['Alt+KeyJ', 'horizontal-ray'],
      ['Alt+KeyV', 'vertical-line'],
      ['Alt+KeyC', 'cross-line'],
    ];
    for (const [keys, tool] of tools) {
      await page.keyboard.press(keys);
      await expect.poll(async () => (await drawingsState(page)).settings.tool).toBe(tool);
    }
    // The Lines button shows the last one chosen.
    await expect(toolbarOf(page).getByRole('button', { name: /^Crossline/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await drawingsState(page)).settings.tool).toBeNull();
  });

  test('keeps the tool after each drawing while Keep drawing is on', async ({ page }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await toolbarOf(page).getByRole('button', { name: 'Keep drawing' }).click();
    await chooseLineTool(page, 'Horizontal line');
    await clickAt(page, await pointOf(page, left, low));
    await clickAt(page, await pointOf(page, right, high));
    expect(await drawingsOf(page)).toHaveLength(2);
    expect((await drawingsState(page)).settings.tool).toBe('horizontal-line');
  });

  test('keeps the second point at 45° with Shift', async ({ page }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Trendline');
    const a = await pointOf(page, left, low);
    const b = await pointOf(page, right, high);
    await clickAt(page, a);
    await page.keyboard.down('Shift');
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await clickAt(page, b);
    await page.keyboard.up('Shift');
    const [line] = await drawingsOf(page);
    const [p, q] = (await shapeOf(page, line?.id as string)).points;
    if (!p || !q) throw new Error('no points');
    expect(Math.abs(Math.abs(q.x - p.x) - Math.abs(q.y - p.y))).toBeLessThan(1);
  });

  test('snaps a point to the bar’s nearest price with the strong magnet', async ({ page }) => {
    await openChart(page);
    const { left, mid } = await spots(page);
    const menu = await openGroup(page, 'Magnet');
    await menu.getByRole('menuitemradio', { name: 'Strong magnet' }).click();
    await chooseLineTool(page, 'Horizontal line');
    await clickAt(page, await pointOf(page, left, mid));
    const bar = (await chartBars(page))[left];
    const [line] = await drawingsOf(page);
    expect([bar?.open, bar?.high, bar?.low, bar?.close]).toContain(line?.points[0]?.price);
  });
});

test.describe('editing drawings', () => {
  test('moves a drawing by its line and a point by its handle, never the chart', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    market.drawings.set(SYMBOL, [
      await stored(page, 'a', 'trend-line', [
        [left, low],
        [right, high],
      ]),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const before = (await chartState(page)).logicalRange;
    const middle = await middleOf(page, 'a');
    const start = (await shapeOf(page, 'a')).points[0] as { x: number; y: number };
    const spacing = (await pointOf(page, left + 1, low)).x - start.x;
    await dragFrom(page, middle, { x: middle.x + spacing * 3, y: middle.y - 20 });
    const bars = await chartBars(page);
    let [moved] = await drawingsOf(page);
    expect(moved?.points.map((point) => point.time)).toEqual([
      bars[left + 3]?.time,
      bars[right + 3]?.time,
    ]);
    expect(moved?.points[0]?.price).toBeGreaterThan(low);
    // The second point's handle moves only that point.
    const handle = (await shapeOf(page, 'a')).handles[1];
    if (!handle) throw new Error('no handle');
    await dragFrom(page, handle, { x: handle.x + spacing * 5, y: handle.y });
    [moved] = await drawingsOf(page);
    expect(moved?.points[0]?.time).toBe(bars[left + 3]?.time);
    expect(moved?.points[1]?.time).toBe(bars[right + 8]?.time);
    expect((await chartState(page)).logicalRange).toEqual(before);
    await expect
      .poll(() => market.drawings.get(SYMBOL)?.[0]?.points[1]?.time)
      .toBe(bars[right + 8]?.time);
  });

  test('clones a drawing dragged with Ctrl/⌘, and deletes the selection with Delete', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Trendline');
    await drawTwoPoints(page, await pointOf(page, left, low), await pointOf(page, right, high));
    const [original] = await drawingsOf(page);
    const middle = await middleOf(page, original?.id as string);
    await dragFrom(page, middle, { x: middle.x, y: middle.y + 60 }, ['ControlOrMeta']);
    const drawings = await drawingsOf(page);
    expect(drawings).toHaveLength(2);
    expect(drawings[0]).toEqual(original);
    expect((await drawingsState(page)).selection).toEqual([drawings[1]?.id]);
    await page.keyboard.press('Delete');
    expect((await drawingsOf(page)).map((d) => d.id)).toEqual([original?.id]);
  });

  test('a locked drawing doesn’t move or go with Delete; Lock all locks every one', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Trendline');
    await drawTwoPoints(page, await pointOf(page, left, low), await pointOf(page, right, high));
    const [line] = await drawingsOf(page);
    await floatingOf(page).getByRole('button', { name: 'Lock' }).click();
    await expect.poll(async () => (await drawingsOf(page))[0]?.locked).toBe(true);
    const middle = await middleOf(page, line?.id as string);
    await dragFrom(page, middle, { x: middle.x + 40, y: middle.y + 40 });
    await page.keyboard.press('Delete');
    expect((await drawingsOf(page))[0]?.points).toEqual(line?.points);
    await floatingOf(page).getByRole('button', { name: 'Unlock' }).click();
    await toolbarOf(page).getByRole('button', { name: 'Lock all drawings' }).click();
    await clickAt(page, middle);
    await page.keyboard.press('Delete');
    expect(await drawingsOf(page)).toHaveLength(1);
  });

  test('the eraser removes the drawing it clicks', async ({ page }) => {
    await openChart(page);
    const { left, mid } = await spots(page);
    await chooseLineTool(page, 'Horizontal line');
    const at = await pointOf(page, left, mid);
    await clickAt(page, at);
    const menu = await openGroup(page, 'Cursors');
    await menu.getByRole('menuitemradio', { name: 'Eraser' }).click();
    await clickAt(page, { x: at.x + 50, y: at.y });
    expect(await drawingsOf(page)).toEqual([]);
  });

  test('hides every drawing with Hide all drawings and with Ctrl+Alt+H', async ({ page }) => {
    await openChart(page);
    const { left, mid } = await spots(page);
    await chooseLineTool(page, 'Horizontal line');
    await clickAt(page, await pointOf(page, left, mid));
    await toolbarOf(page)
      .getByRole('button', { name: /^Hide all drawings/ })
      .click();
    await expect.poll(async () => (await drawingsState(page)).shapes).toEqual([]);
    await page.keyboard.press('ControlOrMeta+Alt+KeyH');
    await expect.poll(async () => (await drawingsState(page)).shapes.length).toBe(1);
  });

  test('removes every drawing from Remove objects; undo and redo, by key and button', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await toolbarOf(page).getByRole('button', { name: 'Keep drawing' }).click();
    await chooseLineTool(page, 'Horizontal line');
    await clickAt(page, await pointOf(page, left, low));
    await clickAt(page, await pointOf(page, right, high));
    await page.keyboard.press('Escape');
    await toolbarOf(page).getByRole('button', { name: 'Remove objects' }).click();
    await page
      .getByRole('menu', { name: 'Remove objects' })
      .getByRole('menuitem', { name: 'Remove 2 drawings', exact: true })
      .click();
    expect(await drawingsOf(page)).toEqual([]);
    const banner = page.getByRole('banner');
    await banner.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(2);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(2);
    await banner.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(0);
    await expect(banner.getByRole('button', { name: 'Redo' })).toBeDisabled();
    await expect.poll(() => market.drawings.get(SYMBOL)?.length ?? 0).toBe(0);
  });
});

test.describe('drawings kept per symbol and pane', () => {
  test('shows the symbol’s stored drawings, and another symbol’s on switching', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, mid } = await spots(page);
    market.drawings.set(SYMBOL, [await stored(page, 'x1', 'horizontal-line', [[left, mid]])]);
    market.drawings.set('BINANCE:LINKUSDT', [
      await stored(page, 'l1', 'vertical-line', [[left, mid]]),
      await stored(page, 'l2', 'vertical-line', [[left + 5, mid]]),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).map((d) => d.id)).toEqual(['x1']);
    await page
      .getByRole('complementary', { name: 'Watchlist' })
      .getByRole('button', { name: 'LINKUSDT', exact: true })
      .click();
    await expect.poll(async () => (await drawingsOf(page)).map((d) => d.id)).toEqual(['l1', 'l2']);
    // Another interval keeps them: a drawing belongs to its symbol.
    await page
      .getByRole('group', { name: 'Intervals' })
      .getByRole('button', { name: '4h' })
      .click();
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(2);
  });

  test('says when the drawings couldn’t be saved, and saves them once the gateway answers', async ({
    page,
    market,
    consoleGuard,
  }) => {
    consoleGuard.allow(/ERR_CONNECTION_REFUSED|Failed to load resource/);
    await openChart(page);
    const { left, mid } = await spots(page);
    market.failDrawings(true);
    await chooseLineTool(page, 'Horizontal line');
    await clickAt(page, await pointOf(page, left, mid));
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const notice = page.getByRole('status').filter({ hasText: "Drawings couldn't be saved." });
    await expect(notice).toHaveText(
      "Drawings couldn't be saved. The local gateway is not reachable. Trying again every 3 s.",
    );
    expect(market.drawingSaves).toEqual([]);
    // The next try saves it, and the notice goes.
    market.failDrawings(false);
    await expect.poll(() => market.drawingSaves.length, { timeout: 10_000 }).toBe(1);
    await expect(notice).toBeHidden();
    expect(market.drawings.get(SYMBOL)?.map((d) => d.tool)).toEqual(['horizontal-line']);
  });

  test('says when the drawings couldn’t be loaded, and shows them once the gateway answers', async ({
    page,
    market,
    consoleGuard,
  }) => {
    consoleGuard.allow(/ERR_CONNECTION_REFUSED|Failed to load resource/);
    await openChart(page);
    const { left, mid } = await spots(page);
    market.drawings.set(SYMBOL, [await stored(page, 'x1', 'horizontal-line', [[left, mid]])]);
    market.failDrawings(true);
    await page.reload();
    await openChart(page);
    const notice = page.getByRole('status').filter({ hasText: "Drawings couldn't be loaded." });
    await expect(notice).toContainText('The local gateway is not reachable.');
    expect(await drawingsOf(page)).toEqual([]);
    market.failDrawings(false);
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.id), { timeout: 10_000 })
      .toEqual(['x1']);
    await expect(notice).toBeHidden();
    // Nothing was written over the stored drawings meanwhile.
    expect(market.drawingSaves).toEqual([]);
  });

  test('draws on an indicator’s pane; removing the indicator removes its drawings', async ({
    page,
    market,
  }) => {
    await openChart(page);
    await page.getByRole('banner').getByRole('button', { name: 'Indicators', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Indicators, metrics, and strategies' });
    await dialog.getByRole('option', { name: 'Relative Strength Index' }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect.poll(async () => (await chartState(page)).panes.length).toBe(2);
    const state = await chartState(page);
    const origin = await paneOrigin(page);
    const rsiTop = origin.y + (state.panes[0]?.height ?? 0) + 1;
    const rsiMiddle = rsiTop + (state.panes[1]?.height ?? 0) / 2;
    await chooseLineTool(page, 'Horizontal line');
    await page.mouse.click(origin.x + 200, rsiMiddle);
    const [line] = await drawingsOf(page);
    expect(line?.pane).toBe('rsi-1');
    const shapes = (await drawingsState(page)).shapes.filter((s) => s.id === line?.id);
    expect(shapes.map((s) => s.pane)).toEqual([1]);
    const legend = page.locator('[data-indicator="rsi-1"]');
    await legend.hover();
    await legend.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(0);
    await expect.poll(() => market.drawings.get(SYMBOL)?.length ?? 0).toBe(0);
  });
});

test.describe('the floating toolbar and the settings dialog', () => {
  test('changes the line’s thickness, style and color from the floating toolbar', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Trendline');
    await drawTwoPoints(page, await pointOf(page, left, low), await pointOf(page, right, high));
    const floating = floatingOf(page);
    await expect(floating).toBeVisible();
    await floating.getByRole('button', { name: 'Line thickness' }).click();
    await page
      .getByRole('group', { name: 'Thickness' })
      .getByRole('button', { name: '4px' })
      .click();
    await floating.getByRole('button', { name: 'Line style' }).click();
    await page
      .getByRole('group', { name: 'Line style' })
      .getByRole('button', { name: 'Dashed' })
      .click();
    await floating.getByRole('button', { name: 'Line color' }).click();
    await page.getByRole('button', { name: '#F23645' }).click();
    // A press elsewhere closes the editor; its change is kept.
    await page.mouse.click(5, 500);
    await expect
      .poll(async () => (await drawingsOf(page))[0]?.style)
      .toMatchObject({ width: 4, lineStyle: 'dashed', color: '#F23645' });
    await expect.poll(() => market.drawings.get(SYMBOL)?.[0]?.style.color).toBe('#F23645');
    // Each change is an undo step: the color goes back first.
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await drawingsOf(page))[0]?.style.color).toBe('#2962FF');
    expect((await drawingsOf(page))[0]?.style.lineStyle).toBe('dashed');
  });

  test('opens the settings on a double-click; Cancel puts them back, Ok keeps them', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    await chooseLineTool(page, 'Trendline');
    await drawTwoPoints(page, await pointOf(page, left, low), await pointOf(page, right, high));
    const [line] = await drawingsOf(page);
    const middle = await middleOf(page, line?.id as string);
    await page.mouse.dblclick(middle.x, middle.y);
    const dialog = page.getByRole('dialog', { name: 'Trendline' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Extend right').check();
    await expect.poll(async () => (await drawingsOf(page))[0]?.style.extendRight).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(async () => (await drawingsOf(page))[0]?.style.extendRight).toBe(false);

    await floatingOf(page).getByRole('button', { name: 'Settings' }).click();
    await dialog.getByRole('tab', { name: 'Text' }).click();
    await dialog.getByLabel('Text', { exact: true }).fill('Breakout');
    await dialog.getByRole('tab', { name: 'Coordinates' }).click();
    await dialog.getByLabel('Price 1').fill('1.25');
    await dialog.getByRole('button', { name: 'Ok' }).click();
    const [edited] = await drawingsOf(page);
    expect(edited?.style.text.value).toBe('Breakout');
    expect(edited?.points[0]?.price).toBe(1.25);
    // One undo step for everything the dialog changed.
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await drawingsOf(page))[0]?.style.text.value).toBe('');
    expect((await drawingsOf(page))[0]?.points).toEqual(line?.points);
  });

  test('a drawing turned off for the chart’s interval in its Visibility tab disappears', async ({
    page,
  }) => {
    await openChart(page);
    const { left, mid } = await spots(page);
    await chooseLineTool(page, 'Horizontal line');
    await clickAt(page, await pointOf(page, left, mid));
    await floatingOf(page).getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Horizontal line' });
    await dialog.getByRole('tab', { name: 'Visibility' }).click();
    await dialog.getByRole('checkbox', { name: 'Days' }).uncheck();
    await dialog.getByRole('button', { name: 'Ok' }).click();
    await expect.poll(async () => (await drawingsState(page)).shapes).toEqual([]);
    await page
      .getByRole('group', { name: 'Intervals' })
      .getByRole('button', { name: '4h' })
      .click();
    await expect.poll(async () => (await drawingsState(page)).shapes.length).toBe(1);
  });
});

test.describe('the toolbar', () => {
  test('chooses the cursor: Dot, Arrow, Cross', async ({ page }) => {
    await openChart(page);
    for (const name of ['Dot', 'Arrow', 'Cross']) {
      const menu = await openGroup(page, 'Cursors');
      await menu.getByRole('menuitemradio', { name }).click();
      await expect
        .poll(async () => (await drawingsState(page)).settings.cursor)
        .toBe(name.toLowerCase());
    }
  });

  test('hides and shows itself, and the chart takes its room', async ({ page }) => {
    await openChart(page);
    const chart = page.getByRole('main', { name: 'Chart' });
    expect((await chart.boundingBox())?.x).toBe(56);
    await toolbarOf(page).getByRole('button', { name: 'Hide drawings toolbar' }).click();
    await expect(toolbarOf(page)).toHaveCount(0);
    await expect.poll(async () => (await chart.boundingBox())?.x).toBe(4);
    await page.reload();
    await openChart(page);
    await page.getByRole('button', { name: 'Show drawings toolbar' }).click();
    await expect.poll(async () => (await chart.boundingBox())?.x).toBe(56);
  });

  test('matches TradingView’s toolbar and Lines menu in the user’s screenshot', async ({
    page,
  }) => {
    await openChart(page);
    const reference = PNG.sync.read(
      readFileSync(
        fileURLToPath(
          new URL('../../../../docs/reference/08-drawing-lines-menu.png', import.meta.url),
        ),
      ),
    );
    const chart = await page.getByRole('main', { name: 'Chart' }).boundingBox();
    if (!chart) throw new Error('no chart');
    const toolbar = toolbarOf(page);
    const box = async (locator: Locator) => {
      const found = await locator.boundingBox();
      if (!found) throw new Error('not visible');
      return found;
    };
    // The column: 52 wide; 34 px buttons one every 38 px, the first 8 px below the chart's top.
    expect((await box(toolbar)).width).toBe(52);
    const cursor = await box(toolbar.getByRole('button', { name: 'Cross' }));
    const trend = await box(toolbar.getByRole('button', { name: /^Trendline/ }));
    expect(cursor).toMatchObject({ x: 9, width: 34, height: 34 });
    expect(cursor.y - chart.y).toBe(8);
    expect(trend.y - cursor.y).toBe(38);
    await expect(toolbar.getByRole('button', { name: 'Cross' })).toHaveCSS(
      'background-color',
      'rgb(48, 48, 48)',
    );

    // The menu: beside the column, 283 wide, its top 8 px above its button's; a 24 px section
    // title, 40 px rows, names at 42 px and shortcuts ending at 216 px, in the screenshot's grays.
    const menu = await openGroup(page, 'Trend line tools');
    await page.mouse.move(800, 600);
    const menuBox = await box(menu);
    expect(menuBox).toMatchObject({ x: 53.5, width: 283 });
    expect(menuBox.y).toBe(trend.y - 8);
    const title = menu.getByRole('heading', { name: 'Lines' });
    expect((await box(title)).height).toBe(24);
    await expect(title).toHaveCSS('font-size', '11px');
    await expect(title).toHaveCSS('color', 'rgb(140, 140, 140)');
    const row = menu.getByRole('menuitemradio', { name: /^Trendline/ });
    expect((await box(row)).height).toBe(40);
    const name = row.locator('span').nth(1);
    const key = row.locator('span').nth(2);
    expect((await box(name)).x - menuBox.x).toBe(42);
    const keyBox = await box(key);
    expect(keyBox.x + keyBox.width - menuBox.x).toBeCloseTo(216, 0);
    await expect(name).toHaveCSS('color', 'rgb(184, 184, 184)');
    await expect(name).toHaveCSS('font-size', '14px');
    await expect(key).toHaveCSS('color', 'rgb(140, 140, 140)');
    await expect(key).toHaveCSS('font-size', '12px');
    await expect(menu).toHaveCSS('background-color', 'rgb(19, 19, 19)');
    await expect(menu).toHaveCSS('border-top-color', 'rgb(31, 31, 31)');

    // The icons, pixel for pixel (fonts aside, which each system draws its own way): the cursor
    // button's, and each Lines tool's in the menu, against the screenshot at 2×.
    const shot = PNG.sync.read(await page.screenshot());
    const ink = (png: PNG, x: number, y: number, background: number) =>
      Math.max(0, (png.data[(y * png.width + x) * 4 + 1] ?? 0) - background);
    const difference = (
      ours: { x: number; y: number },
      theirs: { x: number; y: number },
      size: number,
      background: number,
    ) => {
      // The screenshot's icons sit up to two device pixels either way of ours: the best fit.
      let best = Number.POSITIVE_INFINITY;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          let total = 0;
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              total += Math.abs(
                ink(shot, ours.x + x, ours.y + y, background) -
                  ink(reference, theirs.x + dx + x, theirs.y + dy + y, background),
              );
            }
          }
          best = Math.min(best, total / (size * size));
        }
      }
      return best;
    };
    const cursorAt = { x: Math.round(cursor.x * 2), y: Math.round(cursor.y * 2) };
    expect(difference(cursorAt, { x: 18, y: 16 }, 68, 48), 'Cross').toBeLessThan(1.5);
    const rows: [string, number][] = [
      ['Trendline', 176],
      ['Ray', 256],
      ['Info line', 336],
      ['Extended line', 416],
      ['Trend angle', 496],
      ['Horizontal line', 576],
      ['Horizontal ray', 656],
      ['Vertical line', 736],
      ['Crossline', 816],
    ];
    for (const [tool, centre] of rows) {
      const icon = await box(
        menu
          .getByRole('menuitemradio', { name: new RegExp(`^${tool}`) })
          .locator('span')
          .first(),
      );
      const ours = { x: Math.round(icon.x * 2), y: Math.round(icon.y * 2) };
      // The screenshot's menu starts at x 107 (2×), its icons centred 24 px in.
      expect(difference(ours, { x: 107 + 48 - 28, y: centre - 28 }, 56, 19), tool).toBeLessThan(3);
    }
  });
});

test('dragging a drawing among a hundred keeps every task short', async ({ page, market }) => {
  await openChart(page);
  const { left, right, low, high } = await spots(page);
  const many: Drawing[] = [];
  for (let i = 0; i < 100; i++) {
    const shift = (high - low) * (i / 200);
    many.push(
      await stored(page, `d${i}`, 'trend-line', [
        [left, low + shift],
        [right, high - shift],
      ]),
    );
  }
  market.drawings.set(SYMBOL, many);
  await page.reload();
  await openChart(page);
  await expect.poll(async () => (await drawingsOf(page)).length).toBe(100);
  await page.evaluate(() => {
    const tasks: number[] = [];
    (window as unknown as { tasks: number[] }).tasks = tasks;
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) tasks.push(entry.duration);
    }).observe({ type: 'longtask' });
  });
  const middle = await middleOf(page, 'd99');
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(middle.x + i * 4, middle.y + i * 2);
  await page.mouse.up();
  await settle(page);
  const tasks = await page.evaluate(() => (window as unknown as { tasks: number[] }).tasks);
  // A long task is over 50 ms; none comes near what would make the drag stutter.
  expect(Math.max(0, ...tasks), `long tasks: ${tasks.join(', ')}`).toBeLessThan(100);
  const moved = (await drawingsOf(page)).find((d) => d.id === 'd99');
  expect(moved?.points).not.toEqual(many[99]?.points);
});
