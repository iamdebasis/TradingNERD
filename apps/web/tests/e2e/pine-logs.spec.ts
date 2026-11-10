import type { Page } from '@playwright/test';
import { CODE_TOP, chartState, DAY, expect, LAST_DAY, openChart, test } from './fixtures';

/**
 * Pine Logs and the Pine Editor below the chart (docs/SPEC.md §5.19; Pine docs, Debugging: Pine
 * Logs, Figures 346 to 358; the user's screenshot of 31 October for Move script to bottom).
 * Checked through the page and the chart's state, so they run anywhere.
 */

const editor = (page: Page) => page.getByTestId('pine-editor');
const logsPane = (page: Page) => page.getByTestId('pine-logs');
const entries = (page: Page) => logsPane(page).getByTestId('pine-log');

/** The code the editor holds now, as the page keeps it. */
async function code(page: Page): Promise<string> {
  return page.evaluate(() => {
    const kept = JSON.parse(localStorage.getItem('tn.pine.editor') ?? 'null');
    return kept?.document?.text ?? '';
  });
}

/** Replaces the editor's code as one edit, as a paste does. */
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

async function openEditor(page: Page) {
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  // Monaco's first load, which the dev server compiles on first use, can take longer than the
  // usual 5 s while the whole suite runs.
  await expect(editor(page).locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
}

/** The manual's "Debug levels demo", a message on bar 500 and one on each live update. */
const DEMO = [
  '//@version=6',
  'indicator("Debug levels demo", overlay = true)',
  'if barstate.isfirst',
  '    log.info("This is an \'info\' message.")',
  '    log.warning("This is a \'warning\' message.")',
  '    log.error("This is an \'error\' message.")',
  'if bar_index == 500',
  '    log.info("Bar {0}", bar_index)',
  'if barstate.isrealtime',
  '    log.warning("Live {0}", close)',
  'plot(close)',
].join('\n');

/** A UTC timestamp as the pane writes it: UTC is -00:00 (Figure 348). */
const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().replace('Z', '-00:00');

async function addDemo(page: Page) {
  await openChart(page);
  await openEditor(page);
  await setCode(page, DEMO);
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await chartState(page)).indicators.length).toBe(1);
}

async function openLogs(page: Page) {
  await editor(page).getByRole('button', { name: 'More' }).click();
  await editor(page).getByRole('menuitem', { name: 'Pine Logs…' }).click();
  await expect(logsPane(page)).toBeVisible();
}

test('Pine Logs lists a script’s messages with their bars’ times, colored by level', async ({
  page,
  market,
}) => {
  await addDemo(page);
  await openLogs(page);
  await expect(logsPane(page).getByTestId('pine-logs-title')).toHaveText('Debug levels demo');
  // The chart's first bar is the script's bar 0; daily bars follow one a day.
  const first = (await chartState(page)).firstBarTime as number;
  const bar500 = first + 500 * DAY;
  await expect(entries(page)).toHaveText([
    `[${stamp(first)}]: This is an 'info' message.`,
    `[${stamp(first)}]: This is a 'warning' message.`,
    `[${stamp(first)}]: This is an 'error' message.`,
    `[${stamp(bar500)}]: Bar 500`,
    /^\[.*\]: Live /,
  ]);
  await expect(entries(page).nth(1)).toHaveAttribute('data-level', 'warning');
  await expect(entries(page).nth(2)).toHaveAttribute('data-level', 'error');

  // Logs don't roll back: each live update adds its own (Pine docs, Debugging).
  await market.sendBar({
    time: LAST_DAY,
    open: 1.3115,
    high: 1.3226,
    low: 1.2902,
    close: 1.32,
    volume: 2e7,
  });
  await expect(entries(page)).toHaveCount(6);
  await expect(entries(page).last()).toHaveText(/\]: Live 1\.32$/);

  // Pause keeps the list as it is until Resume.
  await logsPane(page).getByRole('button', { name: 'Pause' }).click();
  await market.sendBar({
    time: LAST_DAY,
    open: 1.3115,
    high: 1.3226,
    low: 1.2902,
    close: 1.33,
    volume: 2e7,
  });
  await expect.poll(async () => (await chartState(page)).lastBar?.close).toBe(1.33);
  await expect(entries(page)).toHaveCount(6);
  await logsPane(page).getByRole('button', { name: 'Resume' }).click();
  await expect(entries(page)).toHaveCount(7);
});

test('Pine Logs’ filters: levels, search with its options, and a start date', async ({ page }) => {
  await addDemo(page);
  await openLogs(page);
  await expect(entries(page)).toHaveCount(5);

  // Filter levels (Figure 358): errors only.
  await logsPane(page).getByRole('button', { name: 'Filter levels' }).click();
  const levels = logsPane(page).getByRole('menu', { name: 'Filter levels' });
  await levels.getByRole('checkbox', { name: 'Info' }).uncheck();
  await levels.getByRole('checkbox', { name: 'Warning' }).uncheck();
  await expect(entries(page)).toHaveText([/This is an 'error' message\.$/]);
  await levels.getByRole('checkbox', { name: 'Info' }).check();
  await levels.getByRole('checkbox', { name: 'Warning' }).check();
  await page.keyboard.press('Escape');

  // Search (Figure 353): matches in blue; Whole Word (Figure 354); a broken regex finds nothing.
  await logsPane(page).getByRole('button', { name: 'Search' }).click();
  const search = logsPane(page).getByRole('textbox', { name: 'Search logs' });
  await search.fill('message');
  await expect(entries(page)).toHaveCount(3);
  await expect(entries(page).first().locator('mark')).toHaveText('message');
  await search.fill('mess');
  await expect(entries(page)).toHaveCount(3);
  await logsPane(page).getByRole('button', { name: 'Search options' }).click();
  await logsPane(page).getByRole('checkbox', { name: 'Whole Word' }).check();
  await expect(entries(page)).toHaveCount(0);
  await expect(logsPane(page)).toContainText('No logs match');
  await logsPane(page).getByRole('checkbox', { name: 'Whole Word' }).uncheck();
  await logsPane(page).getByRole('checkbox', { name: 'Regex' }).check();
  await search.fill('Bar \\d+$');
  await expect(entries(page)).toHaveText([/Bar 500$/]);
  await logsPane(page).getByRole('button', { name: 'Clear search' }).click();
  await expect(entries(page)).toHaveCount(5);

  // Start date (Figures 356 and 357): from bar 500's day, as a tag above the entries.
  const bar500 = ((await chartState(page)).firstBarTime as number) + 500 * DAY;
  const day = new Date(bar500 * 1000).toISOString().slice(0, 10);
  await logsPane(page).getByRole('button', { name: 'Start date' }).click();
  const dialog = logsPane(page).getByRole('dialog', { name: 'Start date' });
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Time').fill('00:00');
  const date = new Date(bar500 * 1000);
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  await dialog
    .getByRole('button', {
      name: `Set ${month.slice(0, 3)} ${date.getUTCDate()}, 00:00`,
    })
    .click();
  await expect(logsPane(page).getByTestId('pine-logs-start')).toHaveText(
    `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()} at 00:00`,
  );
  await expect(entries(page)).toHaveText([/Bar 500$/, /Live /]);
  await logsPane(page).getByRole('button', { name: 'Clear start date' }).click();
  await expect(entries(page)).toHaveCount(5);
});

test('an entry’s Scroll to bar shows its bar, and Source code its line in the editor', async ({
  page,
}) => {
  await addDemo(page);
  await openLogs(page);
  // Scroll to bar (Figure 351): bar 500 comes to the middle, its time over it for a moment.
  await entries(page).nth(3).hover();
  await entries(page).nth(3).getByRole('button', { name: 'Scroll to bar' }).click();
  await expect
    .poll(async () => {
      const range = (await chartState(page)).logicalRange;
      return range ? Math.round((range.from + range.to) / 2) : null;
    })
    .toBe(500);
  await expect(page.getByRole('tooltip')).toBeVisible();

  // Source code (Figure 350): the editor shows the script with the log's line selected; on the
  // right it takes the logs' place.
  await entries(page).nth(2).hover();
  await entries(page).nth(2).getByRole('button', { name: 'Source code' }).click();
  await expect(logsPane(page)).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
  // The selection ends at the line's end, where the status bar's cursor stands.
  await expect(editor(page)).toContainText('Line 6, Col 45');
  // The cursor moved away and the code edited, the line isn't selected again: the cursor stays
  // where the edit leaves it.
  await page.keyboard.press(CODE_TOP);
  await expect(editor(page)).toContainText('Line 1, Col 1');
  await setCode(page, `${DEMO}\n`);
  await expect(editor(page)).toContainText(/Line (1|12), Col 1Pine/);
});

test('Move script to bottom puts the editor below the chart, beside the watchlist and Pine Logs', async ({
  page,
}) => {
  await addDemo(page);
  const chart = page.getByRole('main', { name: 'Chart' });
  const panel = page.getByRole('region', { name: 'Pine Editor panel' });
  await editor(page).getByTestId('pine-name').click();
  await editor(page).getByRole('menuitem', { name: 'Move script to bottom' }).click();
  await expect(editor(page)).toBeVisible();
  const chartBox = await chart.boundingBox();
  const editorBox = await editor(page).boundingBox();
  expect(editorBox?.y ?? 0).toBeGreaterThan((chartBox?.y ?? 0) + (chartBox?.height ?? 0) - 1);
  await expect(panel).toBeVisible();
  // The watchlist is back on the right, and both their buttons are lit.
  await expect(page.getByRole('complementary', { name: 'Watchlist' })).toBeVisible();
  const panels = page.getByRole('navigation', { name: 'Panels' });
  await expect(panels.getByRole('button', { name: 'Watchlist' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panels.getByRole('button', { name: 'Pine Editor' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Pine Logs opens on the right with the editor still below (as Figure 350).
  await openLogs(page);
  await expect(editor(page)).toBeVisible();
  await expect(entries(page)).toHaveCount(5);

  // Kept through a reload; Move script to right puts it back and takes the logs' place.
  await page.reload();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
  const again = await editor(page).boundingBox();
  const chartAgain = await chart.boundingBox();
  expect(again?.y ?? 0).toBeGreaterThan((chartAgain?.y ?? 0) + (chartAgain?.height ?? 0) - 1);
  await editor(page).getByTestId('pine-name').click();
  await editor(page).getByRole('menuitem', { name: 'Move script to right' }).click();
  const right = await editor(page).boundingBox();
  const chartRight = await chart.boundingBox();
  expect(right?.x ?? 0).toBeGreaterThan((chartRight?.x ?? 0) + (chartRight?.width ?? 0) - 1);
});
