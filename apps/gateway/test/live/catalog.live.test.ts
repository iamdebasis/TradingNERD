import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SymbolCatalog } from '../../src/catalog/SymbolCatalog.ts';
import type { CatalogSource } from '../../src/catalog/types.ts';
import { BinanceExchange } from '../../src/exchanges/binance/BinanceExchange.ts';
import { BybitExchange } from '../../src/exchanges/bybit/BybitExchange.ts';
import { CoinbaseExchange } from '../../src/exchanges/coinbase/CoinbaseExchange.ts';
import { KrakenExchange } from '../../src/exchanges/kraken/KrakenExchange.ts';
import { OkxExchange } from '../../src/exchanges/okx/OkxExchange.ts';

// Talks to the five exchanges' public APIs. Skipped unless LIVE=1 (`pnpm test:live`).
const LIVE = process.env.LIVE === '1';

describe.runIf(LIVE)('symbol catalog, live', () => {
  const binance = new BinanceExchange();
  const sources: CatalogSource[] = [
    binance,
    new BybitExchange(),
    new OkxExchange(),
    new CoinbaseExchange(),
    new KrakenExchange(),
  ];
  afterAll(() => binance.close());

  it.each(sources.map((source) => [source.name, source] as const))(
    '%s lists its trading spot pairs, XRPUSDT among them with a price and volume',
    async (_name, source) => {
      const { pairs } = await source.fetchCatalog();
      expect(pairs.length).toBeGreaterThan(300);
      const xrp = pairs.find((pair) => pair.ticker === 'XRPUSDT');
      expect(xrp).toMatchObject({ base: 'XRP', quote: 'USDT' });
      expect(xrp?.last).toBeGreaterThan(0);
      expect(xrp?.quoteVolume).toBeGreaterThan(0);
    },
  );

  it('typing XRP lists every exchange in one row, Binance first and live', async () => {
    const catalog = new SymbolCatalog({
      sources,
      live: new Set([binance.id]),
      dataDir: join(mkdtempSync(join(tmpdir(), 'tradingnerd-catalog-live-')), 'data'),
    });
    try {
      await catalog.start();
      await expect
        .poll(() => sources.every((source) => catalog.fetchedAt(source.id) !== null), {
          timeout: 30_000,
        })
        .toBe(true);
      const [first] = catalog.search({ query: 'XRP' }).matches;
      expect(first?.ticker).toBe('XRPUSDT');
      expect(first?.description).toBe('XRP / TetherUS');
      expect(new Set(first?.listings.map((listing) => listing.exchange))).toEqual(
        new Set(['BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'KRAKEN']),
      );
      expect(first?.listings[0]).toEqual({
        id: 'BINANCE:XRPUSDT',
        exchange: 'BINANCE',
        live: true,
      });
      // Kraken writes Bitcoin as XBT; it's still Bitcoin.
      const xbt = catalog.search({ query: 'kraken:xbtusd' }).matches[0];
      expect(xbt).toMatchObject({
        ticker: 'XBTUSD',
        base: 'BTC',
        description: 'Bitcoin / US Dollar',
      });
    } finally {
      catalog.close();
    }
  });
});
