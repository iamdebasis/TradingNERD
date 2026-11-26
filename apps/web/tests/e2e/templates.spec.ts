import type { Locator, Page } from '@playwright/test';
import {
  type Bar,
  type Drawing,
  type DrawingStyle,
  type DrawingTool,
  defaultDrawingStyle,
  newDrawing,
} from '@tradingnerd/core';
import { chartBars, chartCall, chartState, expect, openChart, paneOrigin, test } from './fixtures';

/**
 * Drawing templates, a tool's last style and favorites, milestone D3b (docs/SPEC.md §5.27): the
 * Template menu in the settings dialog, the floating toolbar and the right-click menu; saving,
 * replacing, applying, the tool's defaults and removing, kept by the (fake) gateway; templates on
 * several of one tool; a new drawing in its tool's last style; the favorites toolbar.
 */

const SYMBOL = 'BINANCE:XRPUSDT';

interface Pt {
  x: number;
  y: number;
}

type DebugWindow = {
  __tradingNerd?: {
    chart: { debugDrawings(): { drawings: Drawing[]; selection: string[] } } | null;
  };
};

async function drawingsOf(page: Page): Promise<Drawing[]> {
  const state = await page.evaluate(
    () => (window as unknown as DebugWindow).__tradingNerd?.chart?.debugDrawings() ?? null,
  );
  if (!state) throw new Error('The chart is not mounted');
  return state.drawings;
}

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

/** Bars and prices well inside the view. */
async function spots(page: Page) {
  const state = await chartState(page);
  const range = state.logicalRange;
  const prices = state.priceRange;
  if (!range || !prices) throw new Error('The chart has no range yet');
  const bar = (share: number) => Math.round(range.from + (range.to - range.from) * share);
  const price = (share: number) => prices.from + (prices.to - prices.from) * share;
  return { bar, price };
}

type Spots = Awaited<ReturnType<typeof spots>>;

/** A trend line or a ray as the gateway would hold it, from bar shares and price shares. */
async function stored(
  page: Page,
  at: Spots,
  id: string,
  tool: DrawingTool,
  [[b1, p1], [b2, p2]]: [[number, number], [number, number]],
  style: Partial<DrawingStyle> = {},
): Promise<Drawing> {
  const bars = await chartBars(page);
  const time = (share: number) => (bars[at.bar(share)] as Bar).time;
  const drawing = newDrawing(id, tool, [
    { time: time(b1), price: at.price(p1) },
    { time: time(b2), price: at.price(p2) },
  ]);
  return { ...drawing, style: { ...drawing.style, ...style } };
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

/** A red, 3 px trend line `a`, a default one `b`, and a ray `r`, apart from each other. */
const three = (page: Page) => (at: Spots) =>
  Promise.all([
    stored(
      page,
      at,
      'a',
      'trend-line',
      [
        [0.2, 0.3],
        [0.3, 0.5],
      ],
      { color: '#F23645', width: 3 },
    ),
    stored(page, at, 'b', 'trend-line', [
      [0.45, 0.3],
      [0.55, 0.5],
    ]),
    stored(page, at, 'r', 'ray', [
      [0.7, 0.3],
      [0.8, 0.5],
    ]),
  ]);

/** A line's middle on the page. */
async function middleOf(page: Page, id: string): Promise<Pt> {
  const drawing = await find(page, id);
  const bars = await chartBars(page);
  const bar = (time: number) => bars.findIndex((item) => item.time === time);
  const [p, q] = drawing?.points ?? [];
  if (!p || !q) throw new Error(`No line ${id}`);
  const a = await pointOf(page, bar(p.time), p.price);
  const b = await pointOf(page, bar(q.time), q.price);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

const toolbarOf = (page: Page) => page.getByRole('toolbar', { name: 'Drawing toolbar' });

/** The left toolbar's trend line tools menu, its tab shown on the group's hover (as D1's tests). */
async function trendLineTools(page: Page): Promise<Locator> {
  const tab = page.getByRole('navigation', { name: 'Drawing tools' }).getByRole('button', {
    name: 'Trend line tools',
    exact: true,
    includeHidden: true,
  });
  await tab.locator('..').hover();
  await tab.click();
  const menu = page.getByRole('menu', { name: 'Trend line tools' });
  await expect(menu).toBeVisible();
  return menu;
}

/** Selects drawings as the chart's own selection does (the tests' shortcut past the mouse). */
async function select(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((chosen) => {
    (
      window as unknown as { __tradingNerd: { chart: { selectDrawings(ids: string[]): void } } }
    ).__tradingNerd.chart.selectDrawings(chosen);
  }, ids);
}

/** The floating toolbar's Templates menu. */
async function templatesMenu(page: Page): Promise<Locator> {
  await toolbarOf(page).getByRole('button', { name: 'Templates' }).click();
  const menu = page.getByRole('menu', { name: 'Templates' });
  await expect(menu).toBeVisible();
  return menu;
}

/** The Template submenu of a drawing's right-click menu. */
async function rightClickTemplates(page: Page, at: Pt): Promise<Locator> {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Drawing', exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Template' }).hover();
  const submenu = menu.getByRole('menu', { name: 'Template' });
  await expect(submenu).toBeVisible();
  return submenu;
}

/** Saves a template under a name from an open Template menu. */
async function saveAs(page: Page, menu: Locator, name: string): Promise<void> {
  await menu.getByRole('menuitem', { name: 'Save drawing template as…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save drawing template as' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Template name' }).fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
}

const lastSave = (market: { templateSaves: { tool: string; templates: unknown[] }[] }) =>
  market.templateSaves.at(-1);

test.describe('drawing templates (D3b)', () => {
  test('saves one from the settings dialog, applies it from the floating toolbar and the right-click menu, kept after a reload', async ({
    page,
    market,
  }) => {
    await openWith(page, market, three(page));
    // `a`'s settings: its red, 3 px style saved as "Red" (the dialog's Template, bottom left).
    const onA = await middleOf(page, 'a');
    await page.mouse.dblclick(onA.x, onA.y);
    const settings = page.getByRole('dialog', { name: 'Trendline' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Template' }).click();
    const menu = page.getByRole('menu', { name: 'Template' });
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Save drawing template as…',
      'Apply default drawing template',
    ]);
    await saveAs(page, menu, '  Red  ');
    await expect.poll(() => lastSave(market)?.tool).toBe('trend-line');
    const saved = lastSave(market)?.templates as { name: string; style: DrawingStyle }[];
    expect(saved.map((template) => template.name)).toEqual(['Red']);
    expect([saved[0]?.style.color, saved[0]?.style.width]).toEqual(['#F23645', 3]);
    // The settings dialog is still open: saving keeps nothing of the drawing's.
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Cancel' }).click();

    // `b` from the floating toolbar's Templates: red, 3 px, as one undo step.
    await select(page, ['b']);
    const fromToolbar = await templatesMenu(page);
    await expect(fromToolbar.getByRole('menuitem')).toHaveText([
      'Save drawing template as…',
      'Apply default drawing template',
      'Red',
    ]);
    await fromToolbar.getByRole('menuitem', { name: 'Red', exact: true }).click();
    await expect.poll(async () => (await find(page, 'b'))?.style.color).toBe('#F23645');
    expect((await find(page, 'b'))?.style.width).toBe(3);
    await expect.poll(() => market.drawingSaves.at(-1)?.drawings[1]?.style.color).toBe('#F23645');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await find(page, 'b'))?.style.color).toBe('#2962FF');

    // Reloaded, the template is still there: from the right-click menu, then the defaults back.
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(3);
    const submenu = await rightClickTemplates(page, await middleOf(page, 'a'));
    await expect(submenu.getByRole('menuitem', { name: 'Red', exact: true })).toBeVisible();
    await submenu.getByRole('menuitem', { name: 'Apply default drawing template' }).click();
    await expect
      .poll(async () => (await find(page, 'a'))?.style)
      .toEqual(defaultDrawingStyle('trend-line'));
  });

  test('asks before replacing a template of that name, and before removing one', async ({
    page,
    market,
  }) => {
    market.templates = {
      tools: { 'trend-line': [{ name: 'Red', style: defaultDrawingStyle('trend-line') }] },
    };
    await openWith(page, market, three(page));
    await select(page, ['a']);
    await saveAs(page, await templatesMenu(page), 'Red');
    const question = page.getByRole('dialog', { name: 'Save drawing template as' });
    await expect(question).toContainText('A template named “Red” already exists.');
    // Cancel goes back to the name, kept as typed.
    await question.getByRole('button', { name: 'Cancel' }).click();
    const named = page.getByRole('dialog', { name: 'Save drawing template as' });
    await expect(named.getByRole('textbox', { name: 'Template name' })).toHaveValue('Red');
    await named.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Replace' }).click();
    await expect.poll(() => lastSave(market)?.templates.length).toBe(1);
    const replaced = lastSave(market)?.templates[0] as { name: string; style: DrawingStyle };
    expect([replaced.name, replaced.style.color]).toEqual(['Red', '#F23645']);

    // Removed with its ✕, after the question.
    const menu = await templatesMenu(page);
    await menu.getByRole('menuitem', { name: 'Red', exact: true }).hover();
    await menu.getByRole('button', { name: 'Remove template Red' }).click();
    const removing = page.getByRole('dialog', { name: 'Remove drawing template' });
    await expect(removing).toContainText('“Red”');
    await removing.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => lastSave(market)).toEqual({ tool: 'trend-line', templates: [] });
  });

  test('removes a template from the keyboard too, leaving the drawing selected', async ({
    page,
    market,
  }) => {
    const style = defaultDrawingStyle('trend-line');
    market.templates = {
      tools: {
        'trend-line': [
          { name: 'Red', style },
          { name: 'Green', style },
        ],
      },
    };
    await openWith(page, market, three(page));
    await select(page, ['b']);
    const menu = await templatesMenu(page);
    // By name: Green first. ↓ from the first item to it, then Delete asks first.
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Save drawing template as…',
      'Apply default drawing template',
      'Green',
      'Red',
    ]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Green', exact: true })).toBeFocused();
    await page.keyboard.press('Delete');
    const removing = page.getByRole('dialog', { name: 'Remove drawing template' });
    await expect(removing).toContainText('“Green”');
    await removing.getByRole('button', { name: 'Remove' }).click();
    await expect
      .poll(() =>
        (lastSave(market)?.templates as { name: string }[] | undefined)?.map((t) => t.name),
      )
      .toEqual(['Red']);
    // The Delete was the menu's: the drawing is still there, and still selected.
    expect((await drawingsOf(page)).map((drawing) => drawing.id)).toEqual(['a', 'b', 'r']);
    await expect(toolbarOf(page)).toBeVisible();
  });

  test('applies a template to several of one tool at once, and offers none for mixed tools', async ({
    page,
    market,
  }) => {
    market.templates = {
      tools: {
        'trend-line': [
          { name: 'Green', style: { ...defaultDrawingStyle('trend-line'), color: '#089981' } },
        ],
      },
    };
    await openWith(page, market, three(page));
    await select(page, ['a', 'b']);
    const menu = await templatesMenu(page);
    await menu.getByRole('menuitem', { name: 'Green', exact: true }).click();
    await expect
      .poll(async () => (await drawingsOf(page)).map((drawing) => drawing.style.color))
      .toEqual(['#089981', '#089981', '#2962FF']);
    // One step undoes both.
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => (await drawingsOf(page)).map((drawing) => drawing.style.color))
      .toEqual(['#F23645', '#2962FF', '#2962FF']);
    // A trend line and a ray: no Templates, and no Template › in the menu.
    await select(page, ['a', 'r']);
    await expect(toolbarOf(page).getByRole('button', { name: 'More' })).toBeVisible();
    await expect(toolbarOf(page).getByRole('button', { name: 'Templates' })).toHaveCount(0);
    const at = await middleOf(page, 'r');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    const drawingMenu = page.getByRole('menu', { name: 'Drawing', exact: true });
    await expect(drawingMenu.getByRole('menuitem', { name: 'Visual order' })).toBeVisible();
    await expect(drawingMenu.getByRole('menuitem', { name: 'Template' })).toHaveCount(0);
  });

  test('keeps Escape in the Template menu and its question, the settings dialog staying open', async ({
    page,
    market,
  }) => {
    await openWith(page, market, three(page));
    const at = await middleOf(page, 'b');
    await page.mouse.dblclick(at.x, at.y);
    const settings = page.getByRole('dialog', { name: 'Trendline' });
    await settings.getByRole('button', { name: 'Template' }).click();
    const menu = page.getByRole('menu', { name: 'Template' });
    await expect(menu).toBeVisible();
    // With no room under the button (the dialog's foot near the window's), the menu opens above
    // it, never over it.
    const button = await settings.getByRole('button', { name: 'Template' }).boundingBox();
    const box = await menu.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(button?.y ?? 0);
    // A second press on Template closes its menu, as a press on any menu button does.
    await settings.getByRole('button', { name: 'Template' }).click();
    await expect(menu).toBeHidden();
    await settings.getByRole('button', { name: 'Template' }).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Template' }).click();
    await menu.getByRole('menuitem', { name: 'Save drawing template as…' }).click();
    const named = page.getByRole('dialog', { name: 'Save drawing template as' });
    await expect(named).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(named).toBeHidden();
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    expect(market.templateSaves).toEqual([]);
  });
});

test.describe('a tool’s last style and favorites (D3b)', () => {
  test('starts a new trend line in the style last given one', async ({ page, market }) => {
    const at = await openWith(page, market, async (spot) => [
      await stored(page, spot, 'b', 'trend-line', [
        [0.45, 0.3],
        [0.55, 0.5],
      ]),
    ]);
    await select(page, ['b']);
    await toolbarOf(page).getByRole('button', { name: 'Line thickness' }).click();
    await page.getByRole('button', { name: '4px' }).click();
    await expect.poll(async () => (await find(page, 'b'))?.style.width).toBe(4);
    // A new trend line, drawn by hand (⌥T, then two clicks), comes 4 px wide.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+KeyT');
    const from = await pointOf(page, at.bar(0.65), at.price(0.4));
    const to = await pointOf(page, at.bar(0.75), at.price(0.6));
    await page.mouse.click(from.x, from.y);
    await page.mouse.click(to.x, to.y);
    await expect.poll(async () => (await drawingsOf(page)).length).toBe(2);
    const drawn = (await drawingsOf(page))[1];
    expect([drawn?.tool, drawn?.style.width]).toEqual(['trend-line', 4]);
    // Another tool keeps its own defaults.
    expect(defaultDrawingStyle('ray').width).toBe(2);
  });

  test('stars a tool for the favorites toolbar, which chooses it and stays where it’s put', async ({
    page,
    market,
  }) => {
    const at = await openWith(page, market, async () => []);
    const favorites = page.getByRole('toolbar', { name: 'Favorite drawing tools' });
    await expect(favorites).toHaveCount(0);
    const tools = await trendLineTools(page);
    await tools.getByRole('menuitemradio', { name: 'Ray', exact: true }).hover();
    await tools.getByRole('button', { name: 'Add Ray to favorites' }).click();
    // The menu stays open, the star on; the favorites toolbar shows the ray.
    await expect(tools.getByRole('button', { name: 'Remove Ray from favorites' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(favorites.getByRole('button')).toHaveCount(1);
    await page.keyboard.press('Escape');
    const ray = favorites.getByRole('button', { name: 'Ray', exact: true });
    await ray.click();
    await expect(ray).toHaveAttribute('aria-pressed', 'true');
    const from = await pointOf(page, at.bar(0.4), at.price(0.4));
    const to = await pointOf(page, at.bar(0.5), at.price(0.6));
    await page.mouse.click(from.x, from.y);
    await page.mouse.click(to.x, to.y);
    await expect.poll(async () => (await drawingsOf(page))[0]?.tool).toBe('ray');
    await expect(ray).toHaveAttribute('aria-pressed', 'false');

    // At first, at the chart's top right, 8 px from its top and 8 px left of the price scale,
    // clear of the legend and of the floating toolbar.
    const before = await favorites.boundingBox();
    const origin = await paneOrigin(page);
    const plot = (await chartState(page)).width;
    expect(
      Math.abs((before?.x ?? 0) + (before?.width ?? 0) - (origin.x + plot - 8)),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs((before?.y ?? 0) - (origin.y + 8))).toBeLessThanOrEqual(1);
    // Moved by its grip, and kept there after a reload.
    const grip = favorites.locator('[title="Drag"]');
    const start = await grip.boundingBox();
    if (!before || !start) throw new Error('no favorites toolbar');
    const grabAt = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    await page.mouse.move(grabAt.x, grabAt.y);
    await page.mouse.down();
    await page.mouse.move(grabAt.x - 120, grabAt.y + 80, { steps: 6 });
    await page.mouse.up();
    const moved = await favorites.boundingBox();
    expect((moved?.x ?? 0) - before.x).toBeCloseTo(-120, 0);
    expect((moved?.y ?? 0) - before.y).toBeCloseTo(80, 0);
    await page.reload();
    await openChart(page);
    await expect.poll(async () => (await favorites.boundingBox())?.x).toBe(moved?.x);
    expect((await favorites.boundingBox())?.y).toBe(moved?.y);

    // Unstarred, the toolbar goes.
    await trendLineTools(page);
    await tools.getByRole('menuitemradio', { name: 'Ray', exact: true }).hover();
    await tools.getByRole('button', { name: 'Remove Ray from favorites' }).click();
    await expect(favorites).toHaveCount(0);
  });
});
