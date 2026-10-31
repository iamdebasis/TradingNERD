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
