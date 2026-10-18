import { describe, expect, it } from 'vitest';
import { type AggTrade, addTicks, foldTicks, tickBarOf } from './ticks.ts';

/** An aggregate of trades first…last at `price`, one unit each, `time` ms. */
const agg = (
  id: number,
  first: number,
  last: number,
  price: number,
  time = id * 100,
): AggTrade => ({
  id,
  firstId: first,
  lastId: last,
  price,
  quantity: last - first + 1,
  time,
});

describe('tick bars', () => {
  it('numbers bars by trade id', () => {
    expect(tickBarOf(0, 10)).toBe(0);
    expect(tickBarOf(9, 10)).toBe(0);
    expect(tickBarOf(10, 10)).toBe(1);
    expect(tickBarOf(1_736_985_092, 100)).toBe(17_369_850);
  });

  it('folds trades into bars of n ticks, splitting aggregates at bar edges', () => {
    const trades = [
      agg(1, 8, 9, 1.0),
      agg(2, 10, 14, 1.2),
      agg(3, 15, 22, 0.9),
      agg(4, 23, 23, 1.1),
    ];
    expect(foldTicks(trades, 10)).toEqual([
      { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 2, start: 100 },
      { time: 1, open: 1.2, high: 1.2, low: 0.9, close: 0.9, volume: 10, start: 200 },
      { time: 2, open: 0.9, high: 1.1, low: 0.9, close: 1.1, volume: 4, start: 300 },
    ]);
  });

  it('makes one bar per trade at 1 tick, even within a single aggregate', () => {
    const bars = foldTicks([agg(7, 100, 102, 2)], 1);
    expect(bars.map((bar) => [bar.time, bar.close, bar.volume, bar.start])).toEqual([
      [100, 2, 1, 700],
      [101, 2, 1, 700],
      [102, 2, 1, 700],
    ]);
  });

  it('counts only trades before the boundary', () => {
    const bars = foldTicks([agg(1, 0, 9, 1), agg(2, 10, 25, 2)], 10, 20);
    expect(bars.map((bar) => [bar.time, bar.volume])).toEqual([
      [0, 10],
      [1, 10],
    ]);
  });

  it('reports the bars each trade touched, and ignores trades older than the last bar', () => {
    const bars = foldTicks([agg(1, 0, 4, 1)], 5);
    const touched = addTicks(bars, agg(2, 5, 11, 3), 5);
    expect(touched.map((bar) => bar.time)).toEqual([1, 2]);
    expect(addTicks(bars, agg(3, 0, 0, 9), 5)).toEqual([]);
    expect(bars).toHaveLength(3);
  });
});
