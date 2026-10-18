import type { Bar } from '@tradingnerd/core';
import { describe, expect, it, vi } from 'vitest';
import { type BarListener, type BookListener, MarketService } from '../src/market/MarketService.ts';
import { MarketError } from '../src/market/types.ts';
import { dailyBars, FakeExchange } from './helpers/FakeExchange.ts';

const SYMBOL = 'FAKE:XRPUSDT';
/** Open time of the latest fake daily bar: 2026-10-18 00:00 UTC, in seconds. */
const LAST = Date.UTC(2026, 9, 18) / 1000;
const HOUR_MS = 3_600_000;

function setup({ maxBarsPerRequest = 1_000, emitIntervalMs = 0 } = {}) {
  const fake = new FakeExchange({ maxBarsPerRequest });
  fake.bars = dailyBars(10, LAST);
  const market = new MarketService([fake], { emitIntervalMs, retryDelayMs: () => 5 });
  return { fake, market };
}

function barRecorder() {
  const events: string[] = [];
  const bars: { bar: Bar; historical: boolean }[] = [];
  const listener: BarListener = {
    onBar: (bar, historical) => {
      bars.push({ bar, historical });
      events.push(`bar ${bar.time} ${bar.close}${historical ? ' historical' : ''}`);
    },
    onState: (state) => events.push(`state ${state}`),
    onError: (error) => events.push(`error ${error.code}`),
  };
  return { listener, events, bars };
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

describe('MarketService.getBars', () => {
  it('returns the latest bars when no end time is given', async () => {
    const { market } = setup();
    const { bars, hasMore } = await market.getBars(SYMBOL, '1D', null, 3);
    expect(bars.map((bar) => bar.time)).toEqual([LAST - 2 * 86_400, LAST - 86_400, LAST]);
    expect(hasMore).toBe(true);
  });

  it('pages back through the exchange to fill countBack, oldest first', async () => {
    const { market, fake } = setup({ maxBarsPerRequest: 3 });
    const { bars } = await market.getBars(SYMBOL, '1D', null, 7);
    expect(bars).toHaveLength(7);
    expect(bars.map((bar) => bar.time)).toEqual([...bars.map((bar) => bar.time)].sort());
    expect(bars.at(-1)?.time).toBe(LAST);
    expect(fake.fetchCalls.map((call) => call.limit)).toEqual([3, 3, 1]);
  });

  it('only returns bars strictly before `to`', async () => {
    const { market } = setup();
    const { bars } = await market.getBars(SYMBOL, '1D', LAST, 2);
    expect(bars.map((bar) => bar.time)).toEqual([LAST - 2 * 86_400, LAST - 86_400]);
  });

  it('reports when the start of history is reached', async () => {
    const { market } = setup({ maxBarsPerRequest: 4 });
    const { bars, hasMore } = await market.getBars(SYMBOL, '1D', null, 50);
    expect(bars).toHaveLength(10);
    expect(hasMore).toBe(false);
  });

  it.each([
    ['countBack 0', SYMBOL, '1D', 0, 'bad_request'],
    ['countBack 5001', SYMBOL, '1D', 5_001, 'bad_request'],
    ['an id without exchange', 'XRPUSDT', '1D', 5, 'bad_request'],
    ['an unknown exchange', 'NOPE:XRPUSDT', '1D', 5, 'unknown_symbol'],
    ['an unknown ticker', 'FAKE:NOPE', '1D', 5, 'unknown_symbol'],
    ['an invalid resolution', SYMBOL, 'abc', 5, 'unsupported_resolution'],
    ['a resolution the exchange lacks', SYMBOL, '45', 5, 'unsupported_resolution'],
  ])('rejects %s', async (_label, symbol, resolution, countBack, code) => {
    const { market } = setup();
    expect((await errorOf(market.getBars(symbol, resolution, null, countBack))).code).toBe(code);
  });
});

describe('MarketService.subscribeBars', () => {
  it('goes live with the latest REST bar, then ticks with every trade', async () => {
    const { market, fake } = setup();
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '1D', listener);
    await vi.waitFor(() => expect(events).toEqual(['state live', `bar ${LAST} 1.1`]));

    fake.emitTrade({ price: 2, quantity: 1, time: LAST * 1000 + HOUR_MS });
    expect(events.at(-1)).toBe(`bar ${LAST} 2`);
  });

  it('shares one upstream feed and releases it after the last listener leaves', async () => {
    const { market, fake } = setup();
    const a = barRecorder();
    const b = barRecorder();
    const stopA = market.subscribeBars(SYMBOL, '1D', a.listener);
    const stopB = market.subscribeBars(SYMBOL, '1D', b.listener);
    await vi.waitFor(() => expect(fake.activeStreams()).toBe(2)); // candles + trades, once
    stopA();
    expect(fake.activeStreams()).toBe(2);
    stopB();
    expect(fake.activeStreams()).toBe(0);
    expect(market.feedCount()).toBe(0);
  });

  it('catches up a listener that joins a live feed', async () => {
    const { market } = setup();
    const first = barRecorder();
    market.subscribeBars(SYMBOL, '1D', first.listener);
    await vi.waitFor(() => expect(first.events).toContain('state live'));
    const late = barRecorder();
    market.subscribeBars(SYMBOL, '1D', late.listener);
    await vi.waitFor(() => expect(late.events).toEqual(['state live', `bar ${LAST} 1.1`]));
  });

  it.each([
    ['an unknown ticker', 'FAKE:NOPE', '1D', 'unknown_symbol'],
    ['a malformed id', 'nonsense', '1D', 'bad_request'],
    ['an unsupported resolution', SYMBOL, '45', 'unsupported_resolution'],
  ])('reports %s as an error without opening a feed', async (_label, symbol, resolution, code) => {
    const { market, fake } = setup();
    const { listener, events } = barRecorder();
    market.subscribeBars(symbol, resolution, listener);
    await vi.waitFor(() => expect(events).toEqual([`error ${code}`]));
    expect(fake.activeStreams()).toBe(0);
    expect(market.feedCount()).toBe(0);
  });

  it('goes reconnecting when the exchange feed drops and reseeds when it returns', async () => {
    const { market, fake } = setup();
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '1D', listener);
    await vi.waitFor(() => expect(events).toContain('state live'));
    const fetchesBefore = fake.fetchCalls.length;

    fake.setFeed('down');
    expect(events.at(-1)).toBe('state reconnecting');
    // Trades during the outage can't be placed reliably and are ignored.
    fake.emitTrade({ price: 9, quantity: 1, time: LAST * 1000 + HOUR_MS });
    expect(events.at(-1)).toBe('state reconnecting');

    fake.setFeed('up');
    await vi.waitFor(() => expect(events.at(-2)).toBe('state live'));
    expect(events.at(-1)).toBe(`bar ${LAST} 1.1`);
    expect(fake.fetchCalls.length).toBe(fetchesBefore + 1);
  });

  it('stays reconnecting while the feed has never come up', async () => {
    const { market, fake } = setup();
    fake.setFeed('down');
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '1D', listener);
    await vi.waitFor(() => expect(events).toEqual([`bar ${LAST} 1.1`]));
    expect(events).not.toContain('state live');
  });

  it('retries the REST seed until it succeeds', async () => {
    const { market, fake } = setup();
    fake.fetchError = new MarketError('upstream_error', 'Binance is unreachable');
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '1D', listener);
    await vi.waitFor(() => expect(fake.fetchCalls.length).toBeGreaterThanOrEqual(2));
    expect(events).toEqual([]);
    fake.fetchError = null;
    await vi.waitFor(() => expect(events).toEqual(['state live', `bar ${LAST} 1.1`]));
  });

  it("passes the previous bar's late final candle through as a historical correction", async () => {
    const { market, fake } = setup();
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '1D', listener);
    await vi.waitFor(() => expect(events).toContain('state live'));

    const nextDayMs = (LAST + 86_400) * 1000;
    fake.emitTrade({ price: 1.5, quantity: 1, time: nextDayMs + 10 });
    expect(events.at(-1)).toBe(`bar ${LAST + 86_400} 1.5`);

    const final = { time: LAST, open: 1.09, high: 1.2, low: 1, close: 1.11, volume: 5_000 };
    fake.emitCandle({ bar: final, eventTime: nextDayMs + 20 });
    expect(events.at(-1)).toBe(`bar ${LAST} 1.11 historical`);
  });

  it('sends at most one update per window during a burst, ending on the latest price', async () => {
    const { market, fake } = setup({ emitIntervalMs: 40 });
    const { listener, bars } = barRecorder();
    market.subscribeBars(SYMBOL, '1D', listener);
    await vi.waitFor(() => expect(bars).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (let i = 1; i <= 20; i++) {
      fake.emitTrade({ price: 1 + i / 100, quantity: 1, time: LAST * 1000 + i });
    }
    expect(bars).toHaveLength(2); // the first trade of the burst goes out at once
    await vi.waitFor(() => expect(bars).toHaveLength(3));
    expect(bars.at(-1)?.bar.close).toBe(1.2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bars).toHaveLength(3);
  });

  it('sends a new bar immediately even inside a throttle window', async () => {
    const { market, fake } = setup({ emitIntervalMs: 1_000 });
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '1D', listener);
    await vi.waitFor(() => expect(events).toContain('state live'));
    fake.emitTrade({ price: 1.3, quantity: 1, time: LAST * 1000 + 1 });
    fake.emitTrade({ price: 1.4, quantity: 1, time: (LAST + 86_400) * 1000 });
    // Final update of the old bar first, then the new bar, both without waiting a second.
    expect(events.slice(-2)).toEqual([`bar ${LAST} 1.3`, `bar ${LAST + 86_400} 1.4`]);
  });
});

describe('MarketService.subscribeBook', () => {
  function bookRecorder() {
    const events: string[] = [];
    const listener: BookListener = {
      onBook: ({ bid, ask }) => events.push(`book ${bid}/${ask}`),
      onState: (state) => events.push(`state ${state}`),
      onError: (error) => events.push(`error ${error.code}`),
    };
    return { listener, events };
  }

  it('goes live on the first quote and streams quotes', async () => {
    const { market, fake } = setup();
    const { listener, events } = bookRecorder();
    market.subscribeBook(SYMBOL, listener);
    await vi.waitFor(() => expect(fake.activeStreams()).toBe(1));
    expect(events).toEqual([]);
    fake.emitBook({ bid: 1.2955, ask: 1.2956 });
    expect(events).toEqual(['state live', 'book 1.2955/1.2956']);
  });

  it('replays the last quote to a late listener', async () => {
    const { market, fake } = setup();
    market.subscribeBook(SYMBOL, bookRecorder().listener);
    await vi.waitFor(() => expect(fake.activeStreams()).toBe(1));
    fake.emitBook({ bid: 1, ask: 2 });
    const late = bookRecorder();
    market.subscribeBook(SYMBOL, late.listener);
    await vi.waitFor(() => expect(late.events).toEqual(['state live', 'book 1/2']));
  });

  it('goes reconnecting when the feed drops, and live again on the next quote', async () => {
    const { market, fake } = setup();
    const { listener, events } = bookRecorder();
    market.subscribeBook(SYMBOL, listener);
    await vi.waitFor(() => expect(fake.activeStreams()).toBe(1));
    fake.emitBook({ bid: 1, ask: 2 });
    fake.setFeed('down');
    fake.setFeed('up');
    expect(events.at(-1)).toBe('state reconnecting');
    fake.emitBook({ bid: 1.1, ask: 2.1 });
    expect(events.slice(-2)).toEqual(['state live', 'book 1.1/2.1']);
  });

  it('reports unknown symbols', async () => {
    const { market } = setup();
    const { listener, events } = bookRecorder();
    market.subscribeBook('FAKE:NOPE', listener);
    await vi.waitFor(() => expect(events).toEqual(['error unknown_symbol']));
  });
});
