import type { Bar } from '@tradingnerd/core';
import { afterAll, describe, expect, it } from 'vitest';
import { BinanceExchange } from '../../src/exchanges/binance/BinanceExchange.ts';
import { FINAL_AFTER_MS } from '../../src/market/historyCache.ts';
import { MarketService } from '../../src/market/MarketService.ts';

// The history cache against real Binance data. Skipped unless LIVE=1 (`pnpm test:live`).
const LIVE = process.env.LIVE === '1';
const SYMBOL = 'BINANCE:XRPUSDT';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(LIVE)('history cache, live', () => {
  const cached = new MarketService([new BinanceExchange()]);
  const fresh = new MarketService([new BinanceExchange()], { cacheHistory: false });
  afterAll(async () => {
    await cached.close();
    await fresh.close();
  });

  it.each([
    ['1S', 4_000],
    ['5S', 12_000],
  ])(
    'a %s page brought up to date matches one fetched afresh',
    async (interval, wait) => {
      await cached.getBars(SYMBOL, interval, null, 300);
      await sleep(wait); // new bars have opened since
      const updated = await cached.getBars(SYMBOL, interval, null, 300);
      const reference = await fresh.getBars(SYMBOL, interval, null, 300);
      // Bars that can no longer change, in the stretch both pages cover.
      const from = Math.max(updated.bars[0]?.time ?? 0, reference.bars[0]?.time ?? 0);
      const settled = (bars: Bar[]) =>
        bars.filter((bar) => bar.time >= from && bar.time * 1000 < Date.now() - FINAL_AFTER_MS * 2);
      expect(settled(updated.bars).length).toBeGreaterThan(200);
      expect(settled(updated.bars)).toEqual(settled(reference.bars));
      expect(updated.bars).toHaveLength(300);
    },
    30_000,
  );
});
