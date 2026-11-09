import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { compileScript, DEFAULT_SYMBOL, ScriptRun, stillForming } from './index.ts';
import type { StrategyState } from './strategy.ts';
import { compileError, runScript } from './testing.ts';

/**
 * Strategies and their broker emulator, on the outcomes the Pine manual describes (Strategies:
 * Orders and trades, Order types, Order placement and cancellation, Position sizing, Closing a
 * market position, OCA groups, Simulating trading costs, Altering calculation behavior).
 */

const DAY = 86_400;
const T0 = 1_700_000_000;

/** Bars from [open, high, low, close] rows. */
const ohlc = (rows: [number, number, number, number][]): Bar[] =>
  rows.map(([open, high, low, close], i) => ({
    time: T0 + i * DAY,
    open,
    high,
    low,
    close,
    volume: 1,
  }));

/** Quiet bars around 100: each opens at 100 + i % 3 and moves a point either way. */
const flat = (n: number): Bar[] =>
  ohlc(
    Array.from({ length: n }, (_, i) => [
      100 + (i % 3),
      101 + (i % 3),
      99 + (i % 3),
      100 + (i % 3),
    ]),
  );

const strategy = (body: string, declaration = 'strategy("Test", overlay = true)') =>
  `//@version=6\n${declaration}\n${body}`;

function run(body: string, bars: Bar[], declaration?: string): StrategyState {
  const r = runScript(strategy(body, declaration), bars);
  if (r.error) throw new Error(`Runtime error on bar ${r.error.bar}: ${r.error.message}`);
  return r.strategy as StrategyState;
}

const fills = (s: StrategyState) => s.fills.map((f) => [f.bar, f.qty, f.price, f.name]);

describe('orders and trades (the manual: Orders and trades)', () => {
  it('fills an order placed on a bar’s close at the next bar’s open', () => {
    const s = run(
      'if bar_index % 20 == 0\n    strategy.entry("My Long Entry Id", strategy.long)\nstrategy.close_all()',
      flat(45),
    );
    // Placed on bar 0, filled at bar 1's open; closed by close_all() placed on bar 1, at bar 2's open.
    expect(fills(s).slice(0, 2)).toEqual([
      [1, 1, 101, 'My Long Entry Id'],
      [2, -1, 102, 'Close position order'],
    ]);
    expect(s.closed).toHaveLength(3);
    expect(s.closed[0]).toMatchObject({
      entryBar: 1,
      exitBar: 2,
      entryPrice: 101,
      exitPrice: 102,
      profit: 1,
    });
  });

  it('reverses an opposite position: the transaction is the new size plus the open one', () => {
    // "the size of the resulting transaction is the specified entry size plus 15 shares".
    const s = run(
      `if bar_index % 10 == 0
    strategy.entry("Buy", strategy.long, qty = 15)
else if bar_index % 5 == 0
    strategy.entry("Sell", strategy.short, qty = 5)`,
      // The last order, placed on bar 15, fills on bar 16.
      flat(17),
    );
    expect(s.fills.map((f) => f.qty)).toEqual([15, -20, 20, -20]);
    expect(s.fills.map((f) => f.position)).toEqual([15, -5, 15, -5]);
  });

  it('allows one entry per direction unless pyramiding allows more', () => {
    const body = 'if bar_index % 5 == 0\n    strategy.entry("Long", strategy.long)';
    expect(run(body, flat(30)).open).toHaveLength(1);
    const pyramid = run(body, flat(30), 'strategy("Test", pyramiding = 4)');
    expect(pyramid.open).toHaveLength(4);
  });

  it('nets strategy.order() with the position: no reversal, no pyramiding', () => {
    // The manual's: long 15 every 100 bars, short 5 on every 25th, so 15 − 5 × 3 = 0.
    const s = run(
      `if bar_index % 20 == 0
    strategy.order("buy", strategy.long, 15)
else if bar_index % 5 == 0
    strategy.order("sell", strategy.short, 5)`,
      flat(20),
    );
    expect(s.fills.map((f) => f.position)).toEqual([15, 10, 5, 0]);
  });
});

describe('order types (the manual: Order types)', () => {
  it('fills a limit order below the market where the price reaches it, mid-bar', () => {
    const bars = ohlc([
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [100, 100, 95, 96],
      [96, 98, 95, 97],
    ]);
    const s = run('if bar_index == 0\n    strategy.entry("Long", strategy.long, limit = 97)', bars);
    expect(fills(s)).toEqual([[2, 1, 97, 'Long']]);
  });

  it('fills a limit order already better than the market at the next open', () => {
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long, limit = 110)',
      flat(3),
    );
    expect(fills(s)).toEqual([[1, 1, 101, 'Long']]);
  });

  it('fills a stop order where the price crosses it, and at the open when it gaps past', () => {
    const bars = ohlc([
      [100, 101, 99, 100],
      [100, 103, 99, 102],
      [106, 107, 105, 106],
    ]);
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long, stop = 102.5)',
      bars,
    );
    expect(fills(s)).toEqual([[1, 1, 102.5, 'Long']]);
    const gap = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long, stop = 104)',
      bars,
    );
    expect(fills(gap)).toEqual([[2, 1, 106, 'Long']]);
  });

  it('turns a stop-limit into a limit once its stop is reached', () => {
    // Up to the stop (105) on bar 1, then down to the limit (102) on bar 2.
    const bars = ohlc([
      [100, 101, 99, 100],
      [100, 106, 103, 104],
      [104, 105, 101, 103],
    ]);
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long, stop = 105, limit = 102)',
      bars,
    );
    expect(fills(s)).toEqual([[2, 1, 102, 'Long']]);
  });

  it('walks open → high → low → close when the open is nearer the high', () => {
    // A long bracket both of whose levels the bar reaches: the high comes first, so the
    // take-profit fills (the manual: Broker emulator).
    const bars = ohlc([
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [101, 106, 94, 100],
    ]);
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long)\nstrategy.exit("Exit", "Long", limit = 105, stop = 95)',
      bars,
    );
    expect(s.closed[0]?.exitPrice).toBe(105);
    // Nearer the low: the stop fills first.
    bars[2] = { ...(bars[2] as Bar), open: 96 };
    const down = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long)\nstrategy.exit("Exit", "Long", limit = 105, stop = 95)',
      bars,
    );
    expect(down.closed[0]?.exitPrice).toBe(95);
  });
});

describe('exits (the manual: strategy.exit())', () => {
  const up = ohlc(Array.from({ length: 12 }, (_, i) => [100 + i, 101.5 + i, 99.5 + i, 101 + i]));

  it('takes profit and stops loss in ticks from the entry price', () => {
    // mintick 0.01: profit = 300 ticks is 3 points above the 101 entry.
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long)\nstrategy.exit("Exit", "Long", profit = 300, loss = 300)',
      up,
    );
    expect(s.closed[0]).toMatchObject({ entryPrice: 101, exitPrice: 104, exitId: 'Exit' });
  });

  it('exits a part with qty, the second call reduced to what is left (multi-level exits)', () => {
    const s = run(
      `if bar_index == 0
    strategy.entry("buy", strategy.long, qty = 2)
strategy.exit("exit1", "buy", qty = 1, profit = 100)
strategy.exit("exit2", "buy", qty = 3, profit = 300)`,
      up,
    );
    expect(s.fills.map((f) => [f.qty, f.name])).toEqual([
      [2, 'buy'],
      [-1, 'exit1'],
      [-1, 'exit2'],
    ]);
  });

  it('keeps what an earlier exit call reserved: the later one exits only the rest', () => {
    // "the 'stop' order only reduces the position by one share".
    const down = ohlc(Array.from({ length: 8 }, (_, i) => [100 - i, 101 - i, 98.5 - i, 99 - i]));
    const s = run(
      `if bar_index == 0
    strategy.entry("buy", strategy.long, qty = 20)
    strategy.exit("limit", "buy", qty = 19, limit = 200)
    strategy.exit("stop", "buy", qty = 20, stop = 97)`,
      down,
    );
    expect(s.fills.map((f) => f.qty)).toEqual([20, -1]);
    expect(s.open[0]?.size).toBe(19);
  });

  it('trails a stop behind the best price once the market reaches its activation level', () => {
    const bars = ohlc([
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [100, 105, 100, 104],
      [104, 108, 104, 107],
      [107, 107, 101, 102],
    ]);
    // Active from 103 (300 ticks above the 100 entry), 200 ticks behind the best price.
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long)\nstrategy.exit("Trail", "Long", trail_points = 300, trail_offset = 200)',
      bars,
    );
    // Best 108 on bar 3, so the stop is at 106, hit as bar 4 falls.
    expect(s.closed[0]).toMatchObject({ exitBar: 4, exitPrice: 106 });
  });

  it('refuses a v6 strategy.exit() that sets no level (the v6 migration guide)', () => {
    expect(compileError(strategy('strategy.exit("x", "y")')).message).toMatch(/at least one/);
  });
});

describe('closing, cancelling and OCA groups', () => {
  it('closes oldest trades first: strategy.close("Buy2") takes Buy1’s units first (FIFO)', () => {
    const body = `if bar_index == 0
    strategy.entry("Buy1", strategy.long, qty = 5)
if bar_index == 1
    strategy.entry("Buy2", strategy.long, qty = 10)
if bar_index == 2
    strategy.close("Buy2")`;
    const fifo = run(body, flat(5), 'strategy("Test", pyramiding = 2)');
    expect(fifo.closed.map((t) => [t.entryId, t.size])).toEqual([
      ['Buy1', 5],
      ['Buy2', 5],
    ]);
    expect(fifo.open.map((t) => [t.entryId, t.size])).toEqual([['Buy2', 5]]);
    const any = run(body, flat(5), 'strategy("Test", pyramiding = 2, close_entries_rule = "ANY")');
    expect(any.closed.map((t) => [t.entryId, t.size])).toEqual([['Buy2', 10]]);
  });

  it('cancels a resting order before it fills', () => {
    const s = run(
      'if bar_index == 0\n    strategy.entry("buy", strategy.long, limit = 50)\nif bar_index == 1\n    strategy.cancel("buy")',
      ohlc([
        [100, 101, 99, 100],
        [100, 101, 99, 100],
        [100, 101, 40, 45],
      ]),
    );
    expect(s.fills).toEqual([]);
  });

  it('cancels the rest of an OCA group when one of its orders fills', () => {
    const bars = ohlc([
      [100, 101, 99, 100],
      [100, 103, 97, 98],
    ]);
    const body = (oca: string) => `if bar_index == 0
    strategy.order("Long", strategy.long, 1, stop = 102${oca})
    strategy.order("Short", strategy.short, 1, stop = 98${oca})`;
    // Open nearer the... equal distance: up first, so Long fills, then Short brings it back to 0.
    expect(run(body(''), bars).fills.map((f) => f.name)).toEqual(['Long', 'Short']);
    const oca = run(body(', oca_name = "Entry", oca_type = strategy.oca.cancel'), bars);
    expect(oca.fills.map((f) => f.name)).toEqual(['Long']);
  });
});

describe('sizes, costs and calculation settings', () => {
  it('sizes an order from a share of equity at the price it fills at', () => {
    // 10% of 1,000,000 at 101: 990.09900990 units of a crypto pair (8 decimals, provisional).
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long)',
      flat(3),
      'strategy("Test", default_qty_type = strategy.percent_of_equity, default_qty_value = 10)',
    );
    expect(s.fills[0]?.qty).toBe(990.0990099);
  });

  it('takes a commission off each trade’s profit', () => {
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long, qty = 10)\nif bar_index == 1\n    strategy.close("Long")',
      flat(4),
      'strategy("Test", commission_type = strategy.commission.cash_per_order, commission_value = 2)',
    );
    // Bought at 101, sold at 102: 10 profit, less 2 on each side.
    expect(s.closed[0]?.profit).toBe(6);
    expect(s.figures.commission).toBe(4);
  });

  it('adds slippage to market fills, against the trade', () => {
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long)',
      flat(3),
      'strategy("Test", slippage = 20)',
    );
    expect(s.fills[0]?.price).toBeCloseTo(101.2);
  });

  it('fills market orders on the bar’s own close with process_orders_on_close', () => {
    const s = run(
      'if bar_index == 0\n    strategy.entry("Long", strategy.long)',
      flat(3),
      'strategy("Test", process_orders_on_close = true)',
    );
    expect(fills(s)).toEqual([[0, 1, 100, 'Long']]);
  });
});

describe('strategy.* in the script', () => {
  it('reads the position, the trades and the figures as the run goes', () => {
    const r = runScript(
      strategy(`if bar_index % 4 == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index % 4 == 2
    strategy.close("L")
plot(strategy.position_size)
plot(strategy.closedtrades)
plot(strategy.netprofit)
plot(strategy.closedtrades > 0 ? strategy.closedtrades.exit_price(strategy.closedtrades - 1) : na)`),
      // A tenth bar is the live one: the strategy runs on it once it closes.
      flat(10),
    );
    expect(r.error).toBeNull();
    const at = (p: number) => Array.from(r.values[p] ?? []).slice(0, 9);
    expect(at(0)).toEqual([0, 2, 2, 0, 0, 2, 2, 0, 0]);
    expect(at(1)).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2]);
    // Entries at 101 and 102 (bars 1 and 5), exits at 100 and 101 (bars 3 and 7): −2 each.
    expect(at(2)[8]).toBe(-4);
    expect(at(3)[3]).toBe(100);
  });

  it('refuses strategy commands in an indicator', () => {
    const message = compileError(
      '//@version=6\nindicator("x")\nstrategy.entry("L", strategy.long)\nplot(close)',
    ).message;
    expect(message).toMatch(/only be used in a strategy/);
  });

  it('runs v4’s strategy.entry(id, long, when = …) and strategy.close(id, when)', () => {
    const r = runScript(
      `//@version=4
strategy("Old")
strategy.entry("L", strategy.long, when = bar_index == 0)
strategy.close("L", bar_index == 2)
plot(strategy.position_size)`,
      // A sixth bar is the live one.
      flat(6),
    );
    expect(r.error).toBeNull();
    expect(Array.from(r.values[0] ?? []).slice(0, 5)).toEqual([0, 1, 1, 0, 0]);
  });

  it('takes v5’s text in strategy.close_all()’s first place as its comment (when dropped)', () => {
    const r = runScript(
      `//@version=5
strategy("Old")
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.close_all("Long Exit")
plot(strategy.position_size)`,
      flat(5),
    );
    expect(r.error).toBeNull();
    expect(r.strategy?.fills.map((f) => f.name)).toEqual(['L', 'Long Exit']);
  });

  it('keeps one fill for the live bar however often it updates', () => {
    const bars = flat(6);
    const r = runScript(
      strategy('if bar_index == 4\n    strategy.entry("L", strategy.long)'),
      bars,
    );
    expect(r.strategy?.fills).toHaveLength(1);
    const ticked = bars.map((b, i) => (i === 5 ? { ...b, close: 150, high: 150 } : b));
    r.update(ticked, 'tick', 5);
    r.update(ticked, 'tick', 5);
    expect(r.strategy?.fills).toHaveLength(1);
  });
});

describe('the realtime bar (the manual: Altering calculation behavior)', () => {
  /** Bar 5 is live; a sixth opens after it. */
  const bars = flat(6);
  const next = [
    ...bars,
    ...ohlc([[101, 102, 100, 101]]).map((b) => ({ ...b, time: T0 + 6 * DAY })),
  ];

  it('runs a strategy on a realtime bar only once it closes', () => {
    const r = runScript(strategy('plot(close)'), bars);
    expect(r.error).toBeNull();
    const plot = () => Array.from(r.values[0] as Float64Array).slice(0, r.length);
    // "the script only executes on a realtime bar after it closes".
    expect(plot()[4]).toBe(101);
    expect(plot()[5]).toBeNaN();
    r.update(next, 'new', 6);
    expect(plot()[5]).toBe(102);
    expect(plot()[6]).toBeNaN();
  });

  it('runs on every tick with calc_on_every_tick, as an indicator does', () => {
    const r = runScript(
      strategy('plot(close)', 'strategy("Test", overlay = true, calc_on_every_tick = true)'),
      bars,
    );
    expect((r.values[0] as Float64Array)[5]).toBe(102);
  });

  it('fills a stop order on a live tick while the script waits for the close', () => {
    const r = runScript(
      strategy(
        'if bar_index == 4\n    strategy.entry("L", strategy.long, stop = 110)\nplot(strategy.position_size)',
      ),
      bars,
    );
    expect(r.strategy?.fills).toHaveLength(0);
    // The live bar reaches 115: the stop fills at 110, though the script hasn't run on it.
    const ticked = bars.map((b, i) => (i === 5 ? { ...b, high: 115, close: 114 } : b));
    r.update(ticked, 'tick', 5);
    expect(r.strategy?.fills.map((f) => [f.bar, f.qty, f.price])).toEqual([[5, 1, 110]]);
    expect((r.values[0] as Float64Array)[5]).toBeNaN();
    // Once it closes, the script runs on it and sees the position.
    r.update([...ticked, ...next.slice(6)], 'new', 6);
    expect((r.values[0] as Float64Array)[5]).toBe(1);
  });

  it('calculates on a closed market’s last bar: it is history', () => {
    const result = compileScript(strategy('plot(close)'));
    if (!result.ok) throw new Error(result.errors[0]?.message);
    const r = new ScriptRun(result.program, result.program.defaults());
    r.setBars(bars, true, false);
    expect((r.values[0] as Float64Array)[5]).toBe(102);
  });

  it('tells a forming bar from one whose time is past by the symbol’s clock', () => {
    const symbol = { ...DEFAULT_SYMBOL, timeframe: '1D' };
    const bar = bars[5] as Bar;
    const opens = bar.time * 1000;
    expect(stillForming(symbol, bar, opens + 3_600_000)).toBe(true);
    expect(stillForming(symbol, bar, opens + 86_400_000)).toBe(false);
    expect(stillForming({ ...symbol, timeframe: '1T' }, bar, opens + 86_400_000 * 9)).toBe(true);
  });
});

describe('order fill alerts’ details (the manual: Alerts, Order fill events)', () => {
  it('keeps each fill’s order id, comment and alert_message', () => {
    const s = run(
      `if bar_index == 1
    strategy.entry("Long", strategy.long, alert_message = "Bought at " + str.tostring(close))
if bar_index == 3
    strategy.close("Long", comment = "Done", alert_message = "Sold")`,
      flat(6),
    );
    expect(s.fills.map((f) => [f.id, f.comment, f.alertMessage, f.qty])).toEqual([
      ['Long', '', 'Bought at 101', 1],
      ['Long', 'Done', 'Sold', -1],
    ]);
  });
});
