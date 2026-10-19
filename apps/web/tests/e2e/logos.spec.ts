import type { Page } from '@playwright/test';
import { expect, MOCK_KEY, openChart, test } from './fixtures';

/**
 * Coin logos (docs/SPEC.md §5.5), against the mock gateway: the first-launch prompt, checking
 * a key, logos in the watchlist and legend, and the key never reaching the browser in full.
 */
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Coin logos' });
const row = (page: Page, ticker: string) =>
  page
    .getByRole('complementary', { name: 'Watchlist' })
    .getByRole('button', { name: ticker, exact: true });

test('asks for a key once at first launch; "Skip for now" means it', async ({ page, market }) => {
  market.logoStatus = { ...market.logoStatus, promptDismissed: false };
  await openChart(page);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('Data provided by CoinGecko');
  await expect(dialog(page).getByRole('link', { name: 'Get a free key ↗' })).toHaveAttribute(
    'href',
    'https://www.coingecko.com/en/developers/dashboard',
  );
  await dialog(page).getByRole('button', { name: 'Skip for now' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(market.logoStatus.promptDismissed).toBe(true);
  await openChart(page);
  await page.waitForTimeout(300);
  await expect(dialog(page)).toHaveCount(0);
});

test('checks the key: a rejected one says so, a good one turns logos on', async ({
  page,
  market,
  consoleGuard,
}) => {
  consoleGuard.allow(/status of 400/); // the rejected key's answer
  market.logoStatus = { ...market.logoStatus, promptDismissed: false };
  await openChart(page);
  // No key, no logos: letter avatars.
  await expect(row(page, 'LINKUSDT').locator('img')).toHaveCount(0);

  const key = dialog(page).getByLabel('API key');
  await key.fill('CG-wrong-key-0000');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toContainText('CoinGecko rejected this key');

  await key.fill(MOCK_KEY);
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toContainText('✓ Key works · Demo plan');
  await expect(dialog(page)).toContainText('••••3f9a · Demo plan');
  await dialog(page).getByRole('button', { name: 'Done' }).click();

  await expect(row(page, 'LINKUSDT').locator('img')).toBeVisible();
  await expect(page.locator('[data-book] img').first()).toBeVisible(); // the legend's XRP logo
  // A coin without a logo keeps its letter.
  await expect(row(page, 'BATUSDT')).toContainText('B');
  await expect(row(page, 'BATUSDT').locator('img')).toBeHidden();
});

test('the ⋯ menu shows the key masked, with Replace and Remove', async ({ page, market }) => {
  market.logoStatus = {
    ...market.logoStatus,
    key: { masked: '••••3f9a', plan: 'demo', source: 'file' },
    syncedAt: Date.now(),
  };
  await openChart(page);
  await page
    .getByRole('complementary', { name: 'Watchlist' })
    .getByRole('button', { name: 'More' })
    .click();
  // CoinGecko's attribution, as in the dialog.
  await expect(page.getByRole('menu', { name: 'Watchlist options' })).toContainText(
    'Data provided by CoinGecko',
  );
  await page.getByRole('menuitem', { name: 'Coin logos (CoinGecko)…' }).click();
  await expect(dialog(page)).toContainText('API key ••••3f9a · Demo plan');
  await dialog(page).getByRole('button', { name: 'Remove' }).click();
  await expect(dialog(page).getByLabel('API key')).toBeVisible();
  expect(market.logoStatus.key).toBeNull();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('the key is never kept in the browser', async ({ page, market }) => {
  market.logoStatus = { ...market.logoStatus, promptDismissed: false };
  await openChart(page);
  await dialog(page).getByLabel('API key').fill(MOCK_KEY);
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toContainText('✓ Key works');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('CG-demo-key');
  await expect(page.locator('body')).not.toContainText('CG-demo-key');
  expect(market.savedKeys).toEqual([MOCK_KEY]);
});
