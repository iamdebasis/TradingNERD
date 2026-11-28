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
 * Managing drawings, milestone D3a (docs/SPEC.md §5.27): several selected at once (Ctrl/⌘ +
 * click, a Ctrl/⌘ box), moved, cloned, recolored, locked and removed together; a drawing's menu
 * (right-click, or the floating toolbar's ⋯) with Visual order, under the bars too, and
 * Visibility on intervals (D3c's words); Clone, Copy and Paste; the arrow keys; Shift's straight
 * moves; Settings for several.
 * Ctrl/⌘ is ControlOrMeta: ⌘ on the user's Mac, Ctrl elsewhere (AGENTS.md).
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
  box: { left: number; top: number; right: number; bottom: number } | null;
  shapes: { id: string; pane: number; points: (Pt | null)[]; handles: Pt[]; lines: Pt[][] }[];
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
const find = async (page: Page, id: string) =>
  (await drawingsOf(page)).find((drawing) => drawing.id === id);

/** The page point of a bar and a price on the price pane. */
async function pointOf(page: Page, bar: number, price: number): Promise<Pt> {
  const origin = await paneOrigin(page);
  const x = await chartCall<number | null>(page, 'barX', bar);
  const y = await chartCall<number | null>(page, 'priceToY', price);
  if (x === null || y === null) throw new Error(`Bar ${bar} at ${price} is not on the chart`);
  return { x: origin.x + x, y: origin.y + y };
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

/** The chart, opened with these drawings stored for its symbol. */
async function openWith(
  page: Page,
  market: { drawings: Map<string, Drawing[]> },
  make: (at: Awaited<ReturnType<typeof spots>>) => Promise<Drawing[]>,
) {
  await openChart(page);
  const at = await spots(page);
  const drawings = await make(at);
  market.drawings.set(SYMBOL, drawings);
  await page.reload();
  await openChart(page);
  await expect.poll(async () => (await drawingsOf(page)).length).toBe(drawings.length);
  return at;
}

/** Two trend lines: `a` low on the left, `b` higher on the right, apart from each other. */
async function twoLines(
  page: Page,
  { left, right, low, high, mid }: Awaited<ReturnType<typeof spots>>,
) {
  const quarter = Math.round((right - left) / 4);
  return [
    await stored(page, 'a', 'trend-line', [
      [left, low],
      [left + quarter, mid],
    ]),
    await stored(page, 'b', 'trend-line', [
      [right - quarter, mid],
      [right, high],
    ]),
  ];
}

const middle = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** A trend line's middle on the page, from its stored points. */
async function middleOf(page: Page, drawing: Drawing): Promise<Pt> {
  const bars = await chartBars(page);
  const bar = (time: number) => bars.findIndex((item) => item.time === time);
  const [p, q] = drawing.points;
  if (!p || !q) throw new Error('not a line');
  return middle(
    await pointOf(page, bar(p.time), p.price),
    await pointOf(page, bar(q.time), q.price),
  );
}

async function clickAt(page: Page, at: Pt): Promise<void> {
  await page.mouse.click(at.x, at.y);
}

async function modClick(page: Page, at: Pt): Promise<void> {
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up('ControlOrMeta');
}

async function dragFrom(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: 'Drawing toolbar' });

/** Selects drawings as the chart's own selection does (the tests' shortcut past the mouse). */
async function select(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((chosen) => {
    (
      window as unknown as { __tradingNerd: { chart: { selectDrawings(ids: string[]): void } } }
    ).__tradingNerd.chart.selectDrawings(chosen);
  }, ids);
}

/** A drawing's right-click menu. */
async function menuOf(page: Page, at: Pt): Promise<Locator> {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Drawing', exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** Chooses an item of a submenu of the drawing's menu. */
async function choose(menu: Locator, parent: string, item: string): Promise<void> {
  await menu.getByRole('menuitem', { name: parent }).hover();
  const submenu = menu.getByRole('menu', { name: parent });
  await expect(submenu).toBeVisible();
  await submenu.getByRole('menuitem', { name: item, exact: true }).click();
}

test.describe('several drawings at once (D3a)', () => {
  test('selects several with Ctrl/⌘ + click and moves them together, as one undo step', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a, b] = await drawingsOf(page);
    if (!a || !b) throw new Error('no drawings');
    await clickAt(page, await middleOf(page, a));
    await modClick(page, await middleOf(page, b));
    await expect.poll(() => selectionOf(page)).toEqual(['a', 'b']);
    await expect(toolbarOf(page)).toBeVisible();
    // Dragged by a: b goes the same way, by the same bars.
    const grab = await middleOf(page, a);
    await dragFrom(page, grab, { x: grab.x + 40, y: grab.y - 30 });
    await expect
      .poll(async () => (await find(page, 'b'))?.points[0]?.time)
      .not.toBe(b.points[0]?.time);
    const [movedA, movedB] = await drawingsOf(page);
    const step = (movedA?.points[0]?.time as number) - (a.points[0]?.time as number);
    expect(step).toBeGreaterThan(0);
    expect((movedB?.points[0]?.time as number) - (b.points[0]?.time as number)).toBe(step);
    expect(movedB?.points[0]?.price).toBeGreaterThan(b.points[0]?.price as number);
    // One undo puts both back.
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => drawingsOf(page)).toEqual([a, b]);
    // Ctrl/⌘ + click again takes one out of the selection.
    await clickAt(page, await middleOf(page, a));
    await modClick(page, await middleOf(page, b));
    await modClick(page, await middleOf(page, a));
    await expect.poll(() => selectionOf(page)).toEqual(['b']);
  });

  test('selects what a Ctrl/⌘ box touches, and removes them together with Delete', async ({
    page,
    market,
  }) => {
    const { left, right, low, mid, high } = await openWith(page, market, async (at) => [
      ...(await twoLines(page, at)),
      await stored(page, 'h', 'horizontal-line', [[at.left, at.high + (at.high - at.low) / 3]]),
    ]);
    // A box over both lines, under the horizontal line.
    const from = await pointOf(page, left - 2, mid + (high - low) / 4);
    const to = await pointOf(page, right + 2, low - (high - low) / 8);
    const before = await chartState(page);
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    // The box shows while it's drawn, and the chart doesn't pan meanwhile.
    expect((await drawingsState(page)).box).not.toBeNull();
    await page.mouse.up();
    await page.keyboard.up('ControlOrMeta');
    expect((await chartState(page)).logicalRange).toEqual(before.logicalRange);
    await expect.poll(() => selectionOf(page)).toEqual(['a', 'b']);
    expect((await drawingsState(page)).box).toBeNull();
    await page.keyboard.press('Delete');
    await expect.poll(() => idsOf(page)).toEqual(['h']);
  });

  test('clones every selected drawing with Ctrl/⌘ + drag, selecting the copies', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a, b] = await drawingsOf(page);
    if (!a || !b) throw new Error('no drawings');
    await clickAt(page, await middleOf(page, a));
    await modClick(page, await middleOf(page, b));
    const grab = await middleOf(page, a);
    await page.keyboard.down('ControlOrMeta');
    await dragFrom(page, grab, { x: grab.x + 50, y: grab.y + 40 });
    await page.keyboard.up('ControlOrMeta');
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(4);
    const [keptA, keptB, copyA, copyB] = await drawingsOf(page);
    expect([keptA, keptB]).toEqual([a, b]);
    expect(await selectionOf(page)).toEqual([copyA?.id, copyB?.id]);
    expect(copyA?.points[0]?.price).toBeLessThan(a.points[0]?.price as number);
    expect(copyB?.points[0]?.price).toBeLessThan(b.points[0]?.price as number);
  });

  test('sets the thickness and lock of every selected drawing from the floating toolbar', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a, b] = await drawingsOf(page);
    if (!a || !b) throw new Error('no drawings');
    await clickAt(page, await middleOf(page, a));
    await modClick(page, await middleOf(page, b));
    const toolbar = toolbarOf(page);
    await toolbar.getByRole('button', { name: 'Line thickness' }).click();
    await page.getByRole('button', { name: '3px' }).click();
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.style.width))
      .toEqual([3, 3]);
    await toolbar.getByRole('button', { name: 'Lock' }).click();
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.locked))
      .toEqual([true, true]);
    // Every one locked: Remove has nothing it can remove, and Delete leaves them.
    await expect(toolbar.getByRole('button', { name: 'Remove' })).toBeDisabled();
    await page.keyboard.press('Delete');
    expect(await idsOf(page)).toEqual(['a', 'b']);
    await toolbar.getByRole('button', { name: 'Unlock' }).click();
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.locked))
      .toEqual([false, false]);
    await toolbar.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => idsOf(page)).toEqual([]);
  });

  test('opens the visibility of several drawings from Settings, set for all as one step', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a, b] = await drawingsOf(page);
    if (!a || !b) throw new Error('no drawings');
    await clickAt(page, await middleOf(page, a));
    await modClick(page, await middleOf(page, b));
    await toolbarOf(page).getByRole('button', { name: 'Settings' }).click();
    // TradingView's "Selected Drawings" with its three tabs (D3c2).
    const dialog = page.getByRole('dialog', { name: 'Selected Drawings' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab')).toHaveText(['Style', 'Displacement', 'Visibility']);
    await dialog.getByRole('tab', { name: 'Visibility' }).click();
    await dialog.getByRole('checkbox', { name: 'Days' }).uncheck();
    await dialog.getByRole('button', { name: 'Ok' }).click();
    await expect(dialog).toBeHidden();
    // On a day's chart, neither shows now; one undo brings both back.
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.visibility.days.on))
      .toEqual([false, false]);
    await expect.poll(async () => (await drawingsState(page)).shapes.length).toBe(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => drawingsOf(page)).toEqual([a, b]);
  });
});

test.describe('Selected Drawings (D3c2)', () => {
  test('shows their differing line colors as a rainbow, and Displacement moves them all as one step', async ({
    page,
    market,
  }) => {
    await openWith(page, market, async (at) => {
      const [a, b] = await twoLines(page, at);
      if (!a || !b) throw new Error('no drawings');
      return [a, { ...b, style: { ...b.style, color: '#F23645' } }];
    });
    const [a, b] = await drawingsOf(page);
    if (!a || !b) throw new Error('no drawings');
    await clickAt(page, await middleOf(page, a));
    await modClick(page, await middleOf(page, b));
    await toolbarOf(page).getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Selected Drawings' });
    await expect(dialog.getByRole('button', { name: 'Line: mixed' })).toBeVisible();
    // Displacement: Enter applies a price expression to every point of both.
    await dialog.getByRole('tab', { name: 'Displacement' }).click();
    await expect(dialog).toContainText('Displacement (price, bar)');
    const price = dialog.getByRole('textbox', { name: 'Price displacement' });
    await expect(price).toHaveAttribute('placeholder', 'e.g. /2');
    await price.fill('+5');
    await price.press('Enter');
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.points.map((p) => p.price)))
      .toEqual([a, b].map((d) => d.points.map((p) => p.price + 5)));
    // A bar expression typed and not applied: Ok applies it as it keeps the rest.
    const bar = dialog.getByRole('textbox', { name: 'Bar displacement' });
    await expect(bar).toHaveAttribute('placeholder', 'e.g. +1');
    await bar.fill('*2');
    await expect(bar).toHaveAttribute('aria-invalid', 'true');
    await bar.fill('+2');
    await dialog.getByRole('button', { name: 'Ok' }).click();
    const bars = await chartBars(page);
    const later = (time: number) =>
      (bars[bars.findIndex((item) => item.time === time) + 2] as Bar).time;
    await expect
      .poll(async () => (await drawingsOf(page)).map((d) => d.points.map((p) => p.time)))
      .toEqual([a, b].map((d) => d.points.map((p) => later(p.time))));
    // One undo step puts both back.
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => drawingsOf(page)).toEqual([a, b]);
  });
});

test.describe('a drawing’s menu (D3a)', () => {
  test('opens on a right-click with Template, Visual order, Visibility on intervals, Object Tree…, Clone, Copy, Lock, Hide, Remove and Settings', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a] = await drawingsOf(page);
    if (!a) throw new Error('no drawings');
    const menu = await menuOf(page, await middleOf(page, a));
    // The right-click selects the drawing it's on.
    expect(await selectionOf(page)).toEqual(['a']);
    await expect(menu.locator(':scope > [role="menuitem"]')).toHaveText([
      // D3b's, while the drawings selected are all of one tool.
      'Template',
      'Visual order',
      'Visibility on intervals',
      // D3c's, after Visibility on intervals for one drawing as TradingView's menu has it
      // (its Help Center images of 2022 and 2024; D3c2).
      'Object Tree…',
      // Clone's drag shortcut as TradingView writes it (D3c2).
      /^Clone(⌘Drag|Ctrl\+Drag)$/,
      /^Copy(⌘C|Ctrl\+C)$/,
      'Lock',
      // D3c's.
      'Hide',
      /^Remove(⌫|Del)$/,
      'Settings…',
    ]);
    // TradingView's order (D3c2), a move that changes nothing greyed out.
    await menu.getByRole('menuitem', { name: 'Visual order' }).hover();
    const order = menu.getByRole('menu', { name: 'Visual order' }).getByRole('menuitem');
    await expect(order).toHaveText([
      'Bring to front',
      'Send to back',
      'Bring forward',
      'Send backward',
    ]);
    for (let i = 0; i < 4; i++) await expect(order.nth(i)).toBeEnabled();
    await menu.getByRole('menuitem', { name: 'Visibility on intervals' }).hover();
    await expect(menu.getByRole('menu', { name: 'Visual order' })).toBeHidden();
    await expect(
      menu.getByRole('menu', { name: 'Visibility on intervals' }).getByRole('menuitem'),
    ).toHaveText([
      'Current interval and above',
      'Current interval and below',
      'Current interval only',
      'All intervals',
    ]);
    // Escape closes the submenu, then the menu, the drawing still selected.
    await page.keyboard.press('Escape');
    await expect(menu.getByRole('menu', { name: 'Visibility on intervals' })).toBeHidden();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(await selectionOf(page)).toEqual(['a']);
  });

  test('opens from the floating toolbar’s ⋯ too, and moves through its items by key', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a] = await drawingsOf(page);
    if (!a) throw new Error('no drawings');
    await clickAt(page, await middleOf(page, a));
    await toolbarOf(page).getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('menu', { name: 'Drawing', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Template' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Visual order' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Visibility on intervals' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(
      menu.getByRole('menu', { name: 'Visibility on intervals' }).getByRole('menuitem').first(),
    ).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(menu.getByRole('menuitem', { name: 'Visibility on intervals' })).toBeFocused();
    // The arrows moved through the menu, not the drawing.
    expect(await find(page, 'a')).toEqual(a);
  });

  test('sends a drawing under the bars and brings it back over them', async ({ page, market }) => {
    const { left, right, low, high } = await openWith(page, market, async (at) => [
      // A flat channel across the middle of the chart, filled.
      await stored(page, 'c', 'parallel-channel', [
        [at.left, at.low],
        [at.right, at.low],
        [at.left, at.high],
      ]),
    ]);
    // A candle inside it, its body tall enough to sample, away from the dashed middle level.
    const bars = await chartBars(page);
    const level = (await pointOf(page, left, (low + high) / 2)).y;
    let sample: Pt | null = null;
    for (let bar = left + 2; bar < right - 2 && !sample; bar++) {
      const item = bars[bar] as Bar;
      const top = Math.max(item.open, item.close);
      const bottom = Math.min(item.open, item.close);
      if (bottom <= low || top >= high) continue;
      const a = await pointOf(page, bar, top);
      const b = await pointOf(page, bar, bottom);
      const y = (a.y + b.y) / 2;
      if (b.y - a.y >= 6 && Math.abs(y - level) > 4) sample = { x: a.x, y };
    }
    if (!sample) throw new Error('no candle to sample');
    const at = sample;
    const pixel = async () => {
      await page.mouse.move(5, 5);
      await settle(page);
      const shot = PNG.sync.read(
        await page.screenshot({ clip: { x: at.x - 1, y: at.y - 1, width: 2, height: 2 } }),
      );
      return [shot.data[0] ?? 0, shot.data[1] ?? 0, shot.data[2] ?? 0];
    };
    // Over the bars, the channel's blue tints the candle; under them, the candle is its own color.
    const over = await pixel();
    const edge = await pointOf(page, left, low);
    const menu = await menuOf(page, { x: edge.x + 40, y: edge.y });
    await choose(menu, 'Visual order', 'Send to back');
    await expect.poll(async () => (await find(page, 'c'))?.below).toBe(true);
    const under = await pixel();
    expect(Math.max(...under.map((value, i) => Math.abs(value - (over[i] ?? 0))))).toBeGreaterThan(
      8,
    );
    // Brought to the front: the tint again.
    await choose(
      await menuOf(page, { x: edge.x + 40, y: edge.y }),
      'Visual order',
      'Bring to front',
    );
    await expect.poll(async () => (await find(page, 'c'))?.below).toBe(false);
    const again = await pixel();
    expect(
      Math.max(...again.map((value, i) => Math.abs(value - (over[i] ?? 0)))),
    ).toBeLessThanOrEqual(2);
    expect(market.drawingSaves.at(-1)?.drawings[0]?.below).toBe(false);
  });

  test('shows a drawing on the current interval only, from Visibility on intervals', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a] = await drawingsOf(page);
    if (!a) throw new Error('no drawings');
    await choose(
      await menuOf(page, await middleOf(page, a)),
      'Visibility on intervals',
      'Current interval only',
    );
    await expect
      .poll(async () => (await find(page, 'a'))?.visibility.days)
      .toEqual({ on: true, from: 1, to: 1 });
    // Gone on 4 hours, back on a day.
    const intervals = page.getByRole('group', { name: 'Intervals' });
    await intervals.getByRole('button', { name: '4h' }).click();
    await expect
      .poll(async () => (await drawingsState(page)).shapes.map((s) => s.id))
      .toEqual(['b']);
    await intervals.getByRole('button', { name: 'D', exact: true }).click();
    await expect
      .poll(async () => (await drawingsState(page)).shapes.map((s) => s.id).sort())
      .toEqual(['a', 'b']);
  });

  test('clones from the menu where the drawing is, and removes all but a locked one', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a, b] = await drawingsOf(page);
    if (!a || !b) throw new Error('no drawings');
    const menu = await menuOf(page, await middleOf(page, a));
    await menu.getByRole('menuitem', { name: 'Clone' }).click();
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(3);
    const copy = (await drawingsOf(page))[2] as Drawing;
    expect(copy.points).toEqual(a.points);
    expect(await selectionOf(page)).toEqual([copy.id]);
    // a locked, then a, b and the copy selected: the menu's Remove takes all but a.
    await select(page, ['a']);
    await toolbarOf(page).getByRole('button', { name: 'Lock' }).click();
    await expect.poll(async () => (await find(page, 'a'))?.locked).toBe(true);
    await select(page, ['a', 'b', copy.id]);
    const removing = await menuOf(page, await middleOf(page, b));
    // The right-click on one of those selected keeps them all.
    expect(await selectionOf(page)).toEqual(['a', 'b', copy.id]);
    await removing.getByRole('menuitem', { name: /^Remove/ }).click();
    await expect.poll(() => idsOf(page)).toEqual(['a']);
  });
});

test.describe('copy, paste and the keys (D3a)', () => {
  test('copies drawings with Ctrl/⌘ + C and pastes them with V, here and on another symbol', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a] = await drawingsOf(page);
    if (!a) throw new Error('no drawings');
    await clickAt(page, await middleOf(page, a));
    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(3);
    const pasted = (await drawingsOf(page))[2] as Drawing;
    expect(pasted.id).not.toBe('a');
    expect(pasted.points).toEqual(a.points);
    expect(await selectionOf(page)).toEqual([pasted.id]);
    // On another symbol, at the same times and prices.
    await page
      .getByRole('complementary', { name: 'Watchlist' })
      .getByRole('button', { name: 'LINKUSDT', exact: true })
      .click();
    await expect.poll(() => idsOf(page)).toEqual([]);
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(1);
    expect((await drawingsOf(page))[0]?.points).toEqual(a.points);
    await expect.poll(() => market.drawingSaves.at(-1)?.symbol).toBe('BINANCE:LINKUSDT');
  });

  test('moves the selection with the arrow keys, and scrolls the chart without one', async ({
    page,
    market,
  }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a] = await drawingsOf(page);
    if (!a) throw new Error('no drawings');
    const bars = await chartBars(page);
    const index = bars.findIndex((bar) => bar.time === a.points[0]?.time);
    await clickAt(page, await middleOf(page, a));
    const range = (await chartState(page)).logicalRange;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await expect
      .poll(async () => (await find(page, 'a'))?.points[0]?.time)
      .toBe(bars[index + 1]?.time);
    expect((await find(page, 'a'))?.points[0]?.price).toBeGreaterThan(a.points[0]?.price as number);
    expect((await chartState(page)).logicalRange).toEqual(range);
    // Nothing selected: the arrows scroll the chart again.
    await page.keyboard.press('Escape');
    await expect.poll(() => selectionOf(page)).toEqual([]);
    const moved = await find(page, 'a');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await chartState(page)).logicalRange).not.toEqual(range);
    expect(await find(page, 'a')).toEqual(moved);
  });

  test('holds a drag with Shift to across, the drawing’s prices kept', async ({ page, market }) => {
    await openWith(page, market, (at) => twoLines(page, at));
    const [a] = await drawingsOf(page);
    if (!a) throw new Error('no drawings');
    const grab = await middleOf(page, a);
    await page.keyboard.down('Shift');
    await dragFrom(page, grab, { x: grab.x + 60, y: grab.y - 15 });
    await page.keyboard.up('Shift');
    await expect
      .poll(async () => (await find(page, 'a'))?.points[0]?.time)
      .not.toBe(a.points[0]?.time);
    expect((await find(page, 'a'))?.points.map((p) => p.price)).toEqual(
      a.points.map((p) => p.price),
    );
  });
});

test('dragging ten selected among a hundred drawings, ten of them filled, keeps every task short', async ({
  page,
  market,
}) => {
  // As D2's: ninety trend lines, five channels and five pitchforks over one another; ten of them
  // selected, spread through the pile, moved together.
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
  // Every tenth, the topmost among them: every trend line crosses the others at its middle, and a
  // press there takes the topmost, d99.
  const chosen = Array.from({ length: 10 }, (_, i) => `d${i * 10 + 9}`);
  await select(page, chosen);
  await page.evaluate(() => {
    const tasks: number[] = [];
    (window as unknown as { tasks: number[] }).tasks = tasks;
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) tasks.push(entry.duration);
    }).observe({ type: 'longtask' });
  });
  const grab = await middleOf(page, many[99] as Drawing);
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
  test.info().annotations.push({ type: 'long tasks', description: tasks.join(', ') || 'none' });
  expect(Math.max(0, ...tasks), `long tasks: ${tasks.join(', ')}`).toBeLessThan(100);
  const drawings = await drawingsOf(page);
  for (const id of chosen) {
    const before = many.find((d) => d.id === id) as Drawing;
    const after = drawings.find((d) => d.id === id);
    expect(after?.points[0]?.price, id).toBeLessThan(before.points[0]?.price as number);
  }
  expect(drawings.find((d) => d.id === 'd98')).toEqual(many[98]);
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
