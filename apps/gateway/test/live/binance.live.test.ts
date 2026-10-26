import {
  type Bar,
  barCloseTime,
  barOpenTime,
  parseResolution,
  type Resolution,
  resampleBars,
} from '@tradingnerd/core';
import { afterAll, describe, expect, it } from 'vitest';
import { BinanceExchange } from '../../src/exchanges/binance/BinanceExchange.ts';
import { CoinGeckoClient, CoinGeckoError } from '../../src/logos/coingecko.ts';
import { MarketService } from '../../src/market/MarketService.ts';

const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(`bad resolution ${text}`);
  return resolution;
};

// Talks to the real Binance API. Skipped unless LIVE=1 (run with `pnpm test:live`), so normal
// test runs stay offline and deterministic.
const LIVE = process.env.LIVE === '1';

describe.runIf(LIVE)('Binance, live', () => {
  const market = new MarketService([new BinanceExchange()]);
  afterAll(() => market.close());

  it('resolves XRPUSDT the way TradingView names it', async () => {
    const info = await market.resolveSymbol('BINANCE:XRPUSDT');
    expect(info).toMatchObject({
      id: 'BINANCE:XRPUSDT',
      description: 'XRP / TetherUS',
      pricePrecision: 4,
      tickSize: 0.0001,
    });
  });

  it("serves today's daily bar", async () => {
    const { bars } = await market.getBars('BINANCE:XRPUSDT', '1D', null, 2);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
    expect(bars.at(-1)?.time).toBe(today);
  });

  it('pages all the way back to the 2018 listing, and says so', async () => {
    const { bars, hasMore, fromListing } = await market.getBars(
      'BINANCE:XRPUSDT',
      '1D',
      null,
      5_000,
    );
    expect(hasMore).toBe(false);
    expect(fromListing).toBe(true);
    expect(new Date((bars[0]?.time ?? 0) * 1000).toISOString().slice(0, 10)).toBe('2018-05-04');
    const gaps = bars.slice(1).filter((bar, i) => bar.time - (bars[i]?.time ?? 0) !== 86_400);
    expect(gaps).toEqual([]);
  });

  it('streams a live 1-minute bar and the order book top', async () => {
    const states: string[] = [];
    const closes: number[] = [];
    const quotes: { bid: number; ask: number }[] = [];
    const stopBars = market.subscribeBars('BINANCE:XRPUSDT', '1', {
      onBar: (bar) => closes.push(bar.close),
      onState: (state) => states.push(state),
      onError: (error) => {
        throw error;
      },
    });
    const stopBook = market.subscribeBook('BINANCE:XRPUSDT', {
      onBook: (top) => quotes.push(top),
      onState: () => {},
      onError: (error) => {
        throw error;
      },
    });
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && (closes.length < 3 || quotes.length < 3)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stopBars();
    stopBook();
    expect(states).toContain('live');
    expect(closes.length).toBeGreaterThanOrEqual(3);
    expect(quotes.length).toBeGreaterThanOrEqual(3);
    for (const { bid, ask } of quotes) expect(ask).toBeGreaterThanOrEqual(bid);
  }, 30_000);

  it.each([
    ['1', '1S'],
    ['15', '5'],
    ['60', '15'],
    ['240', '60'],
    ['1D', '60'],
    ['1W', '1D'],
    ['1M', '1D'],
  ])(
    "rebuilds Binance's own %s bars exactly from its %s bars",
    async (targetText, baseText) => {
      const binance = new BinanceExchange();
      const target = r(targetText);
      const base = r(baseText);
      // The latest 12 complete target bars, straight from Binance.
      const native = (await binance.fetchBars('XRPUSDT', target, null, 13)).slice(0, -1);
      const first = native[0];
      const last = native.at(-1);
      if (!first || !last) throw new Error('no bars');
      const endMs = barCloseTime(target, last.time * 1000);
      const baseBars: Bar[] = [];
      for (let start = first.time * 1000; start < endMs; ) {
        const page = await binance.fetchRange('XRPUSDT', base, start, endMs);
        baseBars.push(...page);
        const newest = page.at(-1);
        if (!newest || page.length < binance.maxBarsPerRequest) break;
        start = newest.time * 1000 + 1;
      }
      const rebuilt = resampleBars(baseBars, target);
      expect(rebuilt.map((bar) => bar.time)).toEqual(native.map((bar) => bar.time));
      for (const [i, bar] of rebuilt.entries()) {
        const expected = native[i] as Bar;
        expect([bar.open, bar.high, bar.low, bar.close]).toEqual([
          expected.open,
          expected.high,
          expected.low,
          expected.close,
        ]);
        expect(bar.volume).toBeCloseTo(expected.volume, 4);
      }
      await binance.close();
    },
    60_000,
  );

  it.each(['2', '10', '45', '180', '3M', '6M', '12M', '5S', '45S'])(
    'serves resampled %s history on its bar boundaries, up to now',
    async (text) => {
      const target = r(text);
      const startedMs = Date.now();
      const { bars, hasMore } = await market.getBars('BINANCE:XRPUSDT', text, null, 1_000);
      const finishedMs = Date.now();
      expect(bars.length).toBeGreaterThan(5);
      for (const [i, bar] of bars.entries()) {
        expect(barOpenTime(target, bar.time * 1000)).toBe(bar.time * 1000);
        if (i > 0) expect(bar.time).toBeGreaterThan(bars[i - 1]?.time ?? 0);
        expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
        expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      }
      // The newest bar is the live one (short bars can roll over while the request runs).
      const latest = (bars.at(-1) as Bar).time * 1000;
      expect(latest).toBeGreaterThanOrEqual(barOpenTime(target, startedMs));
      expect(latest).toBeLessThanOrEqual(barOpenTime(target, finishedMs));
      if (target.unit === 'second') expect(hasMore).toBe(true);
    },
    30_000,
  );

  it('streams a live 45-second bar built from 1-second bars', async () => {
    const states: string[] = [];
    const times: number[] = [];
    const stop = market.subscribeBars('BINANCE:XRPUSDT', '45S', {
      onBar: (bar) => times.push(bar.time),
      onState: (state) => states.push(state),
      onError: (error) => {
        throw error;
      },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && times.length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stop();
    expect(states).toContain('live');
    expect(times.length).toBeGreaterThanOrEqual(3);
    for (const time of times) {
      expect(barOpenTime(r('45S'), time * 1000)).toBe(time * 1000);
    }
  }, 30_000);

  it("serves 100-tick bars that match Binance's own trades exactly, and pages back seamlessly", async () => {
    const { bars, hasMore } = await market.getBars('BINANCE:XRPUSDT', '100T', null, 50);
    expect(bars.length).toBe(50);
    expect(hasMore).toBe(true);
    for (const [i, bar] of bars.entries()) {
      if (i > 0) expect(bar.time).toBe((bars[i - 1]?.time ?? 0) + 1); // trade ids are gapless
      expect(bar.start).toBeGreaterThan(Date.now() - 24 * 3_600_000);
    }
    const older = await market.getBars('BINANCE:XRPUSDT', '100T', bars[0]?.time ?? 0, 20);
    expect(older.bars.at(-1)?.time).toBe((bars[0]?.time ?? 0) - 1);

    // Rebuild one complete bar from Binance's individual trades.
    const bar = bars.at(-3) as Bar;
    const url = `https://api.binance.com/api/v3/historicalTrades?symbol=XRPUSDT&fromId=${bar.time * 100}&limit=100`;
    const trades = (await (await fetch(url)).json()) as {
      id: number;
      price: string;
      time: number;
    }[];
    expect(trades).toHaveLength(100);
    const prices = trades.map((trade) => Number(trade.price));
    expect([bar.open, bar.high, bar.low, bar.close]).toEqual([
      prices[0],
      Math.max(...prices),
      Math.min(...prices),
      prices.at(-1),
    ]);
    expect(bar.start).toBe(trades[0]?.time);
  }, 30_000);

  it('streams live 10-tick bars from the trade stream', async () => {
    const states: string[] = [];
    const numbers: number[] = [];
    const stop = market.subscribeBars('BINANCE:XRPUSDT', '10T', {
      onBar: (bar) => numbers.push(bar.time),
      onState: (state) => states.push(state),
      onError: (error) => {
        throw error;
      },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && new Set(numbers).size < 3) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stop();
    expect(states).toContain('live');
    expect(new Set(numbers).size).toBeGreaterThanOrEqual(3);
    for (const [i, value] of numbers.entries()) {
      if (i > 0) expect(value).toBeGreaterThanOrEqual(numbers[i - 1] ?? 0);
    }
  }, 30_000);

  it("quotes watchlist rows against Binance's previous daily close", async () => {
    const binance = new BinanceExchange();
    const daily = await binance.fetchBars('LINKUSDT', r('1D'), null, 2);
    await binance.close();
    const previous = daily.at(-2) as Bar;
    const quotes: { last: number; prevClose: number | null }[] = [];
    const states: string[] = [];
    const stop = market.subscribeQuote('BINANCE:LINKUSDT', {
      onQuote: (last, prevClose) => quotes.push({ last, prevClose }),
      onState: (state) => states.push(state),
      onError: (error) => {
        throw error;
      },
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && quotes.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stop();
    expect(states).toContain('live');
    expect(quotes.length).toBeGreaterThanOrEqual(1);
    expect(quotes[0]?.prevClose).toBe(previous.close);
    const last = quotes.at(-1)?.last ?? 0;
    expect(Math.abs(last / previous.close - 1)).toBeLessThan(0.5); // a sane price
  }, 30_000);
});

describe.runIf(LIVE)('CoinGecko, live (no key needed)', () => {
  it('rejects a key it does not know', async () => {
    const client = new CoinGeckoClient();
    const error = await client.check('CG-not-a-real-key-0000').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoinGeckoError);
    expect((error as CoinGeckoError).problem).toBe('rejected');
  }, 30_000);
});
