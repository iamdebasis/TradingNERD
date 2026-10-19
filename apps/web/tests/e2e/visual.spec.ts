import type { Page } from '@playwright/test';
import { expect, openChart, settle, test } from './fixtures';

/**
 * Visual regression (docs/SPEC.md §9): the main screens, against approved screenshots in
 * visual.spec.ts-snapshots/. A change meant to alter them updates them with
 * `pnpm exec playwright test visual --update-snapshots`; look at the new images before
 * committing them. Element shots are at the Retina scale the app is built for.
 */
const DEVICE = { scale: 'device' } as const;

const watchlist = (page: Page) => page.getByRole('complementary', { name: 'Watchlist' });
const chart = (page: Page) => page.getByRole('main', { name: 'Chart' });
const toolbar = (page: Page) => page.getByRole('banner');

async function openQuiet(page: Page) {
  await openChart(page);
  await page.mouse.move(2, 2); // nothing hovered
  await settle(page);
}

test('the chart page', async ({ page }) => {
  await openQuiet(page);
  await expect(page).toHaveScreenshot('chart-page.png');
});

test('the crosshair on a bar, the legend following it', async ({ page }) => {
  await openQuiet(page);
  const pane = await chart(page).boundingBox();
  if (!pane) throw new Error('no chart');
  await page.mouse.move(pane.x + 900, pane.y + 400);
  await settle(page);
  await expect(chart(page)).toHaveScreenshot('crosshair.png', DEVICE);
});

test('a watchlist row under the mouse', async ({ page }) => {
  await openQuiet(page);
  await watchlist(page).getByRole('button', { name: 'LINKUSDT', exact: true }).hover();
  await expect(watchlist(page)).toHaveScreenshot('watchlist-hover.png', DEVICE);
});

test("the watchlist's ⋯ menu", async ({ page }) => {
  await openQuiet(page);
  await watchlist(page).getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menu', { name: 'Watchlist options' })).toHaveScreenshot(
    'watchlist-menu.png',
    DEVICE,
  );
});

test('the interval menu', async ({ page }) => {
  await openQuiet(page);
  await toolbar(page).getByRole('button', { name: 'Interval menu', exact: true }).click();
  await page.mouse.move(2, 2);
  await expect(page.getByRole('region', { name: 'Interval menu' })).toHaveScreenshot(
    'interval-menu.png',
    DEVICE,
  );
});

test('the custom interval dialog', async ({ page }) => {
  await openQuiet(page);
  await toolbar(page).getByRole('button', { name: 'Interval menu', exact: true }).click();
  await page
    .getByRole('region', { name: 'Interval menu' })
    .getByRole('button', { name: 'Add custom interval…', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Add custom interval' })).toHaveScreenshot(
    'custom-interval.png',
    DEVICE,
  );
});

test('Add symbol: XRP on every exchange, one group opened', async ({ page }) => {
  await openQuiet(page);
  await watchlist(page).getByRole('button', { name: 'Add symbol' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add symbol' });
  await dialog.getByRole('combobox').fill('XRP');
  const xrp = dialog.locator('[role="option"][data-symbol="BINANCE:XRPUSDT"]');
  await xrp.getByRole('button', { name: /Show the exchanges/ }).click();
  await page.mouse.move(2, 2);
  await expect(dialog).toHaveScreenshot('add-symbol.png', DEVICE);
});

test('symbol search from the chart', async ({ page }) => {
  await openQuiet(page);
  await page.getByRole('button', { name: 'Symbol search: XRPUSDT' }).click();
  const dialog = page.getByRole('dialog', { name: 'Symbol search' });
  await expect(dialog.getByRole('option').first()).toBeVisible();
  await page.mouse.move(2, 2);
  await expect(dialog).toHaveScreenshot('symbol-search.png', DEVICE);
});

test('an exchange outage, in the legend', async ({ page, market }) => {
  await openQuiet(page);
  await market.sendBarsState('reconnecting');
  const legend = page.locator('[data-book]');
  await expect(legend).toHaveAttribute('data-status', 'reconnecting');
  await expect(legend).toHaveScreenshot('legend-reconnecting.png', DEVICE);
});

test('the coin logo prompt', async ({ page, market }) => {
  market.logoStatus = { ...market.logoStatus, promptDismissed: false };
  await openQuiet(page);
  await expect(page.getByRole('dialog', { name: 'Coin logos' })).toHaveScreenshot(
    'logo-prompt.png',
    DEVICE,
  );
});
