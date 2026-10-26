import type { Page } from '@playwright/test';
import { expect, MOCK_LCW_KEY, openChart, test } from './fixtures';

/**
 * CRYPTOCAP's older market caps (docs/SPEC.md §5.13): the Live Coin Watch key, asked for from
 * the watchlist's ⋯ menu, checked by the gateway and only ever shown masked; the download's
 * progress; and Live Coin Watch's credit once its data is in.
 */

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Older market caps' });
const more = (page: Page) =>
  page.getByRole('complementary', { name: 'Watchlist' }).getByRole('button', { name: 'More' });

async function openFromMenu(page: Page) {
  await more(page).click();
  await page.getByRole('menuitem', { name: 'Older market caps (Live Coin Watch)…' }).click();
  await expect(dialog(page)).toBeVisible();
}

test("the ⋯ menu takes a Live Coin Watch key, checked and masked, and shows the download's progress", async ({
  page,
  market,
  consoleGuard,
}) => {
  consoleGuard.allow(/status of 400/); // the gateway's "rejected this key"
  await openChart(page);
  await more(page).click();
  // Until its data is in, only CoinGecko is credited.
  const options = page.getByRole('menu', { name: 'Watchlist options' });
  await expect(options).toContainText('Data provided by CoinGecko');
  await expect(options).not.toContainText('and Live Coin Watch');
  await page.getByRole('menuitem', { name: 'Older market caps (Live Coin Watch)…' }).click();
  await expect(dialog(page)).toContainText('reach back to May 2013');
  await expect(dialog(page).getByRole('link', { name: 'Get a free key ↗' })).toHaveAttribute(
    'href',
    'https://www.livecoinwatch.com/tools/api',
  );
  await expect(dialog(page)).toContainText('Market data by Live Coin Watch');

  await dialog(page).getByLabel('API key').fill('nope');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toContainText('Live Coin Watch rejected this key');

  await dialog(page).getByLabel('API key').fill(` ${MOCK_LCW_KEY} `);
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).toContainText('API key ••••6789');
  await expect(dialog(page)).toContainText('Downloading… 0%');
  expect(market.savedLcwKeys.at(-1)).toBe(` ${MOCK_LCW_KEY} `);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(MOCK_LCW_KEY);

  // The download goes back from our first day: how far it got, and what it waits for. Each
  // coin's history, a few days' download of its own, runs beside it, on a line of its own.
  market.olderCaps = {
    ...market.olderCaps,
    progress: 0.42,
    from: '2020-08-14',
    until: '2025-10-29',
    coins: {
      state: 'loading',
      progress: 0.125,
      message: 'Finding which coins counted, month by month: 1,200 of at most 9,000 coins',
    },
  };
  await expect(dialog(page)).toContainText('Downloading… 42% · back to 14 Aug 2020');
  await expect(dialog(page)).toContainText(
    "Each coin's history: Finding which coins counted, month by month: 1,200 of at most 9,000 coins · 12%",
  );
  market.olderCaps = {
    ...market.olderCaps,
    message: "Waiting for Live Coin Watch's requests to renew at 00:00 UTC",
  };
  await expect(dialog(page)).toContainText(
    "Waiting for Live Coin Watch's requests to renew at 00:00 UTC · 42%",
  );
  market.olderCaps = {
    ...market.olderCaps,
    state: 'done',
    progress: 1,
    from: '2013-05-01',
    message: null,
  };
  await expect(dialog(page)).toContainText('✓ Daily from 1 May 2013');
  market.olderCaps = {
    ...market.olderCaps,
    coins: { state: 'done', progress: 1, message: null },
  };
  await expect(dialog(page)).toContainText("✓ Each coin's history is in");
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(dialog(page)).toHaveCount(0);

  // Its data in, Live Coin Watch is credited beside CoinGecko.
  await more(page).click();
  await expect(page.getByRole('menu', { name: 'Watchlist options' })).toContainText(
    'Data provided by CoinGecko and Live Coin Watch',
  );
});

test('Remove forgets the key and keeps what came in; a key from the environment stays', async ({
  page,
  market,
}) => {
  market.olderCaps = {
    key: { masked: '••••6789', source: 'file' },
    state: 'done',
    progress: 1,
    from: '2013-05-01',
    until: '2025-10-29',
    message: null,
    coins: { state: 'none', progress: 0, message: null },
  };
  await openChart(page);
  await openFromMenu(page);
  await expect(dialog(page)).toContainText('API key ••••6789');
  await dialog(page).getByRole('button', { name: 'Remove' }).click();
  await expect(dialog(page).getByLabel('API key')).toBeVisible();
  await expect(dialog(page)).toContainText('✓ Daily from 1 May 2013');
  expect(market.olderCaps.key).toBeNull();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  market.olderCaps = { ...market.olderCaps, key: { masked: '••••6789', source: 'env' } };
  await openFromMenu(page);
  await expect(dialog(page)).toContainText('Set by LIVECOINWATCH_API_KEY');
  await expect(dialog(page).getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(dialog(page).getByRole('button', { name: 'Replace' })).toHaveCount(0);
});

test('a download that stopped says why, in red', async ({ page, market }) => {
  market.olderCaps = {
    key: { masked: '••••6789', source: 'file' },
    state: 'error',
    progress: 0.1,
    from: '2024-06-02',
    until: '2025-10-29',
    message: 'Live Coin Watch rejected the key',
    coins: { state: 'error', progress: 0.1, message: 'Live Coin Watch rejected the key' },
  };
  await openChart(page);
  await openFromMenu(page);
  const status = dialog(page).locator('[aria-live="polite"]').first();
  const coins = dialog(page).locator('[aria-live="polite"]').nth(1);
  await expect(status).toHaveText('Live Coin Watch rejected the key');
  await expect(status).toHaveAttribute('data-kind', 'error');
  await expect(coins).toHaveText("Each coin's history: Live Coin Watch rejected the key");
  await expect(coins).toHaveAttribute('data-kind', 'error');
});
