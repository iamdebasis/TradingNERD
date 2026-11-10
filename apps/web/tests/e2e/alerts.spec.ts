import type { Page } from '@playwright/test';
import { chartState, expect, LAST_DAY, NOW, openChart, test } from './fixtures';

/**
 * Alerts (Pine docs, Concepts, Alerts; Help Center, Manage alerts, How to use price alerts): the
 * top bar's Alert button opens the Create Alert dialog on the symbol's price, or on a script on
 * the chart. A price alert watches the symbol's live price; an alert on a script runs on the
 * chart's symbol and timeframe. When one triggers it pops up, plays, and goes in the Alerts
 * panel's log.
 */

const editor = (page: Page) => page.getByTestId('pine-editor');
const dialog = (page: Page) => page.getByRole('dialog', { name: /alert on XRPUSDT/ });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Alerts panel' });
const toasts = (page: Page) =>
  page.getByRole('region', { name: 'Alert notifications' }).getByRole('status');
const openPanel = (page: Page) =>
  page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Alerts' }).click();

/** Picks an option of one of the dialog's drop-downs (their lists open over the page). */
async function choose(page: Page, field: string, option: string) {
  await dialog(page).getByRole('button', { name: field }).click();
  await page.getByRole('listbox', { name: field }).getByRole('option', { name: option }).click();
  await expect(dialog(page).getByRole('button', { name: field })).toHaveText(option);
}

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
  // The dialog starts on the symbol's price; the chart's script is the next choice.
  await choose(page, 'Source', 'Breakout');
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
  await choose(page, 'Source', 'Levels');
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

/** XRPUSDT's 1-minute bar at `minute` past the fixed clock's (16:09), all at `close`. */
const minute = (n: number, close: number, high = close, low = close) => ({
  time: Date.parse('2026-10-18T16:09:00Z') / 1000 + n * 60,
  open: close,
  high,
  low,
  close,
  volume: 10,
});

test('a price alert starts at the current price, triggers when the live price crosses its value, and stops', async ({
  page,
  market,
}) => {
  await openChart(page);
  await page.getByRole('banner').getByRole('button', { name: 'Alert', exact: true }).click();
  const create = dialog(page);
  // TradingView's dialog starts on the symbol's price: Crossing, its current price, Only once.
  await expect(create.getByRole('button', { name: 'Source' })).toHaveText('XRPUSDT');
  await expect(create.getByRole('button', { name: 'Condition' })).toHaveText('Crossing');
  await expect(create.getByLabel('Value')).toHaveValue('1.2955');
  await expect(create.getByLabel('Message')).toHaveValue('XRPUSDT Crossing 1.2955');
  await choose(page, 'Trigger', 'Every time');
  await choose(page, 'Trigger', 'Only once');
  await choose(page, 'Condition', 'Crossing Up');
  await create.getByLabel('Value').fill('1.35');
  // The message follows the condition until it's typed in.
  await expect(create.getByLabel('Message')).toHaveValue('XRPUSDT Crossing Up 1.3500');
  await expect(create.getByLabel('Alert name')).toHaveAttribute(
    'placeholder',
    'XRPUSDT Crossing Up 1.3500',
  );
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(create).toBeHidden();

  await openPanel(page);
  const row = panel(page).getByRole('listitem').filter({ hasText: 'Crossing Up' });
  await expect(row).toContainText('XRPUSDT Crossing Up 1.3500');
  // A price alert has no timeframe: it triggers regardless of the interval.
  await expect(row).toContainText('XRPUSDT · Crossing Up 1.3500');
  await expect(row).toContainText('Active');

  // Below the value, then up through it within one update: the 1-minute bar's high shows it.
  await market.sendBarOn('BINANCE:XRPUSDT', '1', minute(1, 1.34));
  await page.waitForTimeout(200);
  await expect(toasts(page)).toHaveCount(0);
  await market.sendBarOn('BINANCE:XRPUSDT', '1', minute(1, 1.3492, 1.3521, 1.34));
  await expect(toasts(page)).toHaveCount(1);
  await expect(toasts(page).first()).toContainText('Alert on XRPUSDT');
  await expect(toasts(page).first()).toContainText('XRPUSDT Crossing Up 1.3500');
  // Only once: it stops, and its stream closes.
  await expect(row).toContainText('Stopped — Triggered');
  await expect.poll(() => market.streams('bars')).toBe(1);
  await panel(page).getByRole('tab', { name: 'Log' }).click();
  const log = panel(page).getByRole('list', { name: 'Alert log' });
  await expect(log).toContainText('XRPUSDT Crossing Up 1.3500');
  await expect(log.getByRole('listitem').first()).not.toContainText('1D');

  // Edited, its own message follows the new value, and it starts again.
  await panel(page).getByRole('tab', { name: 'Alerts' }).click();
  await row.hover();
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit alert on XRPUSDT' });
  await edit.getByLabel('Value').fill('1.36');
  await expect(edit.getByLabel('Message')).toHaveValue('XRPUSDT Crossing Up 1.3600');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('XRPUSDT Crossing Up 1.3600');
  await expect(row).toContainText('Active');
});

test('a Greater Than price alert, Every time, triggers again a minute on, and edits as a price alert', async ({
  page,
  market,
}) => {
  await openChart(page);
  await page.getByRole('banner').getByRole('button', { name: 'Alert', exact: true }).click();
  const create = dialog(page);
  await choose(page, 'Condition', 'Greater Than');
  // The fake gateway's 1-minute closes stay at or under 1.6: the price starts at or below it.
  await create.getByLabel('Value').fill('1.6');
  await choose(page, 'Trigger', 'Every time');
  await create.getByLabel('Message').fill('{{ticker}} above 1.6 at {{close}}');
  await create.getByRole('button', { name: 'Create' }).click();

  await market.sendBarOn('BINANCE:XRPUSDT', '1', minute(1, 1.61));
  await expect(toasts(page)).toHaveCount(1);
  await expect(toasts(page).first()).toContainText('XRPUSDT above 1.6 at 1.61');
  // Still above within the minute: not again yet.
  await market.sendBarOn('BINANCE:XRPUSDT', '1', minute(1, 1.62));
  await page.waitForTimeout(200);
  await expect(toasts(page)).toHaveCount(1);
  await page.clock.setFixedTime(NOW + 61_000);
  await market.sendBarOn('BINANCE:XRPUSDT', '1', minute(2, 1.63));
  await expect(toasts(page)).toHaveCount(2);
  await expect(toasts(page).last()).toContainText('XRPUSDT above 1.6 at 1.63');

  // Every time stays active; editing keeps it a price alert on its own symbol.
  await openPanel(page);
  const row = panel(page).getByRole('listitem').filter({ hasText: 'Greater Than' });
  await expect(row).toContainText('XRPUSDT Greater Than 1.6000');
  await expect(row).toContainText('Active');
  await row.hover();
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit alert on XRPUSDT' });
  await expect(edit.getByRole('button', { name: 'Condition' })).toHaveText('Greater Than');
  await expect(edit.getByLabel('Value')).toHaveValue('1.6000');
  await expect(edit.getByRole('button', { name: 'Trigger' })).toHaveText('Every time');
  await edit.getByLabel('Value').fill('1.7');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('XRPUSDT Greater Than 1.7000');
});
