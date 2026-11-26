import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { type Bar, type Drawing, type DrawingTool, newDrawing } from '@tradingnerd/core';
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
 * The channels and pitchforks, milestone D2 (docs/SPEC.md §5.27): the trend line tools' Channels
 * and Pitchforks sections against the user's screenshot of TradingView's menu
 * (docs/reference/08-drawing-lines-menu.png); each tool drawn with its clicks, its construction,
 * handles, settings and background; a regression trend's fit and its wait for older history; and
 * a hundred of them dragged among.
 */

const SYMBOL = 'BINANCE:XRPUSDT';

interface Pt {
  x: number;
  y: number;
}

/** The drawings' state as the chart reports it (ChartController.debugDrawings). */
interface DrawingsDebug {
  drawings: Drawing[];
  selection: string[];
  placing: { tool: string; points: { time: number; price: number }[]; index: number } | null;
  settings: { tool: string | null };
  shapes: {
    id: string;
    pane: number;
    points: (Pt | null)[];
    handles: Pt[];
    lines: Pt[][];
    looks: { line: Pt[]; color: string }[];
    fills: { points: Pt[]; color: string }[];
    label: string | null;
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
async function pointOf(page: Page, bar: number, price: number): Promise<Pt> {
  const origin = await paneOrigin(page);
  const x = await chartCall<number | null>(page, 'barX', bar);
  const y = await chartCall<number | null>(page, 'priceToY', price);
  if (x === null || y === null) throw new Error(`Bar ${bar} at ${price} is not on the chart`);
  return { x: origin.x + x, y: origin.y + y };
}

/** A drawing's shape on the price pane, in page px. */
async function shapeOf(page: Page, id: string) {
  const origin = await paneOrigin(page);
  const shape = (await drawingsState(page)).shapes.find(
    (item) => item.id === id && item.pane === 0,
  );
  if (!shape) throw new Error(`Drawing ${id} isn't shown`);
  const move = (p: Pt) => ({ x: origin.x + p.x, y: origin.y + p.y });
  return {
    points: shape.points.map((p) => (p ? move(p) : null)),
    handles: shape.handles.map(move),
    lines: shape.lines.map((line) => line.map(move)),
    looks: shape.looks.map((look) => look.line.map(move)),
    fills: shape.fills.map((fill) => ({ ...fill, points: fill.points.map(move) })),
    label: shape.label,
  };
}

/** Two bars and three prices well inside the view. */
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

async function chooseTool(page: Page, name: string): Promise<void> {
  const menu = await openGroup(page, 'Trend line tools');
  await menu.getByRole('menuitemradio', { name, exact: true }).click();
}

/** Clicks each point in turn, moving to it first as a hand would. */
async function clickThrough(page: Page, points: Pt[]): Promise<void> {
  for (const point of points) {
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await page.mouse.click(point.x, point.y);
  }
}

async function dragFrom(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

/** A drawing as the gateway would hold it, at bars and prices of the chart's history. */
async function stored(
  page: Page,
  id: string,
  tool: DrawingTool,
  points: [number, number][],
): Promise<Drawing> {
  const bars = await chartBars(page);
  return newDrawing(
    id,
    tool,
    points.map(([bar, price]) => ({ time: (bars[bar] as Bar).time, price })),
  );
}

/** How far a point is from the line through `a` and `b`, px. */
function offLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / Math.hypot(dx, dy);
}

const middle = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

test.describe('channels and pitchforks (D2)', () => {
  test('lists Channels and Pitchforks under the Lines, as the user’s screenshot has them', async ({
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
    const box = async (locator: Locator) => {
      const found = await locator.boundingBox();
      if (!found) throw new Error('not visible');
      return found;
    };
    const menu = await openGroup(page, 'Trend line tools');
    await page.mouse.move(800, 600);
    await expect(menu.getByRole('heading')).toHaveText(['Lines', 'Channels', 'Pitchforks']);
    const items = await menu.getByRole('menuitemradio').allTextContents();
    // Named as TradingView's menu names them, none with a shortcut.
    expect(items.slice(9)).toEqual([
      'Parallel channel',
      'Regression trend',
      'Flat top/bottom',
      'Disjoint channel',
      'Pitchfork',
      'Schiff pitchfork',
      'Modified Schiff pitchfork',
      'Inside pitchfork',
    ]);

    // Between sections: 1 px of #303030, 5 px in from each side of the menu, 6 px above and
    // below; the rows where the screenshot has them, 397 and 594 px under the first.
    const menuBox = await box(menu);
    const dividers = menu.locator('hr');
    await expect(dividers).toHaveCount(2);
    const divider = await box(dividers.first());
    expect(divider.x - menuBox.x).toBe(6);
    expect(divider.width).toBe(283 - 2 - 10);
    expect(divider.height).toBe(1);
    await expect(dividers.first()).toHaveCSS('background-color', 'rgb(48, 48, 48)');
    const crossline = await box(menu.getByRole('menuitemradio', { name: /^Crossline/ }));
    const channels = await box(menu.getByRole('heading', { name: 'Channels' }));
    expect(divider.y - (crossline.y + crossline.height)).toBe(6);
    expect(channels.y - (divider.y + divider.height)).toBe(6);
    const row = (name: string) => box(menu.getByRole('menuitemradio', { name, exact: true }));
    const trendline = await box(menu.getByRole('menuitemradio', { name: /^Trendline/ }));
    expect((await row('Parallel channel')).y - trendline.y).toBe(397);
    expect((await row('Pitchfork')).y - trendline.y).toBe(594);

    // The icons, pixel for pixel against the screenshot at 2× (as the Lines' are).
    const shot = PNG.sync.read(await page.screenshot());
    const ink = (png: PNG, x: number, y: number, background: number) =>
      Math.max(0, (png.data[(y * png.width + x) * 4 + 1] ?? 0) - background);
    const difference = (ours: Pt, theirs: Pt, size: number, background: number) => {
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
    const rows: [string, number][] = [
      ['Parallel channel', 970],
      ['Regression trend', 1050],
      ['Flat top/bottom', 1130],
      ['Disjoint channel', 1210],
      ['Pitchfork', 1364],
      ['Schiff pitchfork', 1444],
      ['Modified Schiff pitchfork', 1524],
      ['Inside pitchfork', 1604],
    ];
    for (const [tool, centre] of rows) {
      const icon = await box(
        menu.getByRole('menuitemradio', { name: tool, exact: true }).locator('span').first(),
      );
      const ours = { x: Math.round(icon.x * 2), y: Math.round(icon.y * 2) };
      expect(difference(ours, { x: 107 + 48 - 28, y: centre - 28 }, 56, 19), tool).toBeLessThan(3);
    }
  });

  test('draws a parallel channel with three clicks, its third point setting its width', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high, mid } = await spots(page);
    await chooseTool(page, 'Parallel channel');
    const a = await pointOf(page, left, low);
    const b = await pointOf(page, right, high);
    const c = await pointOf(page, Math.round((left + right) / 2), mid - (high - low) / 4);
    await clickThrough(page, [a, b]);
    // Two points down: nothing drawn yet, the third follows the pointer.
    expect(await drawingsOf(page)).toEqual([]);
    expect((await drawingsState(page)).placing?.index).toBe(2);
    await clickThrough(page, [c]);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const [channel] = await drawingsOf(page);
    expect(channel?.tool).toBe('parallel-channel');
    // Kept at the first point's bar, as TradingView keeps it; the second line runs through the
    // third click.
    expect(channel?.points[2]?.time).toBe(channel?.points[0]?.time);
    const shape = await shapeOf(page, channel?.id as string);
    const [first, second] = shape.lines;
    expect(offLine(c, second?.[0] as Pt, second?.[1] as Pt)).toBeLessThan(1.5);
    expect(offLine(a, first?.[0] as Pt, first?.[1] as Pt)).toBeLessThan(1.5);
    // Its dashed middle level, its background, and six handles.
    expect(shape.looks).toHaveLength(1);
    expect(shape.fills).toHaveLength(1);
    expect(shape.handles).toHaveLength(6);
    await expect.poll(() => market.drawings.get(SYMBOL)?.[0]?.points).toEqual(channel?.points);

    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page))[0]?.points).toEqual(channel?.points);
  });

  test('draws a channel’s first line in one drag, then its third point with a click', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, low, high, mid } = await spots(page);
    await chooseTool(page, 'Parallel channel');
    const a = await pointOf(page, left, low);
    const b = await pointOf(page, right, high);
    await dragFrom(page, a, b);
    expect(await drawingsOf(page)).toEqual([]);
    await clickThrough(page, [await pointOf(page, left + 5, mid)]);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
  });

  test('lays a flat top/bottom’s flat line, and mirrors a disjoint channel’s second', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    const a = await pointOf(page, left, low);
    const b = await pointOf(page, right, high);
    const c = await pointOf(page, Math.round((left + right) / 2), low - (high - low) / 3);

    await chooseTool(page, 'Flat top/bottom');
    await clickThrough(page, [a, b, c]);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const [flat] = await drawingsOf(page);
    const flatLine = (await shapeOf(page, flat?.id as string)).lines[1] as Pt[];
    // Level at the third click's price, over the first line's bars.
    expect(Math.abs((flatLine[0]?.y ?? 0) - c.y)).toBeLessThan(1);
    expect(Math.abs((flatLine[1]?.y ?? 0) - c.y)).toBeLessThan(1);
    expect(Math.abs((flatLine[0]?.x ?? 0) - a.x)).toBeLessThan(1);
    expect(Math.abs((flatLine[1]?.x ?? 0) - b.x)).toBeLessThan(1);
    await page.keyboard.press('Delete');

    await chooseTool(page, 'Disjoint channel');
    await clickThrough(page, [a, b, c]);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const [disjoint] = await drawingsOf(page);
    const second = (await shapeOf(page, disjoint?.id as string)).lines[1] as Pt[];
    // Ending at the third click's price at the second point's bar, rising as the first falls.
    expect(Math.abs((second[1]?.y ?? 0) - c.y)).toBeLessThan(1);
    expect((second[0]?.y ?? 0) - (second[1]?.y ?? 0)).toBeCloseTo(b.y - a.y, 0);
  });

  test('draws a pitchfork; its Style turns it into another kind on the same points', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    const p1 = await pointOf(page, left, low);
    const p2 = await pointOf(page, Math.round((left + right) / 2), high);
    const p3 = await pointOf(page, right, (low + high) / 2);
    await chooseTool(page, 'Pitchfork');
    await clickThrough(page, [p1, p2, p3]);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const [fork] = await drawingsOf(page);
    let shape = await shapeOf(page, fork?.id as string);
    // Its median from point 1 through the middle of points 2 and 3; 0.5 and 1 levels each side.
    const [median] = shape.lines;
    expect(offLine(middle(p2, p3), median?.[0] as Pt, median?.[1] as Pt)).toBeLessThan(1.5);
    expect(Math.hypot((median?.[0]?.x ?? 0) - p1.x, (median?.[0]?.y ?? 0) - p1.y)).toBeLessThan(1);
    expect(shape.looks).toHaveLength(4);
    expect(shape.fills).toHaveLength(4);

    const onMedian = middle(p1, middle(p2, p3));
    await page.mouse.dblclick(onMedian.x, onMedian.y);
    // The dialog takes the kind's name as it changes.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Pitchfork', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Pitchfork style' }).click();
    await page.getByRole('option', { name: 'Schiff', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Schiff pitchfork' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Ok' }).click();
    const [schiff] = await drawingsOf(page);
    expect(schiff?.tool).toBe('schiff-pitchfork');
    expect(schiff?.points).toEqual(fork?.points);
    // Now from point 1's bar, halfway to point 2 in price.
    shape = await shapeOf(page, fork?.id as string);
    const start = shape.lines[0]?.[0] as Pt;
    expect(Math.abs(start.x - p1.x)).toBeLessThan(1);
    expect(Math.abs(start.y - (p1.y + p2.y) / 2)).toBeLessThan(1);
  });

  test('draws TradingView’s lines from point 1 for a Schiff, a Modified Schiff and an Inside', async ({
    page,
    market,
  }) => {
    // As the user's screenshot of TradingView's four pitchforks shows them (26 November).
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    const corners: [number, number][] = [
      [left, low],
      [Math.round((left + right) / 2), high],
      [right, (low + high) / 2],
    ];
    market.drawings.set(SYMBOL, [
      await stored(page, 'o', 'pitchfork', corners),
      await stored(page, 's', 'schiff-pitchfork', corners),
      await stored(page, 'm', 'modified-schiff-pitchfork', corners),
      await stored(page, 'i', 'inside-pitchfork', corners),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(4);
    const [p1, p2, p3] = await Promise.all(
      corners.map(([bar, price]) => pointOf(page, bar, price)),
    );
    if (!p1 || !p2 || !p3) throw new Error('no corners');
    const near = (a: Pt | undefined, b: Pt) =>
      a !== undefined && Math.hypot(a.x - b.x, a.y - b.y) < 1;
    const has = (lines: Pt[][], a: Pt, b: Pt) =>
      lines.some(([from, to]) => near(from, a) && near(to, b));
    // A Pitchfork's median starts at point 1: its median and its line from point 2 to 3 alone.
    const original = (await shapeOf(page, 'o')).lines;
    expect(original).toHaveLength(2);
    expect(has(original, p1, p2)).toBe(false);
    for (const id of ['s', 'm']) {
      const { lines } = await shapeOf(page, id);
      expect(lines, id).toHaveLength(3);
      expect(has(lines, p1, p2), id).toBe(true);
    }
    const inside = (await shapeOf(page, 'i')).lines;
    expect(inside).toHaveLength(4);
    expect(has(inside, p1, p2)).toBe(true);
    expect(has(inside, middle(p1, p2), p3)).toBe(true);

    // The new line takes a click as the rest of the drawing does: the Inside alone, by the line
    // from point 1 to point 2's middle.
    market.drawings.set(SYMBOL, [await stored(page, 'i', 'inside-pitchfork', corners)]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const onGuide = middle(p1, middle(p1, p2));
    await page.mouse.click(onGuide.x, onGuide.y);
    await expect.poll(async () => (await drawingsState(page)).selection).toEqual(['i']);
  });

  test('fits a regression trend to the closes between its bars, with Pearson’s R', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, mid } = await spots(page);
    await chooseTool(page, 'Regression trend');
    await clickThrough(page, [await pointOf(page, left, mid), await pointOf(page, right, mid)]);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const [trend] = await drawingsOf(page);
    const shape = await shapeOf(page, trend?.id as string);
    // Least squares through the closes of bars left to right, worked out here on its own.
    const closes = (await chartBars(page)).slice(left, right + 1).map((bar) => bar.close);
    const n = closes.length;
    const meanX = (n - 1) / 2;
    const meanY = closes.reduce((sum, y) => sum + y, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    closes.forEach((y, i) => {
      sxy += (i - meanX) * (y - meanY);
      sxx += (i - meanX) ** 2;
      syy += (y - meanY) ** 2;
    });
    const slope = sxy / sxx;
    const origin = await paneOrigin(page);
    const yOf = async (price: number) =>
      origin.y + ((await chartCall<number | null>(page, 'priceToY', price)) ?? 0);
    const base = shape.lines[0] as Pt[];
    expect(Math.abs((base[0]?.y ?? 0) - (await yOf(meanY - slope * meanX)))).toBeLessThan(0.5);
    expect(Math.abs((base[1]?.y ?? 0) - (await yOf(meanY + slope * meanX)))).toBeLessThan(0.5);
    expect(Number(shape.label)).toBeCloseTo(sxy / Math.sqrt(sxx * syy), 9);
    // Its Up and Down lines, and the bands between them and the base line.
    expect(shape.looks).toHaveLength(2);
    expect(shape.fills).toHaveLength(2);
  });

  test('works a regression trend out only once the history before it has come', async ({
    page,
    market,
  }) => {
    // The chart opens on the newest 1,000 of the history's 2,500 days; this trend starts 500
    // days before them.
    const from = market.bars[1_000] as Bar;
    const to = market.bars[1_700] as Bar;
    const trend = newDrawing('r', 'regression-trend', [
      { time: from.time, price: from.close },
      { time: to.time, price: to.close },
    ]);
    market.drawings.set(SYMBOL, [trend]);
    await openChart(page);
    await expect
      .poll(async () => ((await chartBars(page))[0] as Bar).time, { timeout: 15_000 })
      .toBeLessThanOrEqual(from.time);
    // Worked out on all 701 of its days, none left out: Pearson's R as worked out here.
    const closes = market.bars.slice(1_000, 1_701).map((bar) => bar.close);
    const meanX = (closes.length - 1) / 2;
    const meanY = closes.reduce((sum, y) => sum + y, 0) / closes.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    closes.forEach((y, i) => {
      sxy += (i - meanX) * (y - meanY);
      sxx += (i - meanX) ** 2;
      syy += (y - meanY) ** 2;
    });
    await expect
      .poll(async () => Number((await shapeOf(page, 'r')).label))
      .toBeCloseTo(sxy / Math.sqrt(sxx * syy), 9);
  });

  test('sets a parallel channel’s width by its second line’s middle; its ends keep it', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    const drop = (high - low) / 4;
    market.drawings.set(SYMBOL, [
      await stored(page, 'c', 'parallel-channel', [
        [left, low],
        [right, high],
        [left, low - drop],
      ]),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const before = (await drawingsOf(page))[0] as Drawing;
    const a = await pointOf(page, left, low);
    const b = await pointOf(page, right, high);
    const onLine = middle(a, b);
    await page.mouse.click(onLine.x, onLine.y);
    await expect.poll(async () => (await drawingsState(page)).selection).toEqual(['c']);
    // The second line's middle handle: 20 px further down widens it, the first line stays.
    const widen = (await shapeOf(page, 'c')).handles[4] as Pt;
    await dragFrom(page, widen, { x: widen.x, y: widen.y + 20 });
    const wider = (await drawingsOf(page))[0] as Drawing;
    expect(wider.points.slice(0, 2)).toEqual(before.points.slice(0, 2));
    expect(wider.points[2]?.price).toBeLessThan(before.points[2]?.price as number);
    // Its first point dragged along: the third goes with it, the width kept.
    const start = (await shapeOf(page, 'c')).handles[0] as Pt;
    await dragFrom(page, start, { x: start.x + 30, y: start.y - 10 });
    const moved = (await drawingsOf(page))[0] as Drawing;
    expect(moved.points[2]?.time).toBe(moved.points[0]?.time);
    expect((moved.points[2]?.price as number) - (moved.points[0]?.price as number)).toBeCloseTo(
      (wider.points[2]?.price as number) - (wider.points[0]?.price as number),
      6,
    );
  });

  test('takes a click inside a channel’s background, but not inside a pitchfork’s', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    const span = high - low;
    market.drawings.set(SYMBOL, [
      await stored(page, 'c', 'parallel-channel', [
        [left, low],
        [right, low + span / 4],
        [left, low - span / 2],
      ]),
      await stored(page, 'p', 'pitchfork', [
        [left, high],
        [Math.round((left + right) / 2), high + span / 4],
        [right, high - span / 4],
      ]),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(2);
    // A quarter of the way down the channel: between its first line and its middle level.
    const top = await pointOf(page, Math.round((left + right) / 2), low + span / 8);
    const bottom = await pointOf(page, Math.round((left + right) / 2), low + span / 8 - span / 2);
    await page.mouse.click(top.x, top.y + (bottom.y - top.y) / 4);
    await expect.poll(async () => (await drawingsState(page)).selection).toEqual(['c']);
    // Inside the pitchfork's first band, 30 px along it from its start, off every line.
    const [band] = (await shapeOf(page, 'p')).fills;
    const [start, far, , outer] = band?.points ?? [];
    if (!start || !far || !outer) throw new Error('no band');
    const along = Math.hypot(far.x - start.x, far.y - start.y);
    const inside = {
      x: (start.x + outer.x) / 2 + ((far.x - start.x) / along) * 30,
      y: (start.y + outer.y) / 2 + ((far.y - start.y) / along) * 30,
    };
    await page.mouse.click(inside.x, inside.y);
    await expect.poll(async () => (await drawingsState(page)).selection).toEqual([]);
  });

  test('turns a channel’s levels and background on and off in its settings', async ({
    page,
    market,
  }) => {
    await openChart(page);
    const { left, right, low, high } = await spots(page);
    market.drawings.set(SYMBOL, [
      await stored(page, 'c', 'parallel-channel', [
        [left, low],
        [right, high],
        [left, low - (high - low) / 4],
      ]),
    ]);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const a = await pointOf(page, left, low);
    const b = await pointOf(page, right, high);
    const onLine = middle(a, b);
    await page.mouse.dblclick(onLine.x, onLine.y);
    const dialog = page.getByRole('dialog', { name: 'Parallel channel' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Level 1', exact: true }).check();
    await expect.poll(async () => (await shapeOf(page, 'c')).looks.length).toBe(2);
    await dialog.getByRole('checkbox', { name: 'Background' }).uncheck();
    await expect.poll(async () => (await shapeOf(page, 'c')).fills.length).toBe(0);
    await dialog.getByRole('button', { name: 'Ok' }).click();
    await expect
      .poll(() => {
        const saved = market.drawings.get(SYMBOL)?.[0];
        return [saved?.style.levels[0]?.visible, saved?.style.fill.on];
      })
      .toEqual([true, false]);
  });

  test('opens a regression trend’s settings on its Inputs, its deviations moving its bands', async ({
    page,
  }) => {
    await openChart(page);
    const { left, right, mid } = await spots(page);
    await chooseTool(page, 'Regression trend');
    await clickThrough(page, [await pointOf(page, left, mid), await pointOf(page, right, mid)]);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    const [trend] = await drawingsOf(page);
    const id = trend?.id as string;
    const spread = async () => {
      const shape = await shapeOf(page, id);
      return Math.abs((shape.looks[0]?.[0]?.y ?? 0) - (shape.lines[0]?.[0]?.y ?? 0));
    };
    const two = await spread();
    await page
      .getByRole('toolbar', { name: 'Drawing toolbar' })
      .getByRole('button', { name: 'Settings' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Regression trend' });
    await expect(dialog.getByRole('tab', { selected: true })).toHaveText('Inputs');
    await dialog.getByRole('spinbutton', { name: 'Upper deviation' }).fill('1');
    await expect.poll(spread).toBeCloseTo(two / 2, 0);
    await dialog.getByRole('button', { name: 'Ok' }).click();
    expect((await drawingsOf(page))[0]?.style.regression.upperDeviation).toBe(1);
  });
});

test('dragging a channel among a hundred drawings, ten of them filled, keeps every task short', async ({
  page,
  market,
}) => {
  // Ninety trend lines, five channels and five pitchforks, all over one another. (A hundred
  // channels and pitchforks, all filled, repaint in about 110 ms in the cloud's software canvas,
  // measured 2026-11-26: docs/SPEC.md §9.)
  await openChart(page);
  const { left, right, low, high } = await spots(page);
  const many: Drawing[] = [];
  for (let i = 0; i < 100; i++) {
    const shift = (high - low) * (i / 400);
    const kind = i % 20 === 7 ? 'parallel-channel' : i % 20 === 17 ? 'pitchfork' : 'trend-line';
    many.push(
      kind === 'parallel-channel'
        ? await stored(page, `d${i}`, kind, [
            [left, low + shift],
            [right, high - shift],
            [left, low + shift - (high - low) / 5],
          ])
        : kind === 'pitchfork'
          ? await stored(page, `d${i}`, kind, [
              [left, low + shift],
              [Math.round((left + right) / 2), high - shift],
              [right, (low + high) / 2],
            ])
          : await stored(page, `d${i}`, kind, [
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
  // A channel half way up the pile, by its first line's middle handle: those under it and over
  // it stand still while it moves.
  await page.evaluate(() =>
    (
      window as unknown as { __tradingNerd: { chart: { selectDrawings(ids: string[]): void } } }
    ).__tradingNerd.chart.selectDrawings(['d47']),
  );
  const grab = (await shapeOf(page, 'd47')).handles[5] as Pt;
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(grab.x, grab.y + i);
  await settle(page);
  const chart = await page.getByRole('main', { name: 'Chart' }).boundingBox();
  if (!chart) throw new Error('no chart');
  const moving = PNG.sync.read(await page.screenshot({ clip: chart }));
  await page.mouse.up();
  await settle(page);
  const tasks = await page.evaluate(() => (window as unknown as { tasks: number[] }).tasks);
  expect(Math.max(0, ...tasks), `long tasks: ${tasks.join(', ')}`).toBeLessThan(100);
  const moved = (await drawingsOf(page)).find((d) => d.id === 'd47');
  expect(moved?.points[0]?.price).toBeLessThan(many[47]?.points[0]?.price as number);
  // What the still layers showed is what the whole chart painted again shows.
  const still = PNG.sync.read(await page.screenshot({ clip: chart }));
  let differing = 0;
  for (let i = 0; i < moving.data.length; i += 4) {
    const delta = Math.max(
      Math.abs((moving.data[i] ?? 0) - (still.data[i] ?? 0)),
      Math.abs((moving.data[i + 1] ?? 0) - (still.data[i + 1] ?? 0)),
      Math.abs((moving.data[i + 2] ?? 0) - (still.data[i + 2] ?? 0)),
    );
    if (delta > 8) differing++;
  }
  expect(differing / (moving.data.length / 4)).toBeLessThan(0.001);
});
