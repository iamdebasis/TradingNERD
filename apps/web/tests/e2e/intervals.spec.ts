import type { Page } from '@playwright/test';
import { barOpenTime, parseResolution } from '@tradingnerd/core';
import {
  chartState,
  chartTimeLabel,
  expect,
  FIRST_TICK_BAR,
  NOW,
  openChart,
  test,
} from './fixtures';

/**
 * The top bar's interval controls (docs/SPEC.md §5.2): favorites, the interval menu, custom
 * intervals and the typed interval prompt, checked against the mock gateway.
 */
const toolbar = (page: Page) => page.getByRole('banner');
const favorites = (page: Page) => toolbar(page).getByRole('group', { name: 'Intervals' });
const menu = (page: Page) => page.getByRole('region', { name: 'Interval menu' });
const legendTitle = (page: Page) => page.getByText(/XRP \/ TetherUS · .+ · Binance/);

async function openMenu(page: Page) {
  await toolbar(page).getByRole('button', { name: 'Interval menu', exact: true }).click();
  await expect(menu(page)).toBeVisible();
}

/** The chart shows `interval` bars: the newest one opened at the bar boundary before NOW. */
async function expectChartOn(page: Page, interval: string) {
  const resolution = parseResolution(interval);
  if (!resolution) throw new Error(interval);
  const latest = barOpenTime(resolution, NOW) / 1000;
  await expect.poll(async () => (await chartState(page)).lastBar?.time).toBe(latest);
}

const labels = async (page: Page) =>
  (await favorites(page).getByRole('button').allInnerTexts()).filter((text) => text !== '');

test("the toolbar holds the user's favorite intervals, the daily one active", async ({ page }) => {
  await openChart(page);
  expect(await labels(page)).toEqual([
    '1m',
    '5m',
    '15m',
    '1h',
    '2h',
    '4h',
    '8h',
    '12h',
    'D',
    'W',
    'M',
    '6M',
    '12M',
  ]);
  await expect(favorites(page).getByRole('button', { name: 'D', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(toolbar(page).getByText('XRPUSDT')).toBeVisible();
});

test('a favorite switches the chart, the legend, the URL and the live feed', async ({
  page,
  market,
}) => {
  await openChart(page);
  const [daily] = market.barSubscriptions;
  await favorites(page).getByRole('button', { name: '15m', exact: true }).click();

  await expectChartOn(page, '15');
  await expect(legendTitle(page)).toHaveText('XRP / TetherUS · 15 · Binance');
  await expect(favorites(page).getByRole('button', { name: '15m', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(new URL(page.url()).searchParams.get('interval')).toBe('15');
  expect(market.barRequests.at(-1)?.get('resolution')).toBe('15');
  // The daily subscription was dropped for a 15-minute one.
  await expect.poll(() => market.barSubscriptions.at(-1)?.[1]).toBe('15');
  await expect.poll(() => market.activeSubscriptions()).not.toContain(daily?.[0]);
});

test('the menu lists every interval and switches to any of them', async ({ page }) => {
  await openChart(page);
  await openMenu(page);
  const headers = menu(page).locator('button[aria-expanded]');
  await expect(headers).toHaveText(['Ticks', 'Seconds', 'Minutes', 'Hours', 'Days']);
  await menu(page).getByRole('button', { name: '3 minutes', exact: true }).click();

  await expect(menu(page)).toHaveCount(0);
  await expectChartOn(page, '3');
  // Not a favorite, so it joins the toolbar only while it is the chart's interval.
  expect(await labels(page)).toEqual([
    '1m',
    '3m',
    '5m',
    '15m',
    '1h',
    '2h',
    '4h',
    '8h',
    '12h',
    'D',
    'W',
    'M',
    '6M',
    '12M',
  ]);
  await favorites(page).getByRole('button', { name: '1h', exact: true }).click();
  await expectChartOn(page, '60');
  expect(await labels(page)).not.toContain('3m');
});

test('stars add and remove favorites, and they stay after a reload', async ({ page }) => {
  await openChart(page);
  await openMenu(page);
  // A star shows when its row is hovered; favorites keep theirs.
  await menu(page).getByRole('button', { name: '3 minutes', exact: true }).hover();
  await menu(page).getByRole('button', { name: 'Favorite 3 minutes', exact: true }).click();
  await expect(
    menu(page).getByRole('button', { name: 'Favorite 3 minutes', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await menu(page).getByRole('button', { name: 'Favorite 12 months', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  expect(await labels(page)).toEqual([
    '1m',
    '3m',
    '5m',
    '15m',
    '1h',
    '2h',
    '4h',
    '8h',
    '12h',
    'D',
    'W',
    'M',
    '6M',
  ]);

  await openChart(page);
  expect(await labels(page)).toEqual([
    '1m',
    '3m',
    '5m',
    '15m',
    '1h',
    '2h',
    '4h',
    '8h',
    '12h',
    'D',
    'W',
    'M',
    '6M',
  ]);
});

test('sections fold away and stay folded', async ({ page }) => {
  await openChart(page);
  await openMenu(page);
  await menu(page).getByRole('button', { name: 'Ticks', exact: true }).click();
  await expect(menu(page).getByRole('button', { name: 'Ticks', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(menu(page).getByRole('button', { name: '10 ticks', exact: true })).toHaveCount(0);
  await page.mouse.click(400, 600); // a click outside closes the menu
  await expect(menu(page)).toHaveCount(0);

  await openChart(page);
  await openMenu(page);
  await expect(menu(page).getByRole('button', { name: '10 ticks', exact: true })).toHaveCount(0);
  await expect(menu(page).getByRole('button', { name: '5 seconds', exact: true })).toBeVisible();
});

test('a custom interval joins its section, opens on the chart, and can be removed', async ({
  page,
}) => {
  await openChart(page);
  await openMenu(page);
  await menu(page).getByRole('button', { name: 'Add custom interval…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add custom interval' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Interval').fill('0');
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await expect(dialog.getByText('Enter a whole number from 1 to 1440')).toBeVisible();
  await dialog.getByLabel('Interval').fill('7');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expectChartOn(page, '7');
  await expect(legendTitle(page)).toHaveText('XRP / TetherUS · 7 · Binance');
  await openMenu(page);
  await menu(page).getByRole('button', { name: '7 minutes', exact: true }).hover();
  await menu(page).getByRole('button', { name: 'Remove 7 minutes', exact: true }).click();
  await expect(menu(page).getByRole('button', { name: '7 minutes', exact: true })).toHaveCount(0);
});

test('typing a number on the chart opens the interval prompt', async ({ page }) => {
  await openChart(page);
  await page.keyboard.press('4');
  const prompt = page.getByRole('dialog', { name: 'Change interval' });
  await expect(prompt.getByLabel('Interval')).toHaveValue('4');
  await expect(prompt).toContainText('4 minutes');
  await page.keyboard.type('h');
  await expect(prompt).toContainText('4 hours');
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveCount(0);
  await expectChartOn(page, '240');
  expect(new URL(page.url()).searchParams.get('interval')).toBe('240');

  // Nonsense is refused, and Escape leaves the chart as it was.
  await page.keyboard.press('9');
  await page.keyboard.type('9x');
  await expect(prompt).toContainText('Not applicable');
  await page.keyboard.press('Enter');
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expectChartOn(page, '240');
});

test('the last interval comes back when the page opens without one', async ({ page }) => {
  await openChart(page);
  await favorites(page).getByRole('button', { name: '5m', exact: true }).click();
  await expectChartOn(page, '5');
  await openChart(page, '/');
  await expectChartOn(page, '5');
  await expect(favorites(page).getByRole('button', { name: '5m', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('toolbar and menu geometry match the reference', async ({ page }) => {
  await openChart(page);
  const box = async (locator: ReturnType<Page['locator']>) => {
    const value = await locator.boundingBox();
    if (!value) throw new Error('not visible');
    return value;
  };
  // docs/reference/02-toolbar.png: a 128 × 28 pill on the 4 px gutter, a 34 px active chip.
  expect(await box(toolbar(page).getByRole('button', { name: /^Symbol search/ }))).toEqual({
    x: 4,
    y: 5,
    width: 128,
    height: 28,
  });
  const chip = await box(favorites(page).getByRole('button', { name: 'D', exact: true }));
  expect(chip.y).toBe(2);
  expect(chip.height).toBe(34);

  // docs/reference/03-interval-menu.png: 195.5 wide, hung from the ⌄ button, rows of 32.
  await openMenu(page);
  const arrow = await box(
    toolbar(page).getByRole('button', { name: 'Interval menu', exact: true }),
  );
  const panel = await box(menu(page));
  expect(panel.width).toBe(195.5);
  expect(panel.x).toBe(arrow.x);
  // Taller than the 1000 px window, so it spans it.
  expect(panel.y).toBe(0);
  expect(panel.height).toBe(1000);
  const row = await box(menu(page).getByRole('button', { name: '10 ticks', exact: true }));
  expect(row.height).toBe(32);
  const header = await box(menu(page).getByRole('button', { name: 'Seconds', exact: true }));
  expect(header.height).toBe(24);
});

test('tick charts: bars numbered by trade, labelled with their trade times', async ({ page }) => {
  await openChart(page);
  await openMenu(page);
  await menu(page).getByRole('button', { name: '100 ticks', exact: true }).click();
  await expect(legendTitle(page)).toHaveText('XRP / TetherUS · 100T · Binance');
  const last = FIRST_TICK_BAR + 1_499;
  await expect.poll(async () => (await chartState(page)).lastBar?.time).toBe(last);
  expect(new URL(page.url()).searchParams.get('interval')).toBe('100T');
  // No countdown: tick bars close on a trade count, not on the clock.
  expect((await chartState(page)).lastPriceLabel?.countdown).toBeNull();
  // The crosshair shows when a bar's first trade happened: the mock's last one is NOW.
  expect(await chartTimeLabel(page, last)).toBe("Sun 18 Oct '26  16:09:54");
  expect(await chartTimeLabel(page, last - 100)).toBe("Sun 18 Oct '26  16:08:54");

  // Typing works for ticks too.
  await page.keyboard.press('1');
  await page.keyboard.type('0t');
  await page.keyboard.press('Enter');
  await expect(legendTitle(page)).toHaveText('XRP / TetherUS · 10T · Binance');
});
