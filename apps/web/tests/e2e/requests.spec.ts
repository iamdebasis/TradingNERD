import type { Page } from '@playwright/test';
import { chartState, expect, openChart, test } from './fixtures';

/**
 * Scripts' requests (docs/SPEC.md §6.18, milestone P4): request.security()'s data from the
 * gateway as the chart's own, a script waiting for it drawing nothing (a ring in its legend row),
 * a symbol that doesn't exist said so in its row, input.symbol picked with Symbol Search, and
 * indicator(timeframe =)'s two inputs. Checked through the page and the chart's state, so they
 * run anywhere.
 */

const editor = (page: Page) => page.getByTestId('pine-editor');
const row = (page: Page, id: string) => page.locator(`[data-indicator="${id}"]`);
const indicatorsOf = async (page: Page) => (await chartState(page)).indicators;
const pointsOf = async (page: Page) => (await indicatorsOf(page))[0]?.plots[0]?.points ?? 0;

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

async function addScript(page: Page, text: string) {
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  // Monaco's first load, which the dev server compiles on first use, can take a while.
  await expect(editor(page).locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
  await setCode(page, text);
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await indicatorsOf(page)).length).toBe(1);
}

test("a script asking for another symbol's days waits for them, then draws them", async ({
  page,
  market,
}) => {
  // The other symbol's history holds on until the test lets it through.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/bars\?.*symbol=BINANCE%3AETHUSDT/, async (route) => {
    await held;
    await route.fallback();
  });
  await addScript(
    page,
    '//@version=6\nindicator("Other")\nplot(request.security("BINANCE:ETHUSDT", "D", close))\n',
  );
  // Waiting: nothing drawn, a ring where its values go.
  await expect(row(page, 'script-1').getByRole('status', { name: 'Loading' })).toBeVisible();
  expect(await pointsOf(page)).toBe(0);
  release();
  await expect.poll(() => pointsOf(page)).toBeGreaterThan(0);
  await expect(row(page, 'script-1').getByRole('status', { name: 'Loading' })).toHaveCount(0);
  expect((await indicatorsOf(page))[0]?.error).toBeNull();
  // Its data came as the chart's: a page of history, then the live bars.
  expect(
    market.barRequests.some(
      (query) => query.get('symbol') === 'BINANCE:ETHUSDT' && query.get('resolution') === '1D',
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      market.barSymbols.some(([id, resolution]) => id === 'BINANCE:ETHUSDT' && resolution === '1D'),
    )
    .toBe(true);
});

test("a symbol that doesn't exist stops the script, and its row says why", async ({
  page,
  consoleGuard,
}) => {
  consoleGuard.allow(/status of 404/); // the symbol the gateway doesn't know
  await addScript(
    page,
    '//@version=6\nindicator("Nope")\nplot(request.security("NOPE:NOPE", "D", close))\n',
  );
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.error)
    .toBe('Invalid symbol "NOPE:NOPE"');
  await expect(
    row(page, 'script-1').getByRole('img', { name: 'Error: Invalid symbol "NOPE:NOPE"' }),
  ).toBeVisible();
  expect(await pointsOf(page)).toBe(0);
});

test('input.symbol is picked with Symbol Search, and the script asks for that symbol', async ({
  page,
  market,
}) => {
  await addScript(
    page,
    '//@version=6\nindicator("Pick")\ns = input.symbol("BINANCE:ETHUSDT", "Symbol")\nplot(request.security(s, "D", close))\n',
  );
  await expect.poll(() => pointsOf(page)).toBeGreaterThan(0);
  await row(page, 'script-1').getByRole('button').first().dblclick();
  const settings = page.getByRole('dialog', { name: 'Pick' });
  await settings.getByRole('tab', { name: 'Inputs' }).click();
  const field = settings.getByLabel('Symbol');
  await expect(field).toHaveText('BINANCE:ETHUSDT');
  await field.click();
  const search = page.getByRole('dialog', { name: 'Symbol search' });
  await expect(search).toBeVisible();
  await search.getByRole('combobox').fill('LDO');
  await expect(search.locator('[role="option"][data-symbol="BINANCE:LDOUSDT"]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(search).toHaveCount(0);
  await expect(field).toHaveText('BINANCE:LDOUSDT');
  await settings.getByRole('button', { name: 'Ok' }).click();
  await expect
    .poll(() => market.barRequests.some((query) => query.get('symbol') === 'BINANCE:LDOUSDT'))
    .toBe(true);
  await expect.poll(() => pointsOf(page)).toBeGreaterThan(0);
});

test('timeframe = runs a script on that timeframe, with the Calculation section’s two inputs', async ({
  page,
  market,
}) => {
  await addScript(page, '//@version=6\nindicator("Weekly", timeframe = "1W")\nplot(close)\n');
  await expect.poll(() => pointsOf(page)).toBeGreaterThan(0);
  expect(
    market.barRequests.some(
      (query) => query.get('symbol') === 'BINANCE:XRPUSDT' && query.get('resolution') === '1W',
    ),
  ).toBe(true);
  // Waiting for the weeks' closes: a value once a week on the daily chart.
  const daily = (await chartState(page)).barCount;
  expect(await pointsOf(page)).toBeLessThan(daily / 5);
  await row(page, 'script-1').getByRole('button').first().dblclick();
  const settings = page.getByRole('dialog', { name: 'Weekly' });
  await settings.getByRole('tab', { name: 'Inputs' }).click();
  await expect(settings.getByText('Calculation')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Timeframe' })).toContainText('1 week');
  await expect(settings.getByRole('checkbox', { name: 'Wait for timeframe closes' })).toBeChecked();
  // Unticked, the gaps fill with the latest week's value.
  await settings.getByRole('checkbox', { name: 'Wait for timeframe closes' }).uncheck();
  await settings.getByRole('button', { name: 'Ok' }).click();
  await expect.poll(() => pointsOf(page)).toBeGreaterThan(daily / 2);
});
