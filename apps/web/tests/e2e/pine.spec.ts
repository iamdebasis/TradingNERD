import type { Page } from '@playwright/test';
import { RSI_PINE } from '@tradingnerd/indicators';
import { chartState, expect, NOW, openChart, test } from './fixtures';

/**
 * The Pine Editor (docs/SPEC.md §5.16, milestone P1): the right toolbar, a built-in's code
 * editable at once with the original kept, Reset to original, Add to chart and Update on
 * chart, Save as one of My scripts with versions, drafts kept through a reload, and My scripts
 * in the Indicators dialog. Checked through the page and the chart's state, so they run
 * anywhere; the editor's look is checked against TradingView's screenshots on the Mac.
 */

const editor = (page: Page) => page.getByTestId('pine-editor');
const indicatorsDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Indicators, metrics, and strategies' });
const row = (page: Page, id: string) => page.locator(`[data-indicator="${id}"]`);
const indicatorsOf = async (page: Page) => (await chartState(page)).indicators;

/** The code the editor holds now, as the page keeps it. */
async function code(page: Page): Promise<string> {
  return page.evaluate(() => {
    const kept = JSON.parse(localStorage.getItem('tn.pine.editor') ?? 'null');
    return kept?.document?.text ?? '';
  });
}

/**
 * Replaces the editor's code as one edit, as a paste does (typing it would add Monaco's own
 * indenting to the code's): Undo takes it back.
 */
async function setCode(page: Page, text: string) {
  type CodeWindow = { __tradingNerd?: { code?: { set(text: string): void } } };
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as CodeWindow).__tradingNerd?.code !== undefined),
    )
    .toBe(true);
  await page.evaluate(
    (next) => (window as unknown as CodeWindow).__tradingNerd?.code?.set(next),
    text,
  );
  await expect.poll(() => code(page)).toBe(text);
}

async function addRsi(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Indicators', exact: true }).click();
  await indicatorsDialog(page).getByRole('option', { name: 'Relative Strength Index' }).click();
  await indicatorsDialog(page).getByRole('button', { name: 'Close' }).click();
  await expect.poll(async () => (await indicatorsOf(page)).length).toBe(1);
}

/** Opens RSI's code from its legend row's Source code button ({ }). */
async function openRsiCode(page: Page) {
  await row(page, 'rsi-1').hover();
  await row(page, 'rsi-1').getByRole('button', { name: 'Source code' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
}

test('the right toolbar opens the Pine Editor in place of the watchlist, and back', async ({
  page,
}) => {
  await openChart(page);
  const watchlist = page.getByRole('complementary', { name: 'Watchlist' });
  const panels = page.getByRole('navigation', { name: 'Panels' });
  await expect(watchlist).toBeVisible();
  await expect(panels.getByRole('button', { name: 'Watchlist' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panels.getByRole('button', { name: 'Pine Editor' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(watchlist).toBeHidden();
  // With nothing open it starts a new indicator, as TradingView's does.
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/Untitled script/);
  await expect(editor(page)).toContainText('Pine Script® v6');
  await panels.getByRole('button', { name: 'Watchlist' }).click();
  await expect(watchlist).toBeVisible();
  await expect(editor(page)).toBeHidden();
  // A click on the lit button closes its panel: the chart takes the room.
  const before = (await chartState(page)).width;
  await panels.getByRole('button', { name: 'Watchlist' }).click();
  await expect(watchlist).toBeHidden();
  await expect.poll(async () => (await chartState(page)).width).toBeGreaterThan(before);
});

test("the legend's Source code opens RSI's code, editable at once, its original kept", async ({
  page,
}) => {
  await openChart(page);
  await addRsi(page);
  await openRsiCode(page);
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/Relative Strength Index/);
  await expect(editor(page).getByTestId('pine-banner')).toContainText(
    'Built-in script. Your edits make a copy; the original stays as it is.',
  );
  expect(await code(page)).toBe(RSI_PINE);
  // Edited at once: Reset to original appears, and puts the built-in's code back.
  const edited = RSI_PINE.replace('input.int(14, "RSI Length"', 'input.int(21, "RSI Length"');
  await setCode(page, edited);
  const reset = editor(page).getByRole('button', { name: 'Reset to original' });
  await expect(reset).toBeVisible();
  await reset.click();
  await expect.poll(() => code(page)).toBe(RSI_PINE);
  await expect(reset).toBeHidden();
  // Reset is an edit: Undo brings the change back.
  await editor(page).locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => code(page)).toBe(edited);
});

test('Add to chart puts the copy beside the built-in, with the same values; Update on chart changes it', async ({
  page,
}) => {
  await openChart(page);
  await addRsi(page);
  await openRsiCode(page);
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect
    .poll(async () => (await indicatorsOf(page)).map((item) => item.kind))
    .toEqual(['rsi', 'script']);
  const [builtin, copy] = await indicatorsOf(page);
  expect(copy).toMatchObject({ pane: 2, levels: 3, error: null });
  expect(copy?.plots.map((plot) => plot.id)).toEqual(['plot_0', 'plot_1']);
  expect(builtin?.pane).toBe(1);
  // The copy's RSI and its average read as the built-in's, digit for digit.
  await page.mouse.move(1, 1);
  const legendValue = (id: string, plot: string) => row(page, id).locator(`[data-plot="${plot}"]`);
  await expect(legendValue('script-1', 'plot_0')).toHaveText(
    await legendValue('rsi-1', 'rsi').innerText(),
  );
  await expect(legendValue('script-1', 'plot_1')).toHaveText(
    await legendValue('rsi-1', 'ma').innerText(),
  );
  await expect(row(page, 'script-1')).toContainText('RSI 14 close');
  // More edits: the button now updates the copy on the chart, not a third one.
  await setCode(page, RSI_PINE.replace('input.int(14, "RSI Length"', 'input.int(21, "RSI Length"'));
  const update = editor(page).getByRole('button', { name: 'Update on chart' });
  await expect(update).toBeVisible();
  await update.click();
  await expect(row(page, 'script-1')).toContainText('RSI 21 close');
  expect((await indicatorsOf(page)).map((item) => item.kind)).toEqual(['rsi', 'script']);
});

test('code with an error stays off the chart; the console says where, and a click goes there', async ({
  page,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(page, '//@version=6\nindicator("Broken")\nplot(nothing)\n');
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  const console = editor(page).getByTestId('pine-console');
  await expect(console).toContainText('Error at 3:6 Undeclared identifier "nothing"');
  expect(await indicatorsOf(page)).toEqual([]);
  // The error's count shows on the console's button.
  await expect(editor(page).getByRole('button', { name: 'Pine console' })).toContainText('1');
  await console.getByRole('button', { name: /Error at 3:6/ }).click();
  await expect(editor(page)).toContainText('Line 3, Col 6');
});

test('Save asks for a name, keeps the copy as one of My scripts, and saves versions after', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addRsi(page);
  await openRsiCode(page);
  const edited = RSI_PINE.replace('"RSI Length", minval = 1', '"RSI Length", minval = 2');
  await setCode(page, edited);
  await editor(page).getByRole('button', { name: 'Save script' }).click();
  const save = page.getByRole('dialog', { name: 'Save script' });
  await expect(save.getByRole('textbox', { name: 'Script name' })).toHaveValue(
    'Relative Strength Index',
  );
  await save.getByRole('textbox', { name: 'Script name' }).fill('My RSI');
  await save.getByRole('button', { name: 'Save' }).click();
  await expect(save).toBeHidden();
  expect(market.scriptSaves).toEqual([
    { method: 'POST', body: { name: 'My RSI', source: edited, from: 'rsi' } },
  ]);
  // Now one of My scripts: its name, no banner, and its version in the status bar.
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/My RSI/);
  await expect(editor(page).getByTestId('pine-banner')).toBeHidden();
  await expect(editor(page).getByTestId('pine-version')).toHaveText(/^1 · Oct 1[89], \d\d:\d\d$/);
  // Ctrl/Cmd + S saves the next version straight away.
  await setCode(page, `${edited}// tuned\n`);
  // From inside the code, as TradingView's editor takes it.
  await editor(page).locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(editor(page).getByTestId('pine-version')).toHaveText(/^2 · /);
  expect(market.scriptSaves.map((item) => item.method)).toEqual(['POST', 'PUT']);
  expect(market.scripts[0]?.versions.map((item) => item.version)).toEqual([1, 2]);
  // The built-in's own code is as it was.
  await row(page, 'rsi-1').hover();
  await row(page, 'rsi-1').getByRole('button', { name: 'Source code' }).click();
  await expect.poll(() => code(page)).toBe(RSI_PINE);
});

test('unsaved code is kept through a reload, as TradingView keeps it', async ({ page }) => {
  await openChart(page);
  await addRsi(page);
  await openRsiCode(page);
  const edited = RSI_PINE.replace('"RSI Length"', '"Length of RSI"');
  await setCode(page, edited);
  await page.reload();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  expect(await code(page)).toBe(edited);
  await expect(editor(page).getByRole('button', { name: 'Reset to original' })).toBeVisible();
});

test('My scripts lists the saved scripts in the Indicators dialog, and a click adds one to the chart', async ({
  page,
  market,
}) => {
  market.scripts = [
    {
      id: 's-1',
      name: 'Fast average',
      from: null,
      versions: [
        {
          version: 1,
          savedAt: NOW,
          source:
            '//@version=6\nindicator("Fast average", overlay = true)\nplot(ta.ema(close, 9), color = color.orange)\n',
        },
      ],
    },
  ];
  await openChart(page);
  await page.getByRole('banner').getByRole('button', { name: 'Indicators', exact: true }).click();
  await indicatorsDialog(page).getByRole('button', { name: 'My scripts' }).click();
  await expect(indicatorsDialog(page).getByRole('option')).toHaveText(['Fast average']);
  await indicatorsDialog(page).getByRole('option', { name: 'Fast average' }).click();
  await expect(indicatorsDialog(page).getByText('Fast average added to the chart')).toBeVisible();
  await indicatorsDialog(page).getByRole('button', { name: 'Close' }).click();
  // An overlay: on the price pane, its row in the main legend.
  await expect.poll(async () => (await indicatorsOf(page))[0]?.pane).toBe(0);
  const [average] = await indicatorsOf(page);
  expect(average?.kind).toBe('script');
  expect(average?.plots[0]?.points).toBeGreaterThan(0);
  await expect(page.locator('[data-field="indicators"]')).toContainText('Fast average');
  // Its code opens from the legend as the saved script it is.
  await row(page, average?.id ?? '').hover();
  await row(page, average?.id ?? '')
    .getByRole('button', { name: 'Source code' })
    .click();
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/Fast average/);
  await expect(editor(page).getByTestId('pine-version')).toHaveText(/^1 · /);
});

test('a script that stops on a runtime error draws nothing and says why in its legend row', async ({
  page,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(
    page,
    '//@version=6\nindicator("Stops")\nif bar_index == 5\n    runtime.error("Stopped on purpose")\nplot(close)\n',
  );
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await indicatorsOf(page))[0]?.error).toBe('Stopped on purpose');
  expect((await indicatorsOf(page))[0]?.plots[0]?.points).toBe(0);
  await expect(
    row(page, 'script-1').getByRole('img', { name: 'Error: Stopped on purpose' }),
  ).toBeVisible();
});

test('plotshape, plotarrow, plotcandle and barcolor draw as TradingView draws them', async ({
  page,
  market,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(
    page,
    [
      '//@version=6',
      'indicator("Marks", overlay = true)',
      'plotshape(close > open, "Up", shape.triangleup, location.belowbar, color.teal, text = "Up")',
      'plotarrow(close - open, "Body")',
      'plotcandle(open, high, low, close, "Copy", color.orange)',
      'barcolor(close > open ? color.yellow : na)',
      '',
    ].join('\n'),
  );
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  // Shapes and arrows on the bars in view, over clear series that carry them on the scale.
  await expect.poll(async () => (await indicatorsOf(page))[0]?.plots[0]?.marks).toBeGreaterThan(0);
  await expect.poll(async () => (await indicatorsOf(page))[0]?.plots[1]?.marks).toBeGreaterThan(0);
  const state = await chartState(page);
  const [shapes, arrows, candles] = state.indicators[0]?.plots ?? [];
  expect([shapes?.type, arrows?.type, candles?.type]).toEqual(['Line', 'Line', 'Candlestick']);
  // A candle on every bar; the high, low and close aren't plots of their own.
  expect(state.indicators[0]?.plots).toHaveLength(3);
  expect(candles?.points).toBe(state.barCount);

  // barcolor(): the up bars' bodies are yellow, the others the chart's own.
  const bars = market.bars.slice(-state.barCount);
  const ups = bars.flatMap((bar, index) => (bar.close > bar.open ? [index] : []));
  expect(state.barColors.map((bar) => bar.index)).toEqual(ups);
  expect(new Set(state.barColors.map((bar) => bar.color))).toEqual(new Set(['#FDD835']));

  // The legend writes the candles' open, high, low and close, all in their color.
  const legend = row(page, 'script-1');
  const last = bars.at(-1) as (typeof bars)[number];
  const parts = ['plot_2', 'plot_3', 'plot_4', 'plot_5'];
  const texts = await Promise.all(
    parts.map((id) => legend.locator(`[data-plot="${id}"]`).textContent()),
  );
  expect(texts.map((text) => Number(text))).toEqual(
    [last.open, last.high, last.low, last.close].map((value) => Number(value.toFixed(4))),
  );
  for (const id of parts) {
    await expect(legend.locator(`[data-plot="${id}"]`)).toHaveCSS('color', 'rgb(255, 152, 0)');
  }

  // The Style tab lists each output once; turning Bar color off gives the bars their colors back.
  await legend.getByRole('button', { name: 'Marks', exact: true }).dblclick();
  const settings = page.getByRole('dialog', { name: 'Marks' });
  await settings.getByRole('tab', { name: 'Style' }).click();
  for (const title of ['Up', 'Body', 'Copy', 'Bar color']) {
    await expect(settings.getByRole('checkbox', { name: title, exact: true })).toBeVisible();
  }
  await settings.getByRole('checkbox', { name: 'Bar color', exact: true }).uncheck();
  await expect.poll(async () => (await chartState(page)).barColors).toEqual([]);
  await settings.getByRole('button', { name: 'Ok' }).click();
});

test('labels, lines, boxes and tables draw on the chart, the latest kept as the bars update', async ({
  page,
  market,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(
    page,
    [
      '//@version=6',
      'indicator("Drawings", overlay = true)',
      'var table t = table.new(position.top_right, 2, 1, bgcolor = color.new(color.navy, 20))',
      'if barstate.islast',
      '    table.cell(t, 0, 0, "Close", text_color = color.white)',
      '    table.cell(t, 1, 0, str.tostring(close), text_color = color.white)',
      '    label.new(bar_index, high, "Last")',
      '    line.new(bar_index - 20, low, bar_index, high, extend = extend.right, color = color.orange)',
      '    box.new(bar_index - 10, high, bar_index - 5, low, bgcolor = color.new(color.teal, 80))',
      'l = label.new(bar_index, low, "every bar", yloc = yloc.belowbar, style = label.style_none)',
      '',
    ].join('\n'),
  );
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await indicatorsOf(page))[0]?.drawings.tables).toBe(1);
  const [view] = await indicatorsOf(page);
  expect(view?.error).toBeNull();
  // One label per bar, the last 50 kept (Pine docs, Limitations), and the last bar's own.
  expect(view?.drawings).toMatchObject({ labels: 50, lines: 1, boxes: 1, tables: 1 });
  const last = market.bars.at(-1) as (typeof market.bars)[number];
  expect(view?.drawings.texts).toEqual(
    expect.arrayContaining(['Last', 'Close', String(Number(last.close.toFixed(4)))]),
  );
  // Painted, not only kept: at their bars and prices on the candles' scale. A script with no
  // plot draws on a series without values, which places no price on its own.
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.drawings.painted)
    .toMatchObject({ lines: 1, boxes: 1, tables: 1 });
  expect((await indicatorsOf(page))[0]?.drawings.painted.labels).toBeGreaterThan(10);
});

test('a strategy’s fills are marked on the chart and listed in the Strategy Tester', async ({
  page,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(
    page,
    [
      '//@version=6',
      'strategy("MA Cross", overlay = true)',
      'fast = ta.sma(close, 9)',
      'slow = ta.sma(close, 21)',
      'if ta.crossover(fast, slow)',
      '    strategy.entry("Long", strategy.long)',
      'if ta.crossunder(fast, slow)',
      '    strategy.entry("Short", strategy.short)',
      'plot(fast)',
      '',
    ].join('\n'),
  );
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  // Adding a strategy opens the Strategy Tester, as on TradingView.
  const tester = page.getByTestId('strategy-tester');
  await expect(tester).toBeVisible();
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.trades?.fills ?? 0)
    .toBeGreaterThan(1);
  const trades = (await indicatorsOf(page))[0]?.trades;
  expect(trades?.closed).toBeGreaterThan(0);
  // Marked on the candles where they fall in view.
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.trades?.painted ?? 0)
    .toBeGreaterThan(0);
  await expect(tester.getByText('Net Profit', { exact: true })).toBeVisible();
  await tester.getByRole('tab', { name: 'List of Trades' }).click();
  await expect(tester.locator('tr[data-trade]')).toHaveCount(
    (trades?.closed ?? 0) + (trades?.open ?? 0),
  );
  await tester.getByRole('tab', { name: 'Performance Summary' }).click();
  await expect(tester.getByRole('rowheader', { name: 'Profit Factor' })).toBeVisible();
  // Close, then the right toolbar's button brings it back.
  await tester.getByRole('button', { name: 'Close' }).click();
  await expect(tester).toBeHidden();
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Strategy Tester' })
    .click();
  await expect(page.getByTestId('strategy-tester')).toBeVisible();
});

test('a plotcandle is drawn from where its open, high, low and close have all settled', async ({
  page,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  // The close is an average still settling on the first bars loaded; the open isn't.
  await setCode(
    page,
    [
      '//@version=6',
      'indicator("Smoothed", overlay = true)',
      'c = ta.ema(close, 50)',
      'plotcandle(open, high, low, c, "Smoothed")',
      'plot(c, "EMA")',
      '',
    ].join('\n'),
  );
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await indicatorsOf(page))[0]?.plots.length).toBe(2);
  const state = await chartState(page);
  const [candles, ema] = state.indicators[0]?.plots ?? [];
  expect(ema?.start).toBeGreaterThan(0);
  expect(candles?.start).toBe(ema?.start);
  expect(candles?.points).toBe(state.barCount - (candles?.start ?? 0));
});

test('a script that stops takes its bar colors off the chart', async ({ page, market }) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(
    page,
    [
      '//@version=6',
      'indicator("Colors", overlay = true)',
      'barcolor(color.yellow)',
      'if volume == 25000000',
      '    runtime.error("Stopped live")',
      'plot(close)',
      '',
    ].join('\n'),
  );
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await chartState(page)).barColors.length).toBeGreaterThan(0);
  // A live tick stops it: every bar takes the chart's own colors back.
  const last = market.bars.at(-1) as (typeof market.bars)[number];
  await market.sendBar({ ...last, volume: 2.5e7 });
  await expect.poll(async () => (await indicatorsOf(page))[0]?.error).toBe('Stopped live');
  await expect.poll(async () => (await chartState(page)).barColors).toEqual([]);
});

/** A library of our own, as the user would paste one from its TradingView page. */
const HLM_LIBRARY = [
  '//@version=5',
  '// @description Highs, lows and their middle.',
  'library("lib_hlm")',
  '// @function The middle of a high and a low.',
  'export hl2(float h, float l) => (h + l) / 2',
  '',
].join('\n');

/** A script importing it as the user's Ichimoku does (JollyWizard/lib_hlm/1 as hlm). */
const USES_HLM = [
  '//@version=5',
  'indicator("Middle", overlay = true)',
  'import JollyWizard/lib_hlm/1 as hlm',
  'plot(hlm.hl2(high, low), "Middle")',
  '',
].join('\n');

test('a missing library: "Add library…" in the console takes its code, and the script runs', async ({
  page,
  market,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(page, USES_HLM);
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  // Kept off the chart; the console says which library, and offers to add it.
  const console = page.getByTestId('pine-console');
  await expect(console).toContainText('Could not find library "JollyWizard/lib_hlm/1"');
  expect(await indicatorsOf(page)).toEqual([]);
  await console.getByRole('button', { name: 'Add library…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Libraries' });
  await expect(dialog.getByRole('textbox', { name: 'Import path' })).toHaveValue(
    'JollyWizard/lib_hlm/1',
  );
  // Code that isn't a library is refused, with the reason.
  await dialog.getByRole('textbox', { name: /^Code/ }).fill(USES_HLM);
  await dialog.getByRole('button', { name: 'Add library' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Line 3: Could not find library');
  await dialog.getByRole('textbox', { name: /^Code/ }).fill(HLM_LIBRARY);
  await dialog.getByRole('button', { name: 'Add library' }).click();
  await expect(dialog.getByRole('list', { name: 'My libraries' })).toContainText(
    'JollyWizard/lib_hlm/1',
  );
  expect(market.libraryChanges).toEqual([
    { method: 'PUT', path: 'JollyWizard/lib_hlm/1', source: HLM_LIBRARY },
  ]);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(console).toContainText('No errors');

  // On the chart, the library's function gives the script's values.
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await indicatorsOf(page))[0]?.error).toBeNull();
  const last = market.bars.at(-1) as (typeof market.bars)[number];
  const middle = row(page, 'script-1').locator('[data-plot="plot_0"]');
  await expect(middle).toHaveText(((last.high + last.low) / 2).toFixed(4));

  // After a reload, the library comes from the gateway again and the script still runs.
  await page.reload();
  await expect(row(page, 'script-1').locator('[data-plot="plot_0"]')).toHaveText(
    ((last.high + last.low) / 2).toFixed(4),
  );
  expect((await indicatorsOf(page))[0]?.error).toBeNull();
});

test('removing a library brings back its import’s error, on the chart too', async ({
  page,
  market,
}) => {
  market.libraries = [
    { publisher: 'JollyWizard', name: 'lib_hlm', version: 1, source: HLM_LIBRARY, addedAt: NOW },
  ];
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await setCode(page, USES_HLM);
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await indicatorsOf(page))[0]?.error).toBeNull();
  // The script's menu: Create new → Library, and My libraries.
  await page.getByTestId('pine-name').click();
  await page.getByRole('menuitem', { name: /^Create new/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Library', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'My libraries…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Libraries' });
  await dialog.getByRole('button', { name: 'Remove JollyWizard/lib_hlm/1' }).click();
  await expect(dialog.getByRole('list', { name: 'My libraries' })).toContainText(
    'No libraries yet',
  );
  expect(market.libraryChanges).toEqual([{ method: 'DELETE', path: 'JollyWizard/lib_hlm/1' }]);
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.error)
    .toMatch(/^Could not find library "JollyWizard\/lib_hlm\/1"/);
  // It stays where it was, in the price pane's legend, saying why it draws nothing.
  expect((await indicatorsOf(page))[0]?.pane).toBe(0);
  await expect(
    row(page, 'script-1').getByRole('img', { name: /^Error: Could not find library/ }),
  ).toBeVisible();
});

const RSI_14 = '//@version=6\nindicator("My RSI")\nplot(ta.rsi(close, 14))\n';
const RSI_21 = '//@version=6\nindicator("My RSI")\nplot(ta.rsi(close, 21))\n';

test('the script menu as TradingView’s: Open script, Version history, Rename, Make a copy, Recently used', async ({
  page,
  market,
}) => {
  market.scripts = [
    {
      id: 's-100',
      name: 'My RSI',
      from: 'rsi',
      versions: [
        { version: 1, savedAt: NOW - 86_400_000, source: RSI_14 },
        { version: 2, savedAt: NOW, source: RSI_21 },
      ],
    },
  ];
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  const menu = async (name: string | RegExp) => {
    await editor(page).getByTestId('pine-name').click();
    await page.getByRole('menuitem', { name }).click();
  };
  // A new script has nothing to copy, rename or look back on yet.
  await editor(page).getByTestId('pine-name').click();
  await expect(page.getByRole('menuitem', { name: 'Version history…' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Open script…: found by name.
  await menu('Open script…');
  const open = page.getByRole('dialog', { name: 'Open script' });
  await open.getByRole('textbox', { name: 'Search' }).fill('my r');
  await expect(open.getByRole('list', { name: 'Built-in scripts' })).toContainText(
    'No built-in by that name',
  );
  await open.getByRole('button', { name: /^My RSI/ }).click();
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/My RSI/);

  // Version history…: newest first; the picked version beside the one before it.
  await menu('Version history…');
  const history = page.getByRole('dialog', { name: /^Version history/ });
  const versions = history.getByRole('list', { name: 'Versions' });
  await expect(versions.getByRole('button', { pressed: true })).toContainText(
    'Version 2 · current',
  );
  await expect(history.getByTestId('version-diff').locator('.monaco-diff-editor')).toBeVisible();
  await expect(history.getByTestId('version-diff')).toContainText('ta.rsi(close, 21)');
  await history.getByRole('button', { name: 'Inline' }).click();
  await expect(history.getByRole('button', { name: 'Inline' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Found by its date.
  const older = new Date(NOW - 86_400_000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  await history.getByRole('textbox', { name: 'Search by date and time' }).fill(older);
  await expect(versions.getByRole('button', { name: /Version/ })).toHaveCount(1);
  // Add version to chart: version 1 in a pane of its own; the current stays.
  await history.getByRole('button', { name: 'More for version 1' }).click();
  await history.getByRole('menuitem', { name: 'Add version to chart' }).click();
  await expect(versions).toContainText('added to the chart');
  await expect.poll(async () => (await indicatorsOf(page)).length).toBe(1);
  expect((await indicatorsOf(page))[0]?.pane).toBe(1);
  await history.getByRole('button', { name: 'Close' }).click();

  // Rename…, then Make a copy… (which opens the copy).
  await menu('Rename…');
  const rename = page.getByRole('dialog', { name: 'Rename script' });
  await rename.getByRole('textbox').fill('Faster RSI');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/Faster RSI/);
  expect(market.scriptRenames).toEqual(['Faster RSI']);
  await menu('Make a copy…');
  const copy = page.getByRole('dialog', { name: 'Make a copy' });
  await copy.getByRole('textbox').fill('RSI copy');
  await copy.getByRole('button', { name: 'Make a copy' }).click();
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/RSI copy/);
  expect(market.scriptSaves.at(-1)).toMatchObject({
    method: 'POST',
    body: { name: 'RSI copy', source: RSI_21, from: 'rsi' },
  });

  // Recently used: the latest first; a click opens it again.
  await editor(page).getByTestId('pine-name').click();
  const recent = page.getByRole('menu').getByRole('menuitem', { name: 'Faster RSI' });
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(editor(page).getByTestId('pine-name')).toHaveText(/Faster RSI/);
});

test('Convert code to v6 rewrites v5 code with the guide’s fixes, and Undo brings it back', async ({
  page,
}) => {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  const v5 = [
    '//@version=5',
    'indicator("Old script")',
    'up = close > open ? 1 : 0',
    'plot(up ? close : open, color = color.teal, transp = 50)',
  ].join('\n');
  await setCode(page, v5);
  // The v5 annotation is marked, as TradingView's editor marks it.
  await expect(editor(page).locator('[class*="versionToConvert"]')).toHaveText('//@version=5');
  await editor(page).getByTestId('pine-name').click();
  await editor(page).getByRole('menuitem', { name: 'Convert code to v6' }).click();
  await expect
    .poll(() => code(page))
    .toBe(
      [
        '//@version=6',
        'indicator("Old script")',
        'up = close > open ? 1 : 0',
        'plot(bool(up) ? close : open, color = color.new(color.teal, 50))',
      ].join('\n'),
    );
  await expect(editor(page).locator('[class*="versionToConvert"]')).toHaveCount(0);
  // v6 code has nothing to convert.
  await editor(page).getByTestId('pine-name').click();
  await expect(editor(page).getByRole('menuitem', { name: 'Convert code to v6' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await editor(page).getByRole('textbox', { name: 'Pine Script code' }).focus();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => code(page)).toBe(v5);
  // v5 code that doesn't compile can't be converted.
  await setCode(page, v5.replace('close > open', 'nope'));
  await editor(page).getByTestId('pine-name').click();
  await expect(editor(page).getByRole('menuitem', { name: 'Convert code to v6' })).toBeDisabled();
});

test.describe('typing in the editor', () => {
  // The pinned clock's performance.now breaks Monaco's own typing-latency marks; typing needs
  // the real one (the fixture's realClock).
  test.use({ realClock: true });

  test('help while typing: suggestions, a function’s parameters, hover help and color swatches', async ({
    page,
  }) => {
    await openChart(page);
    await page
      .getByRole('navigation', { name: 'Panels' })
      .getByRole('button', { name: 'Pine Editor' })
      .click();
    await expect(editor(page).locator('.monaco-editor')).toBeVisible();
    await setCode(
      page,
      '//@version=6\nindicator("Help")\nplot(close, color = color.new(color.red, 50))',
    );
    // A swatch beside the color.
    await expect(editor(page).locator('.colorpicker-color-decoration')).toHaveCount(1);
    // Suggestions after a namespace's dot: the engine's own ta.* functions.
    // Monaco takes keys through the browser's EditContext, on its code text box.
    await editor(page).getByRole('textbox', { name: 'Pine Script code' }).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('x = ta.sm');
    // Typed into the code, not the chart: letters there open symbol search (and Shift+W the
    // watchlist's lists), but not from the editor.
    await expect(page.getByRole('combobox', { name: /^Symbol/ })).toHaveCount(0);
    const suggest = editor(page).locator('.suggest-widget');
    await expect(suggest).toBeVisible();
    await expect(suggest.getByRole('option', { name: /^sma/ })).toBeVisible();
    await page.keyboard.press('Escape');
    // Inside the parentheses: its parameters, as the engine reads them.
    await page.keyboard.type('a(close, ');
    await expect(editor(page).locator('.parameter-hints-widget')).toContainText(
      'ta.sma(source, length)',
    );
    await page.keyboard.press('Escape');
    // Hover help at the cursor (Ctrl+K Ctrl+I): the signature and TradingView's reference.
    // Into "sma" of "x = ta.sma(close, ": eight characters in.
    await page.keyboard.press('Home');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+I');
    const hover = page.locator('.monaco-hover');
    await expect(hover).toContainText('ta.sma(source, length)');
    await expect(hover.getByRole('link', { name: 'Reference' })).toHaveAttribute(
      'href',
      /pine-script-reference\/v6\/#fun_ta\.sma$/,
    );
  });
});
