import { expect, test } from '@playwright/test';

// Real Binance data through the real gateway. Opt-in: `pnpm test:e2e:live`.

test('real Binance data flows end to end', { tag: '@live' }, async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  await page.goto('/');
  const legend = page.locator('[data-book]');
  await expect(legend).toHaveAttribute('data-status', 'live', { timeout: 20_000 });
  await expect(page.locator('[data-field="title"]')).toHaveText('XRP / TetherUS · 1D · Binance');
  await expect(legend).toHaveAttribute('data-book', 'true', { timeout: 15_000 });

  const bid = Number(await page.locator('[data-field="bid"]').textContent());
  const ask = Number(await page.locator('[data-field="ask"]').textContent());
  expect(bid).toBeGreaterThan(0);
  expect(ask).toBeGreaterThanOrEqual(bid);

  type State = {
    barCount: number;
    lastBar: { time: number } | null;
    lastPriceLabel: { countdown: string | null } | null;
  };
  const state = await page.evaluate(() =>
    (
      window as unknown as { __tradingNerd: { chart: { debugState(): State } } }
    ).__tradingNerd.chart.debugState(),
  );
  const now = new Date();
  expect(state.barCount).toBe(1_000);
  expect(state.lastBar?.time).toBe(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );
  expect(state.lastPriceLabel?.countdown).toMatch(/^\d{2}:\d{2}(:\d{2})?$/);
  expect(problems).toEqual([]);
});

test('Add symbol finds XRP on every exchange, and a picked pair is live within a second', {
  tag: '@live',
}, async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  // Your real data/watchlist.json stays as it is: saves are answered here instead.
  await page.route(/\/api\/watchlist$/, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ json: route.request().postDataJSON() })
      : route.continue(),
  );

  await page.goto('/');
  const panel = page.getByRole('complementary', { name: 'Watchlist' });
  await expect(panel.locator('button[data-symbol]').first()).toBeVisible({ timeout: 15_000 });
  await panel.getByRole('button', { name: 'Add symbol' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add symbol' });
  await dialog.getByRole('combobox').fill('XRP');
  const xrp = dialog.locator('[role="option"][data-symbol="BINANCE:XRPUSDT"]');
  await expect(xrp).toBeVisible({ timeout: 15_000 });
  await xrp.getByRole('button', { name: /Show the exchanges/ }).click();
  await expect
    .poll(() =>
      dialog
        .getByRole('option')
        .evaluateAll((rows) =>
          rows
            .map((row) => row.getAttribute('data-symbol'))
            .filter((id) => id?.endsWith(':XRPUSDT')),
        ),
    )
    .toEqual([
      'BINANCE:XRPUSDT',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
  const exchanges = await dialog.getByRole('option').evaluateAll((rows) =>
    rows
      .map((row) => row.getAttribute('data-symbol') ?? '')
      .filter((id) => id.endsWith(':XRPUSDT'))
      .map((id) => id.split(':')[0])
      .sort(),
  );
  expect(exchanges).toEqual(['BINANCE', 'BYBIT', 'COINBASE', 'KRAKEN', 'OKX']);

  // A Binance pair that isn't in the list yet: live in its row within a second of the click.
  await dialog.getByRole('combobox').fill('XRPUSDC');
  const add = dialog
    .locator('[role="option"][data-symbol="BINANCE:XRPUSDC"]')
    .getByRole('button', { name: 'Add to watchlist' });
  await expect(add).toBeEnabled({ timeout: 15_000 });
  const started = Date.now();
  await add.click({ modifiers: ['Shift'] });
  await page.waitForFunction(
    () =>
      /\d\.\d/.test(
        document.querySelector('button[data-symbol="BINANCE:XRPUSDC"]')?.textContent ?? '',
      ),
    null,
    { polling: 'raf', timeout: 5_000 },
  );
  const elapsed = Date.now() - started;
  console.log(`XRPUSDC live ${elapsed} ms after the click`);
  expect(elapsed).toBeLessThan(1_000);
  expect(problems).toEqual([]);
});
