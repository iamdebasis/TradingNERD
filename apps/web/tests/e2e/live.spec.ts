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
