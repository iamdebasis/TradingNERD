import type { Page } from '@playwright/test';
import type { Bar } from '@tradingnerd/core';
import {
  defaultSettings,
  IndicatorRun,
  indicatorTitle,
  RSI,
  VOLUME,
} from '@tradingnerd/indicators';
import { PNG } from 'pngjs';
import {
  chartBars,
  chartCall,
  chartState,
  DAY,
  dispatchWheel,
  expect,
  FIRST_TICK_BAR,
  LAST_DAY,
  makeBars,
  makeStockBars,
  openChart,
  paneOrigin,
  STOCK_NOW,
  settle,
  stockInfoFor,
  test,
} from './fixtures';

/**
 * Indicators (docs/SPEC.md §5.15, milestone I1): the Indicators button and dialog, Volume and
 * RSI on the chart, their legend rows and settings, panes, and the warm-up rule. Checked
 * through the chart's state and the page's text, so they run anywhere; their look is checked
 * against TradingView's screenshots on the Mac.
 */

const XRP = { base: 'XRP', hasVolume: true };
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Indicators, metrics, and strategies' });
const row = (page: Page, id: string) => page.locator(`[data-indicator="${id}"]`);
const indicatorsOf = async (page: Page) => (await chartState(page)).indicators;

/** Adds a built-in from the Indicators dialog, opened from the top bar, and closes it. */
async function addIndicator(page: Page, name: string) {
  await page.getByRole('banner').getByRole('button', { name: 'Indicators', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('option', { name }).click();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toBeHidden();
}

/** RSI's values over these bars with its defaults (or `inputs`), as TradingView computes them. */
function rsiOver(bars: readonly Bar[], inputs = {}): number[][] {
  const run = new IndicatorRun(RSI, { ...defaultSettings(RSI).inputs, ...inputs }, XRP);
  run.setBars(bars);
  return run.values;
}

/** RSI's latest value over the bars the chart holds now, as its legend writes it. */
async function latestRsi(page: Page): Promise<string> {
  const [rsi] = rsiOver(await chartBars(page)) as [number[]];
  return (rsi.at(-1) as number).toFixed(2);
}

/** The page's color at a point (CSS px), read from a screenshot at the device's scale. */
async function colorAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const shot = PNG.sync.read(
    await page.screenshot({
      clip: { x: Math.round(x) - 1, y: Math.round(y) - 1, width: 2, height: 2 },
    }),
  );
  const at = (shot.width * Math.floor(shot.height / 2) + Math.floor(shot.width / 2)) * 4;
  return [shot.data[at] ?? 0, shot.data[at + 1] ?? 0, shot.data[at + 2] ?? 0];
}

/** Moves the mouse off the chart, so the legend shows the latest bar again. */
async function leaveChart(page: Page) {
  await page.mouse.move(1, 1);
}

/** Opens an indicator's settings from its legend title, on one of its tabs. */
async function openSettings(page: Page, id: string, title: string, tab: 'Inputs' | 'Style') {
  await row(page, id).getByRole('button', { name: title, exact: true }).dblclick();
  const settings = page.getByRole('dialog', { name: title.split(' ')[0] });
  await settings.getByRole('tab', { name: tab }).click();
  return settings;
}

test("the Indicators button opens TradingView's dialog; a click adds RSI in a pane below, and the dialog stays open", async ({
  page,
}) => {
  await openChart(page);
  await page.getByRole('banner').getByRole('button', { name: 'Indicators', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('option')).toHaveText(['Relative Strength Index', 'Volume']);
  await dialog(page).getByRole('option', { name: 'Relative Strength Index' }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText('Relative Strength Index added to the chart')).toBeVisible();
  await expect.poll(async () => (await chartState(page)).panes.length).toBe(2);
  const [rsi] = await indicatorsOf(page);
  expect(rsi).toMatchObject({ id: 'rsi-1', kind: 'rsi', pane: 1, levels: 3 });
  expect(rsi?.plots.map((plot) => plot.id)).toEqual(['rsi', 'ma']);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  // Its legend sits at the top of its pane, titled as TradingView's.
  await expect(page.locator('[data-pane-legend="rsi-1"]')).toContainText('RSI 14 close');
});

test('/ opens the dialog; typing finds by name and short name; Enter adds the first match', async ({
  page,
}) => {
  await openChart(page);
  await page.keyboard.press('/');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.type('relative str');
  await expect(dialog(page).getByRole('option')).toHaveText(['Relative Strength Index']);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('vol');
  await expect(dialog(page).getByRole('option')).toHaveText(['Volume']);
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await indicatorsOf(page)).map((item) => item.kind))
    .toEqual(['volume']);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('macd');
  await expect(dialog(page).getByText('No indicators match your criteria')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('Volume sits at the bottom of the price pane: "Vol · XRP" with the bar\'s volume, in its color', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Volume');
  await expect.poll(async () => (await indicatorsOf(page))[0]?.plots[0]?.points).toBe(1_000);
  const [volume] = await indicatorsOf(page);
  expect(volume).toMatchObject({ pane: 0, levels: 0 });
  // Its MA is there but hidden, as TradingView's default.
  expect(volume?.plots.map((plot) => plot.id)).toEqual(['volume']);
  expect((await chartState(page)).panes).toHaveLength(1);
  const legend = row(page, 'volume-1');
  await expect(legend).toContainText('Vol · XRP');
  // The live bar: 20M, a falling bar (it closed under its open), so red.
  const value = legend.locator('[data-plot="volume"]');
  await expect(value).toHaveText('20M');
  await expect(value).toHaveCSS('color', 'rgb(242, 54, 69)');
  expect(market.bars.at(-1)?.volume).toBe(2e7);
});

test("RSI's values are TradingView's formula over the chart's bars, and agree with the whole history's", async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const loaded = market.bars.slice(-1_000);
  const [rsi, ma] = rsiOver(loaded) as [number[], number[]];
  const legend = row(page, 'rsi-1');
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText((rsi.at(-1) as number).toFixed(2));
  await expect(legend.locator('[data-plot="ma"]')).toHaveText((ma.at(-1) as number).toFixed(2));
  // Settled: computed from 1,500 bars further back, the shown digits are the same.
  const [whole] = rsiOver(market.bars) as [number[]];
  expect((whole.at(-1) as number).toFixed(2)).toBe((rsi.at(-1) as number).toFixed(2));
  // The value labels on its pane's price axis show the same.
  const [state] = await indicatorsOf(page);
  expect(state?.valueLabels).toEqual([
    (rsi.at(-1) as number).toFixed(2),
    (ma.at(-1) as number).toFixed(2),
  ]);
});

test('live: a tick moves the last values, a new bar commits the one before, a late correction redoes it', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  await addIndicator(page, 'Volume');
  const loaded = market.bars.slice(-1_000);
  const last = loaded.at(-1) as Bar;
  const rsiText = row(page, 'rsi-1').locator('[data-plot="rsi"]');
  const expectRsi = async (bars: Bar[]) => {
    const [rsi] = rsiOver(bars) as [number[]];
    await expect(rsiText).toHaveText((rsi.at(-1) as number).toFixed(2));
  };
  // A tick on today's bar.
  const tick = { ...last, close: 1.35, high: 1.35, volume: 2.5e7 };
  await market.sendBar(tick);
  await expectRsi([...loaded.slice(0, -1), tick]);
  await expect(row(page, 'volume-1').locator('[data-plot="volume"]')).toHaveText('25M');
  // Tomorrow's bar opens; today's is committed as last seen.
  const next = {
    time: last.time + DAY,
    open: 1.35,
    high: 1.36,
    low: 1.34,
    close: 1.355,
    volume: 1e6,
  };
  await market.sendBar(next);
  await expectRsi([...loaded.slice(0, -1), tick, next]);
  // The exchange's final word on today comes after: computed as if it had been seen first.
  const final = { ...tick, close: 1.33, low: Math.min(tick.low, 1.33) };
  await market.sendBar(final, true);
  await expectRsi([...loaded.slice(0, -1), final, next]);
  const [rsi] = await indicatorsOf(page);
  expect(rsi?.plots[0]).toMatchObject({ start: 294, points: 1_001 - 294 });
});

test('the legend follows the cursor in any pane, and the latest bar again when it leaves', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  await addIndicator(page, 'Volume');
  const loaded = market.bars.slice(-1_000);
  const [rsi] = rsiOver(loaded) as [number[]];
  const origin = await paneOrigin(page);
  const index = 990;
  const x = await chartCall<number>(page, 'barX', index);
  const layout = await page.evaluate(() =>
    (
      window as unknown as {
        __tradingNerd: { chart: { paneLayout(): { top: number; height: number }[] } };
      }
    ).__tradingNerd.chart.paneLayout(),
  );
  const pane = layout[1] as { top: number; height: number };
  await page.mouse.move(origin.x + x, origin.y + pane.top + pane.height / 2);
  const legend = row(page, 'rsi-1');
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText((rsi[index] as number).toFixed(2));
  // In millions with at most two decimals, as TradingView writes volumes.
  const millions = ((loaded[index]?.volume ?? 0) / 1e6).toFixed(2).replace(/\.?0+$/, '');
  await expect(row(page, 'volume-1').locator('[data-plot="volume"]')).toHaveText(`${millions}M`);
  await page.mouse.move(origin.x + 5, origin.y - 20);
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText((rsi.at(-1) as number).toFixed(2));
});

test("a row's Hide, Settings and Remove; a hidden indicator keeps its row and its pane", async ({
  page,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const legend = row(page, 'rsi-1');
  await legend.hover();
  await legend.getByRole('button', { name: 'Hide' }).click();
  await expect(legend).toHaveAttribute('data-hidden', 'true');
  await expect(legend.locator('[data-plot]')).toHaveCount(0);
  await expect.poll(async () => (await indicatorsOf(page))[0]?.plots).toEqual([]);
  expect((await chartState(page)).panes).toHaveLength(2);
  await legend.getByRole('button', { name: 'Show' }).click();
  await expect(legend).not.toHaveAttribute('data-hidden');
  await expect.poll(async () => (await indicatorsOf(page))[0]?.plots.length).toBe(2);

  await legend.hover();
  await legend.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog', { name: 'RSI' })).toBeVisible();
  await page.keyboard.press('Escape');

  await legend.hover();
  await legend.getByRole('button', { name: 'Remove' }).click();
  await expect(legend).toHaveCount(0);
  await expect.poll(async () => (await chartState(page)).panes.length).toBe(1);
  expect(await indicatorsOf(page)).toEqual([]);
});

test("settings apply at once; Cancel puts them back, Ok keeps them, Reset settings restores TradingView's", async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const legend = row(page, 'rsi-1');
  await legend.getByRole('button', { name: 'RSI 14 close' }).dblclick();
  const settings = page.getByRole('dialog', { name: 'RSI' });
  await expect(settings.getByRole('tab', { name: 'Inputs' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const length = settings.getByLabel('RSI Length');
  await length.fill('7');
  await expect(legend).toContainText('RSI 7 close');
  const [rsi7] = rsiOver(market.bars.slice(-1_000), { length: 7 }) as [number[]];
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText((rsi7.at(-1) as number).toFixed(2));
  await settings.getByRole('button', { name: 'Cancel' }).click();
  await expect(legend).toContainText('RSI 14 close');

  await legend.getByRole('button', { name: 'RSI 14 close' }).dblclick();
  await settings.getByLabel('RSI Length').fill('21');
  // "BB StdDev" only matters with Bollinger Bands, so it's greyed out until then.
  await expect(settings.getByLabel('BB StdDev')).toBeDisabled();
  await settings.getByRole('button', { name: 'Ok' }).click();
  await expect(settings).toBeHidden();
  await expect(legend).toContainText('RSI 21 close');

  await legend.getByRole('button', { name: 'RSI 21 close' }).dblclick();
  await settings.getByRole('tab', { name: 'Style' }).click();
  await settings.getByRole('checkbox', { name: 'RSI-based MA' }).uncheck();
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.plots.map((p) => p.id))
    .toEqual(['rsi']);
  await settings.getByRole('button', { name: 'Defaults' }).click();
  await settings.getByRole('menuitem', { name: 'Reset settings' }).click();
  await expect(legend).toContainText('RSI 14 close');
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.plots.map((p) => p.id))
    .toEqual(['rsi', 'ma']);
  await settings.getByRole('button', { name: 'Ok' }).click();
});

test('indicators and their settings survive a reload and a switch of interval', async ({
  page,
}) => {
  await openChart(page);
  await addIndicator(page, 'Volume');
  await addIndicator(page, 'Relative Strength Index');
  await row(page, 'rsi-1').getByRole('button', { name: 'RSI 14 close' }).dblclick();
  await page.getByRole('dialog', { name: 'RSI' }).getByLabel('RSI Length').fill('9');
  await page.getByRole('dialog', { name: 'RSI' }).getByRole('button', { name: 'Ok' }).click();
  await page.reload();
  await expect
    .poll(async () => (await indicatorsOf(page).catch(() => [])).map((item) => item.id))
    .toEqual(['volume-1', 'rsi-1']);
  await expect(row(page, 'rsi-1')).toContainText('RSI 9 close');
  await page.getByRole('banner').getByRole('button', { name: '1h', exact: true }).click();
  await expect.poll(async () => (await chartState(page)).lastBar?.time).not.toBe(LAST_DAY);
  await expect
    .poll(async () => (await indicatorsOf(page))[1]?.plots[0]?.points ?? 0)
    .toBeGreaterThan(0);
  expect((await chartState(page)).panes).toHaveLength(2);
});

test('a symbol without real volume shows n/a and draws no columns', async ({ page }) => {
  await openChart(page);
  await addIndicator(page, 'Volume');
  await page.goto('/?symbol=CRYPTOCAP:TOTAL&interval=1D');
  await expect
    .poll(async () => (await chartState(page).catch(() => null))?.barCount ?? 0)
    .toBeGreaterThan(0);
  await expect(row(page, 'volume-1')).toContainText('Vol · TOTAL');
  await expect(row(page, 'volume-1').locator('[data-plot="volume"]')).toHaveText('n/a');
  expect((await indicatorsOf(page))[0]?.plots[0]?.points).toBe(0);
});

test('the warm-up rule: RSI waits until settled, older pages fill it in, and at the listing it starts on its 15th bar', async ({
  page,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const plotsOf = async () => (await indicatorsOf(page))[0]?.plots ?? [];
  // 1,000 of 2,500 bars: RSI 14 shows once its unknown past weighs under a billionth.
  expect(await plotsOf()).toMatchObject([
    { id: 'rsi', start: 294, points: 706 },
    { id: 'ma', start: 307, points: 693 },
  ]);
  // Scrolled back to the start, every page loads; the last starts at the pair's listing.
  for (let i = 0; i < 6 && (await chartState(page)).barCount < 2_500; i++) {
    await chartCall(page, 'scrollBars', -3_000);
    await settle(page);
    await expect
      .poll(async () => (await chartState(page)).barCount)
      .toBeGreaterThan(1_000 * Math.min(i + 1, 2));
  }
  await expect.poll(async () => (await chartState(page)).barCount).toBe(2_500);
  await expect.poll(plotsOf).toMatchObject([
    { id: 'rsi', start: 0, points: 2_500 - 14 },
    { id: 'ma', start: 0, points: 2_500 - 27 },
  ]);
});

test("a pair listed recently: its whole history is one page, and RSI starts where TradingView's does", async ({
  page,
  market,
}) => {
  market.bars = makeBars(300);
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  expect((await indicatorsOf(page))[0]?.plots).toMatchObject([
    { id: 'rsi', start: 0, points: 286 },
    { id: 'ma', start: 0, points: 273 },
  ]);
  // On a bar before the 15th, there's no value yet: ∅.
  const origin = await paneOrigin(page);
  const range = (await chartState(page)).logicalRange;
  await chartCall(page, 'scrollBars', -Math.round((range?.from ?? 0) - 2));
  await settle(page);
  const x = await chartCall<number>(page, 'barX', 5);
  await page.mouse.move(origin.x + x, origin.y + 200);
  await expect(row(page, 'rsi-1').locator('[data-plot="rsi"]')).toHaveText('∅');
  expect(market.bars[0]?.time).toBe(LAST_DAY - 299 * DAY);
});

test('favorites: ☆ stars one, Favorites and the ⌄ list it, and one click there adds it', async ({
  page,
}) => {
  await openChart(page);
  await page.keyboard.press('/');
  await dialog(page).getByRole('option', { name: 'Relative Strength Index' }).hover();
  await dialog(page).getByRole('button', { name: 'Add to favorites' }).click();
  await dialog(page).getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(dialog(page).getByRole('option')).toHaveText(['Relative Strength Index']);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: 'Favorite indicators' }).click();
  await page.getByRole('menuitem', { name: 'Relative Strength Index' }).click();
  await expect
    .poll(async () => (await indicatorsOf(page)).map((item) => item.kind))
    .toEqual(['rsi']);
});

test('the separator between panes resizes the RSI pane, and its height is kept', async ({
  page,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const before = (await chartState(page)).panes;
  const handle = page.locator('div[style*="row-resize"][style*="absolute"]');
  const box = await handle.boundingBox();
  if (!box) throw new Error('No pane separator');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 200, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, y - 50, { steps: 5 });
  await page.mouse.move(box.x + 200, y - 100, { steps: 5 });
  await page.mouse.up();
  const after = (await chartState(page)).panes;
  expect((after[1]?.height ?? 0) - (before[1]?.height ?? 0)).toBeGreaterThan(80);
  // The price pane's prices didn't move with it: the drag was the separator's.
  expect(after[0]?.autoScale).toBe(true);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('tn.chart.indicators') ?? ''))
    .toContain('paneStretch');
  await page.reload();
  await expect
    .poll(async () => (await chartState(page).catch(() => null))?.panes[1]?.height ?? 0)
    .toBeGreaterThan((before[1]?.height ?? 0) + 80);
});

test("the wheel over the RSI pane's price axis stretches that pane's scale only", async ({
  page,
}) => {
  const state = await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const panes = (await chartState(page)).panes;
  const rsiTop = (panes[0]?.height ?? 0) + 1;
  await dispatchWheel(page, state.paneWidth + 30, rsiTop + (panes[1]?.height ?? 0) / 2, [
    { deltaY: -100 },
  ]);
  await settle(page);
  const after = (await chartState(page)).panes;
  expect(after[1]?.autoScale).toBe(false);
  expect(after[0]?.autoScale).toBe(true);
});

test('the Volume definition and its default settings are what the chart draws', () => {
  // Kept in step with the dialog and the legend: both list what the registry has.
  expect(indicatorTitle(VOLUME, defaultSettings(VOLUME).inputs, XRP)).toBe('Vol · XRP');
  expect(indicatorTitle(RSI, defaultSettings(RSI).inputs, XRP)).toBe('RSI 14 close');
});

test("the Style tab's output and input values: Precision, the labels on the price scale, and the legend's values and inputs", async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const [rsi, ma] = rsiOver(market.bars.slice(-1_000)) as [number[], number[]];
  const last = (values: number[], digits: number) => (values.at(-1) as number).toFixed(digits);
  const legend = row(page, 'rsi-1');
  const labels = async () => (await indicatorsOf(page))[0]?.valueLabels;
  const settings = await openSettings(page, 'rsi-1', 'RSI 14 close', 'Style');

  // Precision: the legend, the labels on the price scale, and the scale's own numbers.
  await settings.getByRole('button', { name: 'Precision' }).click();
  await page
    .getByRole('listbox', { name: 'Precision' })
    .getByRole('option', { name: '4', exact: true })
    .click();
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText(last(rsi, 4));
  await expect(legend.locator('[data-plot="ma"]')).toHaveText(last(ma, 4));
  await expect.poll(labels).toEqual([last(rsi, 4), last(ma, 4)]);
  const before = (await indicatorsOf(page))[0]?.plots;

  // Labels on price scale, off: none on its axis.
  await settings.getByRole('checkbox', { name: 'Labels on price scale' }).uncheck();
  await expect.poll(labels).toEqual([]);
  // Values in status line, off: the legend keeps its title only.
  await settings.getByRole('checkbox', { name: 'Values in status line' }).uncheck();
  await expect(legend.locator('[data-plot]')).toHaveCount(0);
  // Inputs in status line, off: "RSI" alone.
  await settings.getByRole('checkbox', { name: 'Inputs in status line' }).uncheck();
  await expect(legend.getByRole('button', { name: 'RSI', exact: true })).toBeVisible();
  // Only how its values show changed: the same series, with the same points.
  expect((await indicatorsOf(page))[0]?.plots).toEqual(before);

  // Cancel puts them all back.
  await settings.getByRole('button', { name: 'Cancel' }).click();
  await leaveChart(page);
  await expect(legend.getByRole('button', { name: 'RSI 14 close', exact: true })).toBeVisible();
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText(last(rsi, 2));
  await expect.poll(labels).toEqual([last(rsi, 2), last(ma, 2)]);

  // Ok keeps them, through a reload.
  const again = await openSettings(page, 'rsi-1', 'RSI 14 close', 'Style');
  await again.getByRole('checkbox', { name: 'Inputs in status line' }).uncheck();
  await again.getByRole('button', { name: 'Ok' }).click();
  await page.reload();
  await leaveChart(page);
  await expect(row(page, 'rsi-1').getByRole('button', { name: 'RSI', exact: true })).toBeVisible();
  await expect(row(page, 'rsi-1').locator('[data-plot="rsi"]')).toHaveText(last(rsi, 2));
});

test("Volume's Style tab: its Precision and its values in the legend; no inputs in its legend to hide", async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Volume');
  const value = row(page, 'volume-1').locator('[data-plot="volume"]');
  await market.sendBar({ ...(market.bars.at(-1) as Bar), volume: 20_123_456 });
  await expect(value).toHaveText('20.12M');
  const settings = await openSettings(page, 'volume-1', 'Vol · XRP', 'Style');
  await expect(settings.getByRole('checkbox', { name: 'Inputs in status line' })).toHaveCount(0);
  await expect(settings.getByRole('checkbox', { name: 'Labels on price scale' })).toHaveCount(0);
  // Three decimals of millions.
  await settings.getByRole('button', { name: 'Precision' }).click();
  await page
    .getByRole('listbox', { name: 'Precision' })
    .getByRole('option', { name: '3', exact: true })
    .click();
  await expect(value).toHaveText('20.123M');
  await settings.getByRole('checkbox', { name: 'Values in status line' }).uncheck();
  await expect(row(page, 'volume-1').locator('[data-plot]')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Ok' }).click();
});

test("RSI's gradient fills: green beyond 70 and red beyond 30, between the RSI and 50, as the built-in's code draws them", async ({
  page,
  market,
}) => {
  // A steady rise, then a sharper fall: RSI near the top, then near the bottom.
  const bars = makeBars(2_500);
  for (let i = bars.length - 40; i < bars.length; i++) {
    const before = bars[i - 1] as Bar;
    const close = before.close * (i < bars.length - 20 ? 1.01 : 0.97);
    bars[i] = {
      ...(bars[i] as Bar),
      open: before.close,
      high: Math.max(before.close, close),
      low: Math.min(before.close, close),
      close,
    };
  }
  market.bars = bars;
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  const [state] = await indicatorsOf(page);
  expect(state?.fills).toEqual([
    { id: 'background', gradient: false },
    { id: 'overbought', gradient: true },
    { id: 'oversold', gradient: true },
  ]);

  const [rsi] = rsiOver(await chartBars(page)) as [number[]];
  // The rally's last bar, and the bar before the last (a fill ends at the last bar's middle).
  const top = rsi.length - 21;
  const bottom = rsi.length - 2;
  const high = rsi[top] as number;
  const low = rsi[bottom] as number;
  expect(high).toBeGreaterThan(85);
  expect(low).toBeLessThan(15);
  const origin = await paneOrigin(page);
  const pointAt = async (index: number, value: number) => {
    const x = await chartCall<number>(page, 'barX', index);
    const y = await page.evaluate(
      ([price]) =>
        (
          window as unknown as {
            __tradingNerd: { chart: { indicatorPriceToY(id: string, p: number): number | null } };
          }
        ).__tradingNerd.chart.indicatorPriceToY('rsi-1', price as number),
      [value],
    );
    if (y === null) throw new Error(`No y for ${value}`);
    return { x: origin.x + x, y: origin.y + y };
  };
  // Just under the peak: green, about as strong as the RSI is far from 70 toward 100.
  const peak = await pointAt(top, high - 4);
  const [r1, g1, b1] = await colorAt(page, peak.x, peak.y);
  expect(g1 - r1).toBeGreaterThan(40);
  expect(g1 - b1).toBeGreaterThan(40);
  // Just over the trough: red.
  const trough = await pointAt(bottom, low + 3);
  const [r2, g2, b2] = await colorAt(page, trough.x, trough.y);
  expect(r2 - g2).toBeGreaterThan(40);
  expect(r2 - b2).toBeGreaterThan(30);

  // Each is a row of the Style tab, with its top and bottom colors; unticked, it's gone.
  const settings = await openSettings(page, 'rsi-1', 'RSI 14 close', 'Style');
  await expect(
    settings.getByRole('button', { name: /^Overbought Gradient Fill: top/ }),
  ).toBeVisible();
  await expect(
    settings.getByRole('button', { name: /^Overbought Gradient Fill: bottom/ }),
  ).toBeVisible();
  await settings.getByRole('checkbox', { name: 'Overbought Gradient Fill' }).uncheck();
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.fills.map((fill) => fill.id))
    .toEqual(['background', 'oversold']);
  const [r3, g3] = await colorAt(page, peak.x, peak.y);
  expect(g3 - r3).toBeLessThan(15);
  await settings.getByRole('button', { name: 'Cancel' }).click();
});

test('a formula: Volume reads n/a and draws nothing, and RSI is computed on its own bars', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Volume');
  await addIndicator(page, 'Relative Strength Index');
  await page.goto(`/?symbol=${encodeURIComponent('BINANCE:XRPUSDT*2')}&interval=1D`);
  await expect
    .poll(async () => (await chartState(page).catch(() => null))?.lastBar?.close ?? 0)
    .toBeCloseTo((market.bars.at(-1)?.close ?? 0) * 2, 6);
  const volume = row(page, 'volume-1');
  await expect(volume).toContainText('Vol · XRPUSDT*2');
  await expect(volume.locator('[data-plot="volume"]')).toHaveText('n/a');
  expect((await indicatorsOf(page))[0]?.plots[0]?.points).toBe(0);
  const shown = await latestRsi(page);
  await expect(row(page, 'rsi-1').locator('[data-plot="rsi"]')).toHaveText(shown);
  // XRP doubled rises and falls in the same proportions as XRP: the same RSI as XRP's own.
  const [xrp] = rsiOver(market.bars.slice(-1_000)) as [number[]];
  expect(shown).toBe((xrp.at(-1) as number).toFixed(2));
});

test('a tick chart: RSI and Volume over bars numbered by trade, a live trade moves them, and the first trades start them', async ({
  page,
  market,
}) => {
  await openChart(page, '/?interval=100T');
  await addIndicator(page, 'Relative Strength Index');
  await addIndicator(page, 'Volume');
  // The latest 1,000 of 1,500 tick bars: RSI waits its 294 bars, as on any history.
  const bars = await chartBars(page);
  expect(bars[0]?.time).toBe(FIRST_TICK_BAR + 500);
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.plots[0])
    .toMatchObject({ start: 294, points: 706 });
  const legend = row(page, 'rsi-1');
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText(await latestRsi(page));
  await expect(row(page, 'volume-1').locator('[data-plot="volume"]')).toHaveText('100');
  // A trade on the last tick bar.
  const last = bars.at(-1) as Bar;
  const traded = { ...last, close: last.close * 1.004, high: last.close * 1.004, volume: 101 };
  await market.sendBar(traded);
  const [after] = rsiOver([...bars.slice(0, -1), traded]) as [number[]];
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText((after.at(-1) as number).toFixed(2));
  await expect(row(page, 'volume-1').locator('[data-plot="volume"]')).toHaveText('101');
  // Scrolled back to the first trades: the oldest page vouches for the start, RSI from its 15th bar.
  for (let i = 0; i < 4 && (await chartState(page)).barCount < 1_500; i++) {
    await chartCall(page, 'scrollBars', -3_000);
    await settle(page);
  }
  await expect.poll(async () => (await chartState(page)).barCount).toBe(1_500);
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.plots[0])
    .toMatchObject({ start: 0, points: 1_500 - 14 });
});

test("a stock: RSI and Volume over its session's bars, computed again when extended hours come in", async ({
  page,
  market,
}) => {
  await page.clock.setFixedTime(STOCK_NOW);
  await openChart(page, '/?symbol=NASDAQ:AAPL&interval=5');
  await addIndicator(page, 'Relative Strength Index');
  await addIndicator(page, 'Volume');
  const legend = row(page, 'rsi-1');
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText(await latestRsi(page));
  const info = stockInfoFor('NASDAQ:AAPL');
  await expect(row(page, 'volume-1')).toContainText(`Vol · ${info?.base || info?.ticker}`);
  await expect(row(page, 'volume-1').locator('[data-plot="volume"]')).toHaveText('100K');

  // Extended trading hours: pre- and post-market bars join the chart, and RSI takes them in.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const chartSettings = page.getByRole('dialog', { name: 'Chart settings' });
  await chartSettings.getByRole('button', { name: 'Session' }).click();
  await page
    .getByRole('listbox', { name: 'Session' })
    .getByRole('option', { name: 'Extended trading hours' })
    .click();
  await chartSettings.getByRole('button', { name: 'Ok' }).click();
  await leaveChart(page);
  const extended = makeStockBars('5', 1_500, 'extended');
  await expect
    .poll(async () => (await chartState(page)).lastBar?.close)
    .toBe(extended.at(-1)?.close);
  expect(market.barRequests.at(-1)?.get('session')).toBe('extended');
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText(await latestRsi(page));
});

test('a reconnect refills the recent bars, and the indicators are computed again over them', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addIndicator(page, 'Relative Strength Index');
  await addIndicator(page, 'Volume');
  await market.subscribed('bars');
  const legend = row(page, 'rsi-1');
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText(await latestRsi(page));
  // While the link is down, today's bar moves on and tomorrow's opens.
  await market.drop();
  const last = market.bars.at(-1) as Bar;
  const moved = { ...last, close: 1.4, high: Math.max(last.high, 1.4), volume: 3e7 };
  const next = {
    time: last.time + DAY,
    open: 1.4,
    high: 1.41,
    low: 1.39,
    close: 1.405,
    volume: 1.5e6,
  };
  market.bars = [...market.bars.slice(0, -1), moved, next];
  await expect.poll(() => market.connections()).toBe(2);
  await expect.poll(async () => (await chartState(page)).lastBar?.time).toBe(next.time);
  const bars = await chartBars(page);
  expect(bars.at(-2)).toMatchObject({ close: 1.4, volume: 3e7 });
  await expect(legend.locator('[data-plot="rsi"]')).toHaveText(await latestRsi(page));
  await expect(row(page, 'volume-1').locator('[data-plot="volume"]')).toHaveText('1.5M');
  const [rsi] = await indicatorsOf(page);
  expect(rsi?.plots[0]?.points).toBe(bars.length - (rsi?.plots[0]?.start ?? 0));
});
