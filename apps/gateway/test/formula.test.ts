import type { Bar } from '@tradingnerd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BarListener, type BookListener, MarketService } from '../src/market/MarketService.ts';
import { MarketError } from '../src/market/types.ts';
import { FakePairsExchange } from './helpers/FakePairsExchange.ts';

const DAY = 86_400;
const MINUTE = 60;
/** Tuesday 2026-10-20, noon UTC. */
const NOW = Date.UTC(2026, 9, 20, 12);
const TODAY = Date.UTC(2026, 9, 20) / 1000;

const bar = (time: number, open: number, high: number, low: number, close: number): Bar => ({
  time,
  open,
  high,
  low,
  close,
  volume: 5,
});
/** `count` bars every `step` seconds up to `last`, each flat at `price(i)`. */
const flatBars = (count: number, last: number, step: number, price: (i: number) => number) =>
  Array.from({ length: count }, (_, i) => {
    const value = price(i);
    return bar(last - (count - 1 - i) * step, value, value, value, value);
  });

function setup() {
  const binance = new FakePairsExchange('BINANCE');
  const caps = new FakePairsExchange('CRYPTOCAP');
  const market = new MarketService([binance, caps], { emitIntervalMs: 0, cacheHistory: false });
  return { binance, caps, market };
}

async function errorOf(promise: Promise<unknown>): Promise<MarketError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('formulas', () => {
  let open: MarketService[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    for (const market of open) await market.close();
    open = [];
    vi.useRealTimers();
  });
  const made = () => {
    const parts = setup();
    open.push(parts.market);
    return parts;
  };

  it("describes a formula as TradingView shows it: its tickers, its first symbol's decimals", async () => {
    const { caps, market } = made();
    caps.setBars(
      'BTC.D',
      '1D',
      flatBars(3, TODAY, DAY, () => 60),
    );
    caps.setBars(
      'ETH.D',
      '1D',
      flatBars(3, TODAY, DAY, () => 10),
    );
    const info = await market.resolveSymbol('cryptocap:btc.d + cryptocap:eth.d');
    expect(info).toMatchObject({
      id: 'CRYPTOCAP:BTC.D+CRYPTOCAP:ETH.D',
      ticker: 'BTC.D+ETH.D',
      description: 'BTC.D+ETH.D',
      exchangeName: 'CRYPTOCAP',
      base: '',
      type: 'spread',
      pricePrecision: 2,
      tickSize: 0.01,
      timezone: 'Etc/UTC',
      hasBook: true,
    });
  });

  it("names a symbol it lacks, and suggests CRYPTOCAP's coin next to market caps", async () => {
    const { caps, market } = made();
    for (const ticker of ['TOTAL3', 'USDT', 'USDC']) {
      caps.setBars(
        ticker,
        '1D',
        flatBars(3, TODAY, DAY, () => 100),
      );
    }
    const error = await errorOf(
      market.resolveSymbol('CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-EURONEXT:USDC'),
    );
    expect(error.code).toBe('unknown_symbol');
    expect(error.message).toContain('EURONEXT:USDC');
    expect(error.suggestion).toBe('CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-CRYPTOCAP:USDC');
    // Without market caps beside it, no suggestion.
    const plain = await errorOf(market.resolveSymbol('BINANCE:BTCUSDT/EURONEXT:USDC'));
    expect(plain.code).toBe('unknown_symbol');
    expect(plain.suggestion).toBeUndefined();
  });

  it('asks for the exchange of each symbol', async () => {
    const { market } = made();
    expect((await errorOf(market.resolveSymbol('BTCUSDT / ETHUSDT'))).code).toBe('bad_request');
  });

  it("works its daily bars out from its symbols' opens, highs, lows and closes", async () => {
    const { binance, market } = made();
    binance.setBars('BTCUSDT', '1D', [
      bar(TODAY - DAY, 100, 120, 90, 110),
      bar(TODAY, 110, 130, 100, 120),
    ]);
    binance.setBars('ETHUSDT', '1D', [bar(TODAY - DAY, 10, 12, 8, 11), bar(TODAY, 11, 11, 10, 10)]);
    const { bars } = await market.getBars('BINANCE:BTCUSDT/BINANCE:ETHUSDT', '1D', null, 5);
    expect(bars.map((b) => b.time)).toEqual([TODAY - DAY, TODAY]);
    // Yesterday: open 100/10, high 120/12, low 90/8, close 110/11: 10, 10, 11.25, 10.
    expect(bars[0]).toMatchObject({ open: 10, high: 11.25, low: 10, close: 10 });
    // Today: open 110/11, high 130/11, low 100/10, close 120/10: 10, 11.8, 10, 12; high 12.
    expect(bars[1]).toMatchObject({ open: 10, high: 12, low: 10, close: 12 });
  });

  it('keeps a symbol at its last price where it has no bar, and starts when every symbol has one', async () => {
    const { binance, market } = made();
    binance.setBars(
      'BTCUSDT',
      '1D',
      flatBars(4, TODAY, DAY, (i) => 100 + i),
    );
    // ETH begins a day later, and misses yesterday.
    binance.setBars('ETHUSDT', '1D', [
      bar(TODAY - 2 * DAY, 10, 10, 10, 10),
      bar(TODAY, 20, 20, 20, 20),
    ]);
    const { bars } = await market.getBars('BINANCE:BTCUSDT-BINANCE:ETHUSDT', '1D', null, 10);
    expect(bars.map((b) => [b.time, b.close])).toEqual([
      [TODAY - 2 * DAY, 101 - 10],
      [TODAY - DAY, 102 - 10],
      [TODAY, 103 - 20],
    ]);
  });

  it('leaves out a period where it divides by zero, and takes numbers', async () => {
    const { binance, market } = made();
    binance.setBars(
      'BTCUSDT',
      '1D',
      flatBars(2, TODAY, DAY, () => 100),
    );
    binance.setBars(
      'ETHUSDT',
      '1D',
      flatBars(2, TODAY, DAY, (i) => (i === 0 ? 0 : 4)),
    );
    const { bars } = await market.getBars('BINANCE:BTCUSDT/BINANCE:ETHUSDT*2+1', '1D', null, 5);
    expect(bars.map((b) => [b.time, b.close])).toEqual([[TODAY, 51]]);
  });

  it('builds a 5-minute chart from 1-minute bars, as TradingView builds spreads', async () => {
    const { binance, market } = made();
    const last = Math.floor(NOW / 1000 / 300) * 300 + 240;
    binance.setBars(
      'BTCUSDT',
      '1',
      flatBars(10, last, MINUTE, (i) => 100 + i),
    );
    binance.setBars(
      'ETHUSDT',
      '1',
      flatBars(10, last, MINUTE, () => 10),
    );
    const { bars } = await market.getBars('BINANCE:BTCUSDT/BINANCE:ETHUSDT', '5', null, 5);
    // Two whole 5-minute bars: the minutes 100..104 and 105..109 over 10.
    expect(bars.map((b) => [b.open, b.high, b.low, b.close])).toEqual([
      [10, 10.4, 10, 10.4],
      [10.5, 10.9, 10.5, 10.9],
    ]);
  });

  it('moves its live bar with its symbols, and goes live when they are', async () => {
    const { binance, market } = made();
    const minute = Math.floor(NOW / 60_000) * 60;
    binance.setBars(
      'BTCUSDT',
      '1',
      flatBars(3, minute, MINUTE, () => 100),
    );
    binance.setBars(
      'ETHUSDT',
      '1',
      flatBars(3, minute, MINUTE, () => 10),
    );
    const updates: Bar[] = [];
    const states: string[] = [];
    const listener: BarListener = {
      onBar: (update) => updates.push(update),
      onState: (state) => states.push(state),
      onError: (error) => states.push(`error ${error.code}`),
    };
    const stop = market.subscribeBars('BINANCE:BTCUSDT/BINANCE:ETHUSDT', '1', listener);
    await vi.waitFor(() => expect(states).toContain('live'));
    binance.emitPrice('BTCUSDT', 110, NOW);
    await vi.waitFor(() => expect(updates.at(-1)?.close).toBe(11));
    binance.emitPrice('ETHUSDT', 5, NOW);
    await vi.waitFor(() => expect(updates.at(-1)?.close).toBe(22));
    const latest = updates.at(-1) as Bar;
    expect(latest.time).toBe(minute);
    expect(latest.high).toBe(22);
    stop();
  });

  it('gives its value as both Sell and Buy', async () => {
    const { binance, market } = made();
    binance.setBars(
      'BTCUSDT',
      '1D',
      flatBars(2, TODAY, DAY, () => 100),
    );
    binance.setBars(
      'ETHUSDT',
      '1D',
      flatBars(2, TODAY, DAY, () => 10),
    );
    const books: { bid: number; ask: number }[] = [];
    const listener: BookListener = {
      onBook: (top) => books.push(top),
      onState: () => {},
      onError: () => {},
    };
    await market.resolveSymbol('BINANCE:BTCUSDT/BINANCE:ETHUSDT');
    const stop = market.subscribeBook('BINANCE:BTCUSDT/BINANCE:ETHUSDT', listener);
    await vi.waitFor(() => expect(books.length).toBeGreaterThan(0));
    binance.emitPrice('BTCUSDT', 150, NOW);
    await vi.waitFor(() => expect(books.at(-1)).toEqual({ bid: 15, ask: 15 }));
    stop();
  });

  it("quotes Last and the previous close from its daily bars, like any row's", async () => {
    const { binance, market } = made();
    binance.setBars('BTCUSDT', '1D', [
      bar(TODAY - DAY, 90, 90, 90, 100),
      bar(TODAY, 100, 120, 100, 120),
    ]);
    binance.setBars('ETHUSDT', '1D', [
      bar(TODAY - DAY, 10, 10, 10, 10),
      bar(TODAY, 10, 10, 10, 10),
    ]);
    const quotes: [number, number | null][] = [];
    const stop = market.subscribeQuote('BINANCE:BTCUSDT/BINANCE:ETHUSDT', {
      onQuote: (last, prevClose) => quotes.push([last, prevClose]),
      onState: () => {},
      onError: () => {},
    });
    await vi.waitFor(() => expect(quotes.at(-1)).toEqual([12, 10]));
    stop();
  });

  it('serves the same formula however it was typed, as one feed', async () => {
    const { binance, market } = made();
    binance.setBars(
      'BTCUSDT',
      '1D',
      flatBars(2, TODAY, DAY, () => 100),
    );
    binance.setBars(
      'ETHUSDT',
      '1D',
      flatBars(2, TODAY, DAY, () => 10),
    );
    const a = await market.resolveSymbol('BINANCE:BTCUSDT / BINANCE:ETHUSDT');
    const b = await market.resolveSymbol('(binance:btcusdt)/binance:ethusdt');
    expect(a.id).toBe(b.id);
    const noop: BarListener = { onBar: () => {}, onState: () => {}, onError: () => {} };
    const stops = [
      market.subscribeBars(a.id, '1D', noop),
      market.subscribeBars('BINANCE:BTCUSDT / BINANCE:ETHUSDT', '1D', noop),
    ];
    // One formula feed, plus each symbol's own.
    await vi.waitFor(() => expect(market.feedCount()).toBe(3));
    for (const stop of stops) stop();
  });
});
