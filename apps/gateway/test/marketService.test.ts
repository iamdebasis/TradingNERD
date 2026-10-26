import { type Bar, foldTicks } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BarListener, type BookListener, MarketService } from '../src/market/MarketService.ts';
import { MarketError } from '../src/market/types.ts';
import { dailyBars, FakeExchange } from './helpers/FakeExchange.ts';
import { FakeTickSource, makeAggTrades } from './helpers/FakeTicks.ts';

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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('fetches the pages of an exchange with a bar in every period side by side', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((LAST + 43_200) * 1000);
    const fake = new FakeExchange({ maxBarsPerRequest: 3, gapless: true });
    fake.bars = dailyBars(10, LAST);
    const market = new MarketService([fake]);
    const { bars, hasMore } = await market.getBars(SYMBOL, '1D', null, 7);
    expect(bars).toEqual(dailyBars(10, LAST).slice(-7));
    expect(hasMore).toBe(true);
    // Three 3-day slices ending after today's bar, asked for at once; no one-by-one paging.
    const end = (LAST + 86_400) * 1000;
    expect(fake.rangeCalls.map((call) => (end - call.endMs) / 86_400_000)).toEqual([0, 3, 6]);
    expect(fake.fetchCalls).toEqual([]);
  });

  it('knows from a short slice where a gapless history starts, without looking further', async () => {
    const fake = new FakeExchange({ maxBarsPerRequest: 4, gapless: true });
    fake.bars = dailyBars(10, LAST);
    const market = new MarketService([fake]);
    const { bars, hasMore } = await market.getBars(SYMBOL, '1D', LAST, 50);
    expect(bars).toHaveLength(9);
    expect(hasMore).toBe(false);
    expect(fake.fetchCalls).toEqual([]);
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
    ['a resolution the exchange cannot serve or build', SYMBOL, '30S', 5, 'unsupported_resolution'],
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
    ['an unsupported resolution', SYMBOL, '30S', 'unsupported_resolution'],
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

/** 10:00 UTC on the fake data day, in seconds. */
const TEN = Date.UTC(2026, 9, 18, 10, 0) / 1000;
const MINUTE = 60;

/** `count` 1-minute bars from `from` (UTC s): bar i opens at i, closes at i + 0.5. */
function minuteBars(from: number, count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    time: from + i * MINUTE,
    open: i,
    high: i + 1,
    low: i - 1,
    close: i + 0.5,
    volume: 1,
  }));
}

/** A fake exchange with 1-minute data, its clock pinned to `nowSec`. */
function resampleSetup({
  maxBarsPerRequest = 1_000,
  nowSec,
  natives,
  fromListing = false,
}: {
  maxBarsPerRequest?: number;
  nowSec: number;
  natives?: string[];
  fromListing?: boolean;
}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(nowSec * 1000);
  const fake = new FakeExchange({
    maxBarsPerRequest,
    fromListing,
    ...(natives ? { natives } : {}),
  });
  const market = new MarketService([fake], { emitIntervalMs: 0, retryDelayMs: () => 5 });
  return { fake, market };
}

describe('MarketService resampled intervals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds 2-minute bars from 1-minute ones, fetching time slices in parallel', async () => {
    const { fake, market } = resampleSetup({ maxBarsPerRequest: 4, nowSec: TEN + 9.5 * MINUTE });
    fake.series.set('1', minuteBars(TEN, 10)); // 10:00 … 10:09
    const { bars, hasMore } = await market.getBars(SYMBOL, '2', null, 3);

    expect(bars).toEqual([
      { time: TEN + 4 * MINUTE, open: 4, high: 6, low: 3, close: 5.5, volume: 2 },
      { time: TEN + 6 * MINUTE, open: 6, high: 8, low: 5, close: 7.5, volume: 2 },
      { time: TEN + 8 * MINUTE, open: 8, high: 10, low: 7, close: 9.5, volume: 2 },
    ]);
    expect(hasMore).toBe(true);
    // (3 + 1) bars × 2 minutes = 8 minutes = two 4-bar slices ending after the live minute.
    expect(fake.rangeCalls).toEqual([
      { resolution: '1', startMs: (TEN + 6 * MINUTE) * 1000, endMs: (TEN + 10 * MINUTE) * 1000 },
      { resolution: '1', startMs: (TEN + 2 * MINUTE) * 1000, endMs: (TEN + 6 * MINUTE) * 1000 },
    ]);
  });

  it('ends before `to` and notices the start of history', async () => {
    const { fake, market } = resampleSetup({ maxBarsPerRequest: 4, nowSec: TEN + 30 * MINUTE });
    fake.series.set('1', minuteBars(TEN, 10));
    const all = await market.getBars(SYMBOL, '2', TEN + 6 * MINUTE, 10);
    expect(all.bars.map((bar) => bar.time)).toEqual([TEN, TEN + 2 * MINUTE, TEN + 4 * MINUTE]);
    expect(all.hasMore).toBe(false);
    // The oldest slice came back short, so one look further back confirmed nothing is there.
    expect(fake.fetchCalls.at(-1)).toMatchObject({ resolution: '1', endTimeMs: TEN * 1000 });
  });

  it('caps the requests per call and drops an oldest bar it could only half build', async () => {
    const { fake, market } = resampleSetup({ maxBarsPerRequest: 2, nowSec: TEN + 9.5 * MINUTE });
    fake.series.set('1', minuteBars(TEN - 60 * MINUTE, 70)); // 09:00 … 10:09
    const { bars, hasMore } = await market.getBars(SYMBOL, '3', null, 50);

    expect(fake.rangeCalls).toHaveLength(12);
    // 12 slices × 2 minutes reach back to 09:46, inside the 09:45 bar, which is left out.
    expect(bars[0]).toEqual({
      time: TEN - 12 * MINUTE,
      open: 48,
      high: 51,
      low: 47,
      close: 50.5,
      volume: 3,
    });
    expect(bars.map((bar) => bar.time)).toEqual(
      Array.from({ length: 8 }, (_, i) => TEN - 12 * MINUTE + i * 3 * MINUTE),
    );
    expect(hasMore).toBe(true);
  });

  it("leaves out a week its days only reach part of, but keeps a listing's first week", async () => {
    // Days from Wednesday 7 October 2026: the week of Monday 5 October is only partly there.
    const days = Array.from({ length: 12 }, (_, i) => ({
      time: Date.UTC(2026, 9, 7 + i) / 1000,
      open: 10 + i,
      high: 11 + i,
      low: 9 + i,
      close: 10.5 + i,
      volume: 1,
    }));
    const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
    const nowSec = Date.UTC(2026, 9, 18, 12) / 1000;

    // History that may stop short of the listing: half a week would be wrong.
    const cut = resampleSetup({ nowSec, natives: ['1', '1D'] });
    cut.fake.series.set('1D', days);
    const weeks = await cut.market.getBars(SYMBOL, '1W', null, 10);
    expect(weeks.bars.map((bar) => day(bar.time))).toEqual(['2026-10-12']);
    expect(weeks.bars[0]).toMatchObject({ open: 15, close: 21.5 });
    expect(weeks.hasMore).toBe(false);

    // History from the listing: its first week starts on the Wednesday, as TradingView's does.
    const listed = resampleSetup({ nowSec, natives: ['1', '1D'], fromListing: true });
    listed.fake.series.set('1D', days);
    const first = await listed.market.getBars(SYMBOL, '1W', null, 10);
    expect(first.bars.map((bar) => day(bar.time))).toEqual(['2026-10-05', '2026-10-12']);
    expect(first.bars[0]).toMatchObject({ open: 10, high: 15, low: 9, close: 14.5 });
  });

  it('builds 6-month bars from monthly ones, starting in January and July', async () => {
    const { fake, market } = resampleSetup({
      nowSec: Date.UTC(2026, 9, 18) / 1000,
      natives: ['1', '60', '1D', '1M'],
    });
    const months = Array.from({ length: 30 }, (_, i) => ({
      time: Date.UTC(2024, 4 + i, 1) / 1000, // May 2024 … October 2026
      open: i,
      high: i + 1,
      low: i - 1,
      close: i + 0.5,
      volume: 1,
    }));
    fake.series.set('1M', months);
    const { bars, hasMore } = await market.getBars(SYMBOL, '6M', null, 3);
    expect(bars.map((bar) => new Date(bar.time * 1000).toISOString().slice(0, 7))).toEqual([
      '2025-07',
      '2026-01',
      '2026-07',
    ]);
    expect(bars[1]).toMatchObject({ open: 20, close: 25.5, volume: 6 });
    expect(bars[2]).toMatchObject({ open: 26, close: 29.5, volume: 4 }); // July … October so far
    expect(hasMore).toBe(true);
    expect(fake.rangeCalls).toEqual([]); // calendar months page back instead of slicing
  });

  it('streams a resampled bar: seeded from the base bars of its period, then live', async () => {
    const { fake, market } = resampleSetup({ nowSec: TEN + 4.5 * MINUTE });
    fake.series.set('1', minuteBars(TEN, 5)); // 10:00 … 10:04
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '3', listener);

    // The 10:03 bar so far: the 10:03 and 10:04 minutes.
    await vi.waitFor(() => expect(events).toEqual(['state live', `bar ${TEN + 3 * MINUTE} 4.5`]));
    expect(fake.fetchCalls[0]).toEqual({ resolution: '1', endTimeMs: null, limit: 3 });

    fake.emitTrade({ price: 7, quantity: 1, time: (TEN + 5 * MINUTE + 10) * 1000 });
    expect(events.at(-1)).toBe(`bar ${TEN + 3 * MINUTE} 7`);
    fake.emitTrade({ price: 8, quantity: 1, time: (TEN + 6 * MINUTE + 1) * 1000 });
    expect(events.at(-1)).toBe(`bar ${TEN + 6 * MINUTE} 8`);
  });
});

describe('MarketService tick intervals', () => {
  function tickSetup() {
    // 2,001 aggregates: 6,001 trades, so the live 100-tick bar holds a single trade.
    const trades = makeAggTrades(2_001, 10_000, 500_000);
    const source = new FakeTickSource(trades, 500);
    const fake = new FakeExchange({ ticks: source });
    const market = new MarketService([fake], { emitIntervalMs: 0, retryDelayMs: () => 5 });
    return { fake, market, source, trades };
  }

  it('serves tick bars numbered by trade, each with its first trade time', async () => {
    const { market, trades } = tickSetup();
    const { bars, hasMore } = await market.getBars(SYMBOL, '100T', null, 10);
    expect(bars).toEqual(foldTicks(trades, 100).slice(-10));
    expect(bars.every((bar) => typeof bar.start === 'number')).toBe(true);
    expect(hasMore).toBe(true);
    // The next page back continues exactly where this one began.
    const older = await market.getBars(SYMBOL, '100T', bars[0]?.time ?? 0, 10);
    expect([...older.bars, ...bars]).toEqual(foldTicks(trades, 100).slice(-20));
  });

  it('has no tick intervals on an exchange without numbered trades', async () => {
    const { market } = setup();
    expect((await errorOf(market.getBars(SYMBOL, '10T', null, 5))).code).toBe(
      'unsupported_resolution',
    );
  });

  it('streams the live tick bar from trades, opening bars at trade-count boundaries', async () => {
    const { market, fake, trades } = tickSetup();
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '100T', listener);
    const live = foldTicks(trades, 100).at(-1) as Bar;
    expect(live.volume).toBeLessThan(100 * 10); // still filling up
    await vi.waitFor(() =>
      expect(events).toEqual(['state live', `bar ${live.time} ${live.close}`]),
    );
    expect(fake.activeStreams()).toBe(1); // trades only: tick bars need no candles

    const last = trades.at(-1) as (typeof trades)[number];
    const boundary = (live.time + 1) * 100;
    // An aggregate that finishes this bar and starts the next.
    fake.emitTrade({
      id: last.id + 1,
      firstId: last.lastId + 1,
      lastId: boundary + 1,
      price: 1.5,
      quantity: (boundary + 1 - last.lastId) * 10,
      time: last.time + 1_000,
    });
    expect(events.slice(-2)).toEqual([`bar ${live.time} 1.5`, `bar ${live.time + 1} 1.5`]);
  });

  it('starts over when trades go missing, so listeners reload what they missed', async () => {
    const { market, fake, source, trades } = tickSetup();
    const { listener, events } = barRecorder();
    market.subscribeBars(SYMBOL, '100T', listener);
    await vi.waitFor(() => expect(events).toContain('state live'));
    const seedsBefore = source.pageCalls.length;

    const last = trades.at(-1) as (typeof trades)[number];
    fake.emitTrade({
      id: last.id + 5, // four aggregates never arrived
      firstId: last.lastId + 20,
      lastId: last.lastId + 20,
      price: 1.4,
      quantity: 10,
      time: last.time + 2_000,
    });
    expect(events).toContain('state reconnecting');
    await vi.waitFor(() => expect(events.at(-2)).toBe('state live'));
    expect(source.pageCalls.length).toBe(seedsBefore + 1);
  });
});

describe('MarketService.subscribeQuote', () => {
  it("quotes the daily bar's live price against the previous close, sharing the daily feed", async () => {
    const { market, fake } = setup();
    const quotes: string[] = [];
    market.subscribeQuote(SYMBOL, {
      onQuote: (last, prevClose) => quotes.push(`${last} ${prevClose}`),
      onState: () => {},
      onError: (error) => quotes.push(`error ${error.code}`),
    });
    // dailyBars(10, LAST): the previous bar closes at 1.09, the live one at 1.1.
    await vi.waitFor(() => expect(quotes.at(-1)).toBe('1.1 1.09'));
    const chart = barRecorder();
    market.subscribeBars(SYMBOL, '1D', chart.listener);
    await vi.waitFor(() => expect(chart.events).toContain('state live'));
    expect(fake.activeStreams()).toBe(2); // one daily feed (candles + trades) for both

    fake.emitTrade({ price: 1.2, quantity: 1, time: LAST * 1000 + HOUR_MS });
    await vi.waitFor(() => expect(quotes.at(-1)).toBe('1.2 1.09'));
  });

  it('reports an unknown symbol', async () => {
    const { market } = setup();
    const quotes: string[] = [];
    market.subscribeQuote('FAKE:NOPE', {
      onQuote: () => {},
      onState: () => {},
      onError: (error) => quotes.push(`error ${error.code}`),
    });
    await vi.waitFor(() => expect(quotes).toEqual(['error unknown_symbol']));
    expect(market.feedCount()).toBe(0);
  });
});
