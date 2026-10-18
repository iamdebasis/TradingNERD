import { describe, expect, it } from 'vitest';
import type { Bar } from './market.ts';
import { maxBasePerBar, nestsIn, resampleBars, resampleBase } from './resample.ts';
import { formatResolution, parseResolution, type Resolution } from './resolution.ts';

const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(`bad resolution ${text}`);
  return resolution;
};

/** Binance's native intervals. */
const NATIVES = ['1S', '1', '3', '5', '15', '30', '60', '120', '240', '360', '480', '720']
  .concat(['1D', '3D', '1W', '1M'])
  .map(r);

const sec = (iso: string) => Date.parse(iso) / 1000;

/** A bar with distinct values: open i, high i+0.5, low i-0.5, close i+0.25, volume 1. */
const bar = (iso: string, i: number): Bar => ({
  time: sec(iso),
  open: i,
  high: i + 0.5,
  low: i - 0.5,
  close: i + 0.25,
  volume: 1,
});

describe('nestsIn', () => {
  it.each([
    ['1', '2', true],
    ['5', '10', true],
    ['15', '45', true],
    ['30', '45', false],
    ['60', '180', true],
    ['120', '180', false],
    ['1S', '45S', true],
    ['1', '7', true],
    ['1D', '1W', true],
    ['3D', '1W', false],
    ['1W', '2W', true],
    ['1D', '3D', true],
    ['3D', '6D', true],
    ['1D', '1M', true],
    ['1W', '1M', false],
    ['1M', '3M', true],
    ['1M', '12M', true],
    ['720', '1D', true],
    ['7', '14', false], // 7-minute bars don't fit a day evenly, so they can't be a base
  ])('%s → %s: %s', (base, target, expected) => {
    expect(nestsIn(r(base), r(target))).toBe(expected);
  });

  it('never builds ticks from time bars or the reverse', () => {
    expect(nestsIn(r('1'), r('10T'))).toBe(false);
    expect(nestsIn(r('1T'), r('10T'))).toBe(false);
  });
});

describe('resampleBase', () => {
  it.each([
    ['2', '1'],
    ['10', '5'],
    ['45', '15'],
    ['90', '30'],
    ['7', '1'],
    ['180', '60'],
    ['600', '120'],
    ['1440', '720'],
    ['5S', '1S'],
    ['45S', '1S'],
    ['2D', '1D'],
    ['6D', '3D'],
    ['2W', '1W'],
    ['3M', '1M'],
    ['6M', '1M'],
    ['12M', '1M'],
  ])('builds %s from %s, the coarsest native interval that fits', (target, base) => {
    const found = resampleBase(r(target), NATIVES);
    expect(found && formatResolution(found)).toBe(base);
  });

  it('has nothing to offer for ticks', () => {
    expect(resampleBase(r('100T'), NATIVES)).toBeNull();
  });
});

describe('maxBasePerBar', () => {
  it.each([
    ['1', '2', 2],
    ['15', '45', 3],
    ['1S', '45S', 45],
    ['60', '180', 3],
    ['1D', '1W', 7],
    ['1M', '12M', 12],
    ['1D', '1M', 31],
    ['1D', '3M', 93],
  ])('%s per %s: %i', (base, target, expected) => {
    expect(maxBasePerBar(r(base), r(target))).toBe(expected);
  });
});

describe('resampleBars', () => {
  it('folds base bars into OHLCV bars', () => {
    const bars = [
      bar('2026-10-18T10:00:00Z', 1),
      bar('2026-10-18T10:01:00Z', 2),
      bar('2026-10-18T10:02:00Z', 3),
      bar('2026-10-18T10:03:00Z', 4),
      bar('2026-10-18T10:04:00Z', 5),
    ];
    expect(resampleBars(bars, r('2'))).toEqual([
      { time: sec('2026-10-18T10:00:00Z'), open: 1, high: 2.5, low: 0.5, close: 2.25, volume: 2 },
      { time: sec('2026-10-18T10:02:00Z'), open: 3, high: 4.5, low: 2.5, close: 4.25, volume: 2 },
      { time: sec('2026-10-18T10:04:00Z'), open: 5, high: 5.5, low: 4.5, close: 5.25, volume: 1 },
    ]);
  });

  it('restarts intraday bars at midnight, cutting the day short when they do not fit', () => {
    // 7-minute bars: the last one of the day opens 23:55 and lasts 5 minutes.
    const bars = ['23:53', '23:54', '23:55', '23:59'].map((t, i) => bar(`2026-10-17T${t}:00Z`, i));
    bars.push(bar('2026-10-18T00:00:00Z', 9));
    expect(resampleBars(bars, r('7')).map((b) => [b.time, b.open, b.close])).toEqual([
      [sec('2026-10-17T23:48:00Z'), 0, 1.25],
      [sec('2026-10-17T23:55:00Z'), 2, 3.25],
      [sec('2026-10-18T00:00:00Z'), 9, 9.25],
    ]);
  });

  it('starts weeks on Monday and multi-month bars in January', () => {
    // Sunday 2026-10-11, Monday 2026-10-12 → two weekly bars.
    const days = [bar('2026-10-11T00:00:00Z', 1), bar('2026-10-12T00:00:00Z', 2)];
    expect(resampleBars(days, r('1W')).map((b) => b.time)).toEqual([
      sec('2026-10-05T00:00:00Z'),
      sec('2026-10-12T00:00:00Z'),
    ]);
    const months = Array.from({ length: 14 }, (_, i) =>
      bar(new Date(Date.UTC(2025, i, 1)).toISOString(), i),
    );
    expect(resampleBars(months, r('6M')).map((b) => [b.time, b.open, b.close])).toEqual([
      [sec('2025-01-01T00:00:00Z'), 0, 5.25],
      [sec('2025-07-01T00:00:00Z'), 6, 11.25],
      [sec('2026-01-01T00:00:00Z'), 12, 13.25],
    ]);
    expect(resampleBars(months, r('12M')).map((b) => b.time)).toEqual([
      sec('2025-01-01T00:00:00Z'),
      sec('2026-01-01T00:00:00Z'),
    ]);
  });

  it('ignores bars without trades, unless nothing traded in the whole period', () => {
    const flat = (iso: string, price: number): Bar => ({
      time: sec(iso),
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    });
    const bars = [
      flat('2026-10-18T10:00:00Z', 1.3), // placeholder at the previous close
      { ...bar('2026-10-18T10:00:01Z', 2), volume: 3 },
      flat('2026-10-18T10:00:02Z', 2.25),
      { ...bar('2026-10-18T10:00:03Z', 4), volume: 1 },
      flat('2026-10-18T10:00:05Z', 4.25), // a 5-second bar with no trades at all
      flat('2026-10-18T10:00:06Z', 4.25),
    ];
    expect(resampleBars(bars, r('5S'))).toEqual([
      { time: sec('2026-10-18T10:00:00Z'), open: 2, high: 4.5, low: 1.5, close: 4.25, volume: 4 },
      {
        time: sec('2026-10-18T10:00:05Z'),
        open: 4.25,
        high: 4.25,
        low: 4.25,
        close: 4.25,
        volume: 0,
      },
    ]);
  });

  it('gives the same bars whichever nesting base they are built from', () => {
    const minutes = Array.from({ length: 24 * 60 * 2 }, (_, i) => {
      const t = Date.UTC(2026, 9, 17) + i * 60_000;
      const wave = Math.sin(i / 37) * 10 + i / 100;
      return {
        time: t / 1000,
        open: wave,
        high: wave + 1,
        low: wave - 1,
        close: wave + 0.5,
        volume: 1,
      };
    });
    const direct = resampleBars(minutes, r('45'));
    const viaFifteen = resampleBars(resampleBars(minutes, r('15')), r('45'));
    expect(viaFifteen).toEqual(direct);
    expect(resampleBars(resampleBars(minutes, r('60')), r('1D'))).toEqual(
      resampleBars(minutes, r('1D')),
    );
  });
});
