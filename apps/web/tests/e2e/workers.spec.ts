import type { Page } from '@playwright/test';
import { chartState, expect, openChart, test } from './fixtures';

/**
 * Pine scripts in workers of their own (docs/SPEC.md §6.23): the page never waits on a script, a
 * script let go stops its worker at once, and a script whose look alone changed isn't calculated
 * again. The real workers run here, in the browser, as they do in the app.
 */

const row = (page: Page, id: string) => page.locator(`[data-indicator="${id}"]`);
const indicatorsOf = async (page: Page) => (await chartState(page)).indicators;

/** Loops on every bar: seconds of work for the engine over the chart's 1,000 bars. */
const HEAVY = [
  '//@version=6',
  'indicator("Heavy")',
  'float s = 0.0',
  'for i = 0 to 4000',
  '    s += math.sin(i * close)',
  'plot(s, "Sum")',
  'plot(close, "Close")',
  '',
].join('\n');

/**
 * The chart opens with this script on it (none for null), and the page counts its workers, the
 * Pine Editor's own among them, and its long tasks.
 */
async function withScript(page: Page, source: string | null): Promise<void> {
  await page.addInitScript((code) => {
    if (code !== null) {
      const list = [
        { id: 'script-1', kind: 'script', hidden: false, settings: {}, script: { source: code } },
      ];
      localStorage.setItem(
        'tn.chart.indicators',
        JSON.stringify({ version: 2, list, folded: false }),
      );
    }
    const w = window as unknown as {
      __long: number[];
      __workers: { made: number; stopped: number };
    };
    w.__long = [];
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) w.__long.push(entry.duration);
    }).observe({ type: 'longtask' });
    w.__workers = { made: 0, stopped: 0 };
    const Original = window.Worker;
    window.Worker = class extends Original {
      private readonly script: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.script = options?.name === 'Pine script';
        if (this.script) w.__workers.made++;
      }
      override terminate(): void {
        if (this.script) w.__workers.stopped++;
        super.terminate();
      }
    };
  }, source);
}

/** The script workers made and stopped (the Pine Editor's Monaco worker aside). */
const workers = (page: Page) =>
  page.evaluate(() => (window as unknown as { __workers: unknown }).__workers);

/** Replaces the editor's code as one edit, as a paste does (pine.spec.ts). */
async function setCode(page: Page, text: string): Promise<void> {
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
}

/** The page's long tasks (50 ms or more) since the last call, in ms. */
const longTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0));

test('a heavy script calculates in a worker of its own: the page never waits on it', async ({
  page,
}) => {
  await withScript(page, null);
  await openChart(page);
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await setCode(page, HEAVY);
  // From the click on: in the page, the whole calculation was one long task of seconds.
  await longTasks(page);
  await page.getByTestId('pine-editor').getByRole('button', { name: 'Add to chart' }).click();
  // While it calculates its row shows the loading ring where its values go.
  await expect(row(page, 'script-1').getByRole('status', { name: 'Loading' })).toBeVisible();
  expect((await indicatorsOf(page))[0]?.calculating).toBe(true);
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.plots[0]?.points, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(row(page, 'script-1').getByRole('status', { name: 'Loading' })).toHaveCount(0);
  // Seconds of the engine's work, and no task of the page's of 200 ms or more meanwhile.
  expect(Math.max(0, ...(await longTasks(page)))).toBeLessThan(200);
  expect(await workers(page)).toEqual({ made: 1, stopped: 0 });
});

test('removing a script while it calculates stops its worker at once', async ({ page }) => {
  await withScript(page, HEAVY);
  await openChart(page);
  await expect.poll(() => workers(page)).toEqual({ made: 1, stopped: 0 });
  expect((await indicatorsOf(page))[0]?.calculating).toBe(true);
  await row(page, 'script-1').hover();
  await row(page, 'script-1').getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => workers(page)).toEqual({ made: 1, stopped: 1 });
  expect(await indicatorsOf(page)).toEqual([]);
});

test('a script whose look alone changes keeps its run: it isn’t calculated again', async ({
  page,
}) => {
  const light = [
    '//@version=6',
    'indicator("Two lines")',
    'plot(close, "First")',
    'plot(open, "Second")',
    '',
  ].join('\n');
  await withScript(page, light);
  await openChart(page);
  await expect.poll(async () => (await indicatorsOf(page))[0]?.calculating).toBe(false);
  // The Style tab hides the second line: the first is drawn again at once, from the same run.
  await row(page, 'script-1').getByRole('button', { name: 'Two lines', exact: true }).dblclick();
  const settings = page.getByRole('dialog', { name: 'Two lines' });
  await settings.getByRole('tab', { name: 'Style' }).click();
  await settings.getByRole('checkbox', { name: 'Second', exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Ok' }).click();
  await expect
    .poll(async () => (await indicatorsOf(page))[0]?.plots.map((p) => p.id))
    .toEqual(['plot_0']);
  const [script] = await indicatorsOf(page);
  expect(script?.calculating).toBe(false);
  expect(script?.plots[0]?.points).toBeGreaterThan(0);
  expect(await workers(page)).toEqual({ made: 1, stopped: 0 });
});
