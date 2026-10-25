import { type Bar, barOpenTime, parseResolution } from '@tradingnerd/core';
import { afterAll, describe, expect, it } from 'vitest';
import { BitstampExchange } from '../../src/exchanges/bitstamp/BitstampExchange.ts';
import { BybitExchange } from '../../src/exchanges/bybit/BybitExchange.ts';
import { CoinbaseExchange } from '../../src/exchanges/coinbase/CoinbaseExchange.ts';
import { KrakenExchange } from '../../src/exchanges/kraken/KrakenExchange.ts';
import { OkxExchange } from '../../src/exchanges/okx/OkxExchange.ts';
import { MarketService } from '../../src/market/MarketService.ts';
import type { ExchangeAdapter } from '../../src/market/types.ts';

// Talks to Bybit, OKX, Coinbase, Kraken and Bitstamp. Skipped unless LIVE=1 (`pnpm test:live`).
const LIVE = process.env.LIVE === '1';

const CASES: { name: string; adapter: () => ExchangeAdapter; symbol: string; built: string[] }[] = [
  // Intervals each exchange doesn't serve itself, built here from a smaller one.
  { name: 'Bybit', adapter: () => new BybitExchange(), symbol: 'BYBIT:XRPUSDT', built: ['45'] },
  { name: 'OKX', adapter: () => new OkxExchange(), symbol: 'OKX:XRPUSDT', built: ['10', '5S'] },
  {
    name: 'Coinbase',
    adapter: () => new CoinbaseExchange(),
    symbol: 'COINBASE:XRPUSD',
    built: ['3', '1W'],
  },
  {
    name: 'Kraken',
    adapter: () => new KrakenExchange(),
    symbol: 'KRAKEN:XBTUSD',
    built: ['120', '1W'],
  },
  {
    name: 'Bitstamp',
    adapter: () => new BitstampExchange(),
    symbol: 'BITSTAMP:XRPUSD',
    built: ['45', '3D', '1W'],
  },
];

const today = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
};

async function until(done: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 250));
}

describe.runIf(LIVE).concurrent.each(CASES)('$name, live', ({ adapter, symbol, built }) => {
  const market = new MarketService([adapter()]);
  afterAll(() => market.close());

  it('resolves the symbol with its tick size', async () => {
    const info = await market.resolveSymbol(symbol);
    expect(info.id).toBe(symbol);
    expect(info.tickSize).toBeGreaterThan(0);
    expect(Number.isInteger(info.pricePrecision)).toBe(true);
  });

  it("serves daily history up to today's bar, one bar a day", async () => {
    const { bars } = await market.getBars(symbol, '1D', null, 300);
    expect(bars.length).toBeGreaterThan(250);
    expect(bars.at(-1)?.time).toBe(today());
    const gaps = bars.slice(1).filter((bar, i) => bar.time - (bars[i] as Bar).time !== 86_400);
    expect(gaps).toEqual([]);
  });

  it.each(built)(
    'builds %s bars on their boundaries, up to the current one',
    async (text) => {
      const resolution = parseResolution(text);
      if (!resolution) throw new Error(text);
      const { bars } = await market.getBars(symbol, text, null, 100);
      expect(bars.length).toBeGreaterThan(5);
      for (const bar of bars)
        expect(barOpenTime(resolution, bar.time * 1000)).toBe(bar.time * 1000);
      expect(bars.slice(1).every((bar, i) => bar.time > (bars[i] as Bar).time)).toBe(true);
      expect(bars.at(-1)?.time).toBe(barOpenTime(resolution, Date.now()) / 1000);
    },
    30_000,
  );

  it('streams the live minute bar and the best bid and ask', async () => {
    const states: string[] = [];
    const bars: Bar[] = [];
    const books: { bid: number; ask: number }[] = [];
    const fail = (error: Error) => {
      throw error;
    };
    const stopBars = market.subscribeBars(symbol, '1', {
      onBar: (bar) => bars.push(bar),
      onState: (state) => states.push(state),
      onError: fail,
    });
    const stopBook = market.subscribeBook(symbol, {
      onBook: (top) => books.push(top),
      onState: () => {},
      onError: fail,
    });
    await until(() => states.includes('live') && bars.length > 0 && books.length > 0, 25_000);
    stopBars();
    stopBook();
    expect(states).toContain('live');
    expect(bars.at(-1)?.time).toBe(barOpenTime({ count: 1, unit: 'minute' }, Date.now()) / 1000);
    expect(books.length).toBeGreaterThan(0);
    for (const { bid, ask } of books) expect(ask).toBeGreaterThanOrEqual(bid);
  }, 30_000);

  it('quotes the last price against the previous daily close', async () => {
    const { bars } = await market.getBars(symbol, '1D', null, 2);
    const previous = bars.at(-2) as Bar;
    const quotes: { last: number; prevClose: number | null }[] = [];
    const stop = market.subscribeQuote(symbol, {
      onQuote: (last, prevClose) => quotes.push({ last, prevClose }),
      onState: () => {},
      onError: (error) => {
        throw error;
      },
    });
    await until(() => quotes.length > 0, 20_000);
    stop();
    expect(quotes[0]?.prevClose).toBe(previous.close);
    expect(Math.abs((quotes.at(-1)?.last ?? 0) / previous.close - 1)).toBeLessThan(0.5);
  }, 30_000);
});

describe.runIf(LIVE)('Bitstamp, live history', () => {
  const market = new MarketService([new BitstampExchange()]);
  afterAll(() => market.close());

  it("reaches back to Bitcoin's first day there, 18 August 2011, every day since", async () => {
    const newer = await market.getBars('BITSTAMP:BTCUSD', '1D', null, 5_000);
    const first = newer.bars[0] as Bar;
    const older = await market.getBars('BITSTAMP:BTCUSD', '1D', first.time, 5_000);
    expect(older.hasMore).toBe(false);
    const bars = [...older.bars, ...newer.bars];
    expect(bars[0]?.time).toBe(Date.UTC(2011, 7, 18) / 1000);
    expect(bars.at(-1)?.time).toBe(today());
    const gaps = bars.slice(1).filter((bar, i) => bar.time - (bars[i] as Bar).time !== 86_400);
    expect(gaps).toEqual([]);
  }, 120_000);
});
