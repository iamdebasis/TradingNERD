import { type AggTrade, foldTicks } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { TICK_MAX_REQUESTS, TickBars, TickHistory } from '../src/market/ticks.ts';
import { FakeTickSource, makeAggTrades } from './helpers/FakeTicks.ts';

const SYMBOL = 'FAKE:XRPUSDT';

describe('TickHistory', () => {
  // 3,000 aggregates holding 9,000 trades (sizes cycle 1, 3, 5, 2, 4).
  const all = makeAggTrades(3_000, 50_000, 7_000_000);

  it('serves the latest bars, the live one included, built from whole bars only', async () => {
    const source = new FakeTickSource(all, 500);
    const { bars, hasMore } = await new TickHistory().bars(
      source,
      SYMBOL,
      'XRPUSDT',
      100,
      null,
      20,
    );
    const truth = foldTicks(all, 100);
    expect(bars).toEqual(truth.slice(-20));
    expect(hasMore).toBe(true);
    expect(source.pageCalls[0]).toEqual({ fromId: null, limit: 500 });
  });

  it('pages back seamlessly from where the previous page ended, using its anchor', async () => {
    const source = new FakeTickSource(all, 500);
    const history = new TickHistory();
    const truth = foldTicks(all, 100);
    const first = await history.bars(source, SYMBOL, 'XRPUSDT', 100, null, 20);
    const older = await history.bars(source, SYMBOL, 'XRPUSDT', 100, first.bars[0]?.time ?? 0, 20);
    expect([...older.bars, ...first.bars]).toEqual(truth.slice(-40));
    expect(source.containingCalls).toEqual([]); // the anchor was enough
  });

  it('finds where to start when it has no anchor (e.g. after a restart)', async () => {
    const source = new FakeTickSource(all, 500);
    const truth = foldTicks(all, 100);
    const toIndex = truth.at(-30)?.time ?? 0;
    const { bars } = await new TickHistory().bars(source, SYMBOL, 'XRPUSDT', 100, toIndex, 10);
    expect(bars).toEqual(truth.slice(-40, -30));
    expect(source.containingCalls).toEqual([toIndex * 100 - 1]);
  });

  it('stops at the start of history, keeping the first bar even if partial', async () => {
    // History starts 37 trades into a 100-tick bar.
    const partial = makeAggTrades(3_000, 50_000, 7_000_037);
    const source = new FakeTickSource(partial, 500);
    const truth = foldTicks(partial, 100);
    const { bars, hasMore } = await new TickHistory().bars(
      source,
      SYMBOL,
      'XRPUSDT',
      100,
      truth[5]?.time ?? 0,
      50,
    );
    expect(bars).toEqual(truth.slice(0, 5));
    expect(bars[0]?.time).toBe(70_000);
    expect(bars[0]?.volume).toBeLessThan(100 * 10); // fewer than 100 trades' worth
    expect(hasMore).toBe(false);
  });

  it(`makes at most ${TICK_MAX_REQUESTS} requests per call, then leaves the rest for later`, async () => {
    const source = new FakeTickSource(all, 100);
    const { bars, hasMore } = await new TickHistory().bars(
      source,
      SYMBOL,
      'XRPUSDT',
      1_000,
      null,
      50,
    );
    expect(source.pageCalls).toHaveLength(TICK_MAX_REQUESTS);
    // 12 × 100 aggregates hold about 3,600 trades: three whole 1000-tick bars and the live one.
    const truth = foldTicks(all, 1_000);
    expect(bars).toEqual(truth.slice(-bars.length));
    expect(bars.length).toBeGreaterThanOrEqual(3);
    expect(hasMore).toBe(true);
  });

  it('has nothing to offer when the exchange no longer has the trade', async () => {
    const source = new FakeTickSource(all, 500);
    expect(await new TickHistory().bars(source, SYMBOL, 'XRPUSDT', 100, 1, 10)).toEqual({
      bars: [],
      hasMore: false,
    });
  });
});

describe('TickBars', () => {
  const trades = makeAggTrades(40, 0, 0); // trade ids 0 … 119
  const seedTrades = trades.slice(0, 30);
  const later = trades.slice(30);

  it('starts from the latest aggregates and extends the live bar trade by trade', () => {
    const live = new TickBars(10);
    const [seeded] = live.seed(seedTrades) as { bar: { time: number } }[];
    const truth = foldTicks(trades, 10);
    expect(seeded?.bar).toEqual(foldTicks(seedTrades, 10).at(-1));
    for (const trade of later) live.apply(trade);
    expect(live.current()).toEqual(truth.at(-1));
  });

  it('reports every bar an aggregate touches, one per trade at 1 tick', () => {
    const live = new TickBars(1);
    live.seed(seedTrades);
    const next = later[0] as AggTrade;
    const changes = live.apply(next);
    expect(changes).not.toBe('gap');
    const times = (changes as { bar: { time: number } }[]).map((change) => change.bar.time);
    expect(times).toEqual(
      Array.from({ length: next.lastId - next.firstId + 1 }, (_, i) => next.firstId + i),
    );
  });

  it('keeps trades that arrive before the seed and drops ones it already has', () => {
    const live = new TickBars(10);
    for (const trade of trades.slice(25, 35)) live.apply(trade); // stream got there first
    live.seed(seedTrades);
    for (const trade of trades.slice(35)) live.apply(trade);
    expect(live.current()).toEqual(foldTicks(trades, 10).at(-1));
  });

  it('notices trades the stream never delivered', () => {
    const live = new TickBars(10);
    live.seed(seedTrades);
    expect(live.apply(later[1] as AggTrade)).toBe('gap');
  });
});
