import type { Page } from '@playwright/test';
import { chartState, expect, LAST_DAY, openChart, test } from './fixtures';

/**
 * Alerts on scripts (Pine docs, Concepts, Alerts; Help Center, Manage alerts): the top bar's Alert
 * button opens the Create Alert dialog on a script on the chart; the alert runs on the chart's
 * symbol and timeframe, and a live bar that makes its script call alert() or meet its
 * alertcondition() pops up, plays, and goes in the Alerts panel's log.
 */

const editor = (page: Page) => page.getByTestId('pine-editor');
const dialog = (page: Page) => page.getByRole('dialog', { name: /alert on XRPUSDT/ });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Alerts panel' });
const toasts = (page: Page) =>
  page.getByRole('region', { name: 'Alert notifications' }).getByRole('status');

async function addScript(page: Page, source: string) {
  type CodeWindow = { __tradingNerd?: { code?: { set(text: string): void } } };
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Pine Editor' })
    .click();
  await expect(editor(page).locator('.monaco-editor')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as CodeWindow).__tradingNerd?.code !== undefined),
    )
    .toBe(true);
  await page.evaluate(
    (next) => (window as unknown as CodeWindow).__tradingNerd?.code?.set(next),
    source,
  );
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect.poll(async () => (await chartState(page)).indicators.length).toBeGreaterThan(0);
}

/** The live daily bar, at `close`. */
const live = (close: number) => ({
  time: LAST_DAY,
  open: 1.3115,
  high: Math.max(1.3226, close),
  low: 1.2902,
  close,
  volume: 2e7,
});

test('an alert on a script’s alert() calls pops up on a live bar, once per bar, and is logged', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addScript(
    page,
    [
      '//@version=6',
      'indicator("Breakout")',
      'if close > 2',
      '    alert("Close above 2: " + str.tostring(close))',
      'plot(close)',
      '',
    ].join('\n'),
  );
  await page.getByRole('banner').getByRole('button', { name: 'Alert', exact: true }).click();
  const create = dialog(page);
  await expect(create).toHaveAccessibleName('Create alert on XRPUSDT');
  await expect(create.getByRole('button', { name: 'Script' })).toHaveText('Breakout');
  await expect(create.getByRole('button', { name: 'Condition' })).toHaveText(
    'Any alert() function call',
  );
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(create).toBeHidden();

  // The Alerts panel lists it, active.
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Alerts' })
    .click();
  const row = panel(page).getByRole('listitem').filter({ hasText: 'Breakout' });
  await expect(row).toContainText('Breakout: Any alert() function call');
  await expect(row).toContainText('XRPUSDT, 1D');
  await expect(row).toContainText('Active');

  // A live bar above 2, once the alert's own stream is open: the alert() call triggers it.
  await expect.poll(() => market.streams('bars')).toBe(2);
  await market.sendBar(live(2.5));
  await expect(toasts(page)).toHaveCount(1);
  await expect(toasts(page).first()).toContainText('Alert on XRPUSDT');
  await expect(toasts(page).first()).toContainText('Close above 2: 2.5');
  // Once per bar (alert()'s default): the bar moving on doesn't trigger it again.
  await market.sendBar(live(2.6));
  await page.waitForTimeout(300);
  await expect(toasts(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Close notification' }).click();
  await expect(toasts(page)).toHaveCount(0);

  await panel(page).getByRole('tab', { name: 'Log' }).click();
  await expect(panel(page).getByRole('list', { name: 'Alert log' })).toContainText(
    'Close above 2: 2.5',
  );

  // Stopped, it doesn't trigger on the next bar.
  await panel(page).getByRole('tab', { name: 'Alerts' }).click();
  await row.hover();
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(row).toContainText('Stopped manually');
  await market.sendBar({ ...live(3), time: LAST_DAY + 86_400 });
  await page.waitForTimeout(300);
  await expect(toasts(page)).toHaveCount(0);
});

test('an "Only once" alertcondition() alert fills in its message and stops after triggering', async ({
  page,
  market,
}) => {
  await openChart(page);
  await addScript(
    page,
    [
      '//@version=6',
      'indicator("Levels")',
      'plot(close, "Close")',
      'alertcondition(close > 2, "Above 2", "{{ticker}} is above 2 at {{close}} ({{plot_0}})")',
      '',
    ].join('\n'),
  );
  await page.keyboard.press('Escape');
  await page.locator('main[aria-label="Chart"]').click();
  // Alt+A opens the dialog, as TradingView's shortcut.
  await page.keyboard.press('Alt+KeyA');
  const create = dialog(page);
  await expect(create.getByRole('button', { name: 'Condition' })).toHaveText('Above 2');
  await expect(create.getByLabel('Message')).toHaveValue(
    '{{ticker}} is above 2 at {{close}} ({{plot_0}})',
  );
  await expect(create.getByRole('button', { name: 'Trigger' })).toHaveText('Only once');
  await create.getByLabel('Alert name').fill('XRP over 2');
  await create.getByRole('button', { name: 'Create' }).click();

  await expect.poll(() => market.streams('bars')).toBe(2);
  await market.sendBar(live(2.25));
  await expect(toasts(page).first()).toContainText('XRPUSDT is above 2 at 2.25 (2.25)');
  await expect(toasts(page).first()).toContainText('XRP over 2');
  await page
    .getByRole('navigation', { name: 'Panels' })
    .getByRole('button', { name: 'Alerts' })
    .click();
  await expect(panel(page).getByRole('listitem').filter({ hasText: 'XRP over 2' })).toContainText(
    'Stopped — Triggered',
  );
});
