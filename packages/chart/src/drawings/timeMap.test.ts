import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { stepOf, TimeMap } from './timeMap';

const bar = (time: number, start?: number): Bar => ({
  time,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 0,
  ...(start === undefined ? {} : { start }),
});

describe('TimeMap', () => {
  // Hourly bars with a weekend-like gap between 3 and 4.
  const times = [0, 3_600, 7_200, 10_800, 180_000, 183_600];
  const map = new TimeMap(times, 3_600);

  it('puts a bar time on its own bar', () => {
    times.forEach((time, i) => {
      expect(map.logicalOf(time)).toBe(i);
      expect(map.timeOf(i)).toBe(time);
    });
  });

  it('puts a time between two bars between them, in proportion', () => {
    expect(map.logicalOf(1_800)).toBeCloseTo(0.5, 12);
    // Inside the gap: a quarter of the way from the bar before it to the bar after.
    expect(map.logicalOf(10_800 + (180_000 - 10_800) / 4)).toBeCloseTo(3.25, 12);
  });

  it('runs on past the last bar and before the first at the interval’s length', () => {
    expect(map.logicalOf(183_600 + 2 * 3_600)).toBe(7);
    expect(map.timeOf(8)).toBe(183_600 + 3 * 3_600);
    expect(map.logicalOf(-3_600)).toBe(-1);
    expect(map.timeOf(-2)).toBe(-7_200);
  });

  it('turns a logical index back into the time it came from', () => {
    for (const logical of [-3.5, 0, 0.25, 2.75, 3.5, 4.1, 5, 9.75]) {
      expect(map.logicalOf(map.timeOf(logical))).toBeCloseTo(logical, 9);
    }
  });

  it('has nothing to place without bars', () => {
    const empty = new TimeMap([], 60);
    expect(empty.length).toBe(0);
    expect(empty.logicalOf(100)).toBeNaN();
    expect(empty.timeOf(1)).toBeNaN();
  });

  it('takes a tick bar’s time from its first trade', () => {
    const ticks = TimeMap.fromBars([bar(1, 10_000), bar(2, 12_000), bar(3, 15_000)], {
      unit: 'tick',
      count: 100,
    });
    expect(ticks.logicalOf(12)).toBe(1);
    expect(ticks.logicalOf(15)).toBe(2);
  });
});

describe('stepOf', () => {
  it('is each interval’s length in seconds', () => {
    expect(stepOf({ unit: 'second', count: 5 })).toBe(5);
    expect(stepOf({ unit: 'minute', count: 15 })).toBe(900);
    expect(stepOf({ unit: 'minute', count: 240 })).toBe(14_400);
    expect(stepOf({ unit: 'day', count: 1 })).toBe(86_400);
    expect(stepOf({ unit: 'week', count: 1 })).toBe(604_800);
    expect(stepOf({ unit: 'month', count: 3 })).toBe(3 * 2_629_746);
  });

  it('spaces a tick chart’s future bars as its recent ones are spaced', () => {
    expect(stepOf({ unit: 'tick', count: 10 }, [0, 2, 4, 5, 7, 9])).toBe(2);
  });
});
