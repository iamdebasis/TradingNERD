import {
  type Bar,
  MarketSchedule,
  parseResolution,
  type Resolution,
  sessionClock,
  UTC_CLOCK,
} from '@tradingnerd/core';
import { NYSE_2026 } from '@tradingnerd/core/testing';
import { describe, expect, it } from 'vitest';
import { LabelObject, LineObject, PolylineObject, TableObject } from './drawings.ts';
import type { ContextData } from './requests.ts';
import { DEFAULT_SYMBOL, type LogEntry, type ScriptSymbol } from './runtime.ts';
import type { StrategyState, Trade } from './strategy.ts';
import { walk } from './testing.ts';
import {
  contextFromWire,
  packBars,
  packedCount,
  shiftDrawings,
  shiftError,
  shiftLogs,
  shiftStarts,
  shiftStrategy,
  shiftValues,
  symbolFromWire,
  unpackBars,
  wireContext,
  wireSymbol,
  writeTail,
} from './wire.ts';

/** Node's structuredClone, the same algorithm a worker's messages go through (MDN). */
declare function structuredClone<T>(value: T): T;

/**
 * What crosses to a script's worker (docs/SPEC.md §6.23): plain data, made back into the same
 * bars, symbols and contexts there, and the results moved when older bars load.
 */

const US_STOCK: ScriptSymbol = {
  ...DEFAULT_SYMBOL,
  ticker: 'AAPL',
  tickerid: 'NASDAQ:AAPL',
  type: 'stock',
  currency: 'USD',
  timeframe: '60',
  timezone: 'America/New_York',
  session: 'extended',
  schedule: new MarketSchedule(NYSE_2026),
  clock: sessionClock(new MarketSchedule(NYSE_2026), 'extended'),
};

describe('bars for a worker', () => {
  it('pack into numbers and come back as the same bars, a tick bar’s start with them', () => {
    const bars: Bar[] = [...walk(3), { ...(walk(1, 3)[0] as Bar), start: 1_700_000_180_250 }];
    const packed = packBars(bars);
    expect(packedCount(packed)).toBe(4);
    const back = unpackBars(structuredClone(packed));
    expect(back).toEqual(bars);
    // Bars without a start keep none, as the gateway sends them.
    expect('start' in (back[0] as Bar)).toBe(false);
  });

  it('pack a range, and write the last bars over a list, growing it by a new bar', () => {
    const bars = walk(5);
    const tail = walk(3, 3).map((bar) => ({ ...bar, close: bar.close + 1 }));
    const into = walk(5);
    writeTail(into, 3, packBars([...tail.slice(0, 2), tail[2] as Bar]));
    expect(into).toHaveLength(6);
    expect(into.slice(0, 3)).toEqual(bars.slice(0, 3));
    expect(into.slice(3)).toEqual(tail);
    expect(unpackBars(packBars(bars, 1, 3))).toEqual(bars.slice(1, 3));
  });
});

describe('symbols for a worker', () => {
  it('give a stock’s calendar and clock made again, with the same bar times', () => {
    const wire = structuredClone(wireSymbol(US_STOCK));
    const back = symbolFromWire(wire);
    expect({ ...back, clock: null, schedule: null }).toEqual({
      ...US_STOCK,
      clock: null,
      schedule: null,
    });
    expect(back.schedule?.data).toEqual(NYSE_2026);
    // Every hour of a week around Thanksgiving (a holiday and a 13:00 close), on three timeframes.
    const start = Date.UTC(2026, 10, 23);
    for (const text of ['60', '1D', '1W']) {
      const resolution = parseResolution(text) as Resolution;
      for (let ms = start; ms < start + 7 * 86_400_000; ms += 3_600_000) {
        const open = US_STOCK.clock.open(resolution, ms);
        expect(back.clock.open(resolution, ms)).toBe(open);
        expect(back.clock.close(resolution, open)).toBe(US_STOCK.clock.close(resolution, open));
        expect(back.clock.isOpen(ms)).toBe(US_STOCK.clock.isOpen(ms));
      }
    }
  });

  it('give crypto UTC’s clock, and refuse a clock with no calendar to make it from', () => {
    const back = symbolFromWire(structuredClone(wireSymbol(DEFAULT_SYMBOL)));
    expect(back.clock).toBe(UTC_CLOCK);
    expect(back.schedule).toBeNull();
    const odd = { ...DEFAULT_SYMBOL, clock: { ...UTC_CLOCK } };
    expect(() => wireSymbol(odd)).toThrow(/no calendar/);
  });
});

describe('contexts for a worker', () => {
  it('come back with their bars, state and symbol, and a warm-up only where they had one', () => {
    const data: ContextData = {
      symbol: US_STOCK,
      bars: walk(4),
      live: true,
      fromListing: false,
      version: 7,
      history: 3,
    };
    const back = contextFromWire(structuredClone(wireContext(data)));
    expect(back.bars).toEqual(data.bars);
    expect({ ...back, bars: [], symbol: null }).toEqual({ ...data, bars: [], symbol: null });
    expect('warmup' in back).toBe(false);
    expect(
      back.symbol.clock.open(parseResolution('60') as Resolution, Date.UTC(2026, 10, 24, 15)),
    ).toBe(US_STOCK.clock.open(parseResolution('60') as Resolution, Date.UTC(2026, 10, 24, 15)));
    const made = contextFromWire(wireContext({ ...data, warmup: 12 }));
    expect(made.warmup).toBe(12);
  });
});

describe('results moved by older bars', () => {
  it('put NaN before the values, and move the starts drawn from (Infinity stays)', () => {
    const values = new Float64Array([1, 2, 3]);
    expect(Array.from(shiftValues(values, 2))).toEqual([Number.NaN, Number.NaN, 1, 2, 3]);
    expect(shiftValues(values, 0)).toBe(values);
    expect(shiftStarts([0, 5, Number.POSITIVE_INFINITY], 3)).toEqual([
      3,
      8,
      Number.POSITIVE_INFINITY,
    ]);
  });

  it('move drawings placed by bar_index, and leave those placed by bar_time', () => {
    const label = Object.assign(new LabelObject(), { x: 4 });
    const timed = Object.assign(new LabelObject(), { x: 1_700_000_000_000, xloc: 'bar_time' });
    const line = Object.assign(new LineObject(), { x1: 2, x2: 6 });
    const poly = Object.assign(new PolylineObject(), {
      points: [
        { x: 1, y: 10 },
        { x: 3, y: 12 },
      ],
    });
    const table = new TableObject();
    const moved = shiftDrawings(
      {
        labels: [label, timed],
        lines: [line],
        boxes: [],
        tables: [table],
        polylines: [poly],
        linefills: [{ id: 9, line1: line, line2: line, color: 0 }],
      },
      10,
    );
    expect(moved.labels.map((l) => l.x)).toEqual([14, 1_700_000_000_000]);
    expect(moved.lines.map((l) => [l.x1, l.x2])).toEqual([[12, 16]]);
    expect(moved.polylines[0]?.points.map((p) => p.x)).toEqual([11, 13]);
    expect(moved.linefills[0]?.line1.x1).toBe(12);
    expect(moved.tables[0]).toBe(table);
    // The run's own copies stay as they were.
    expect(label.x).toBe(4);
  });

  it('move a strategy’s trades, fills and first and last bars; none (-1) stays none', () => {
    const trade = { entryOrderBar: 2, entryBar: 3, exitBar: -1 } as Trade;
    const state = {
      open: [trade],
      closed: [{ ...trade, exitBar: 5 }],
      fills: [{ bar: 3 }],
      firstBar: 0,
      lastBar: 9,
    } as unknown as StrategyState;
    const moved = shiftStrategy(state, 4);
    expect(moved.open[0]).toMatchObject({ entryOrderBar: 6, entryBar: 7, exitBar: -1 });
    expect(moved.closed[0]?.exitBar).toBe(9);
    expect(moved.fills[0]?.bar).toBe(7);
    expect([moved.firstBar, moved.lastBar]).toEqual([4, 13]);
  });

  it('move Pine Logs entries and a runtime error to their bars', () => {
    const logs = [{ bar: 2 }, { bar: 5 }] as LogEntry[];
    expect(shiftLogs(logs, 3).map((entry) => entry.bar)).toEqual([5, 8]);
    expect(shiftError({ message: 'x', span: null, bar: 4 }, 3)?.bar).toBe(7);
    expect(shiftError(null, 3)).toBeNull();
  });
});
