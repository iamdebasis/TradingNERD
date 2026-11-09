import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import {
  boxSize,
  type ChartTypeInputs,
  chartTypeMaker,
  chartTypeProblem,
  extendsBars,
  kagiBars,
  lastAtr,
  lineBreakBars,
  pointFigureBars,
  renkoBars,
  settledFrom,
} from './chartTypes.ts';

/**
 * Renko, Line Break, Kagi and Point & Figure bars made from a symbol's own, worked by hand from
 * TradingView's construction rules (Help Center; chartTypes.ts).
 */

/** Hourly bars from `closes`: each opens at the close before, a point above and below its range. */
function barsOf(closes: readonly number[], volume = 10): Bar[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : (closes[i - 1] as number);
    return {
      time: i * 3600,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume,
    };
  });
}

/** A made bar as [time index, open, close]. */
const shape = (bars: readonly Bar[]) => bars.map((b) => [b.time / 3600, b.open, b.close]);

describe('Renko (Help Center: 1 box to go on, 2 to turn)', () => {
  const closes = [100, 104, 111, 125, 118, 99, 92, 85, 108];

  it('makes a brick a box past the last, and turns only two boxes back', () => {
    const bricks = renkoBars(barsOf(closes), 10);
    // 111 and 125 go on up; 99 is two boxes under 120, from the last brick's open; 108 isn't
    // two boxes over 90.
    expect(shape(bricks)).toEqual([
      [2, 100, 110],
      [3, 110, 120],
      [5, 110, 100],
      [7, 100, 90],
    ]);
    // Without wicks, the high and low are the open and close.
    expect(bricks.map((b) => [b.high, b.low])).toEqual([
      [110, 100],
      [120, 110],
      [110, 100],
      [100, 90],
    ]);
    // Each brick's volume is the source bars' since the brick before.
    expect(bricks.map((b) => b.volume)).toEqual([30, 10, 20, 20]);
  });

  it('adds wicks from real prices: a low under a brick going up, a high over one going down', () => {
    const bricks = renkoBars(barsOf(closes), 10, { wicks: true });
    // Up 100→110: the lows since the start reach 99. Down 110→100: the highs since reach 126.
    expect(bricks.map((b) => [b.high, b.low])).toEqual([
      [110, 99],
      [120, 110],
      [126, 100],
      [100, 90],
    ]);
  });

  it('makes several bricks from one bar, all at its time', () => {
    const bricks = renkoBars(barsOf([100, 135]), 10);
    expect(shape(bricks)).toEqual([
      [1, 100, 110],
      [1, 110, 120],
      [1, 120, 130],
    ]);
    expect(bricks.map((b) => b.volume)).toEqual([20, 0, 0]);
  });

  it('with the OHLC source, walks each bar through its open, high, low and close', () => {
    const bars: Bar[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      // Nearer its low: down to 95 first, then up to 125, then back to 101.
      { time: 3600, open: 100, high: 125, low: 95, close: 101, volume: 1 },
    ];
    expect(renkoBars(bars, 10)).toEqual([]);
    expect(shape(renkoBars(bars, 10, { ohlc: true }))).toEqual([
      [1, 100, 110],
      [1, 110, 120],
    ]);
  });
});

describe('Line Break (Help Center: a reversal passes the last lines’ extreme)', () => {
  it('goes on past the last line and turns past the extreme of the last three', () => {
    const closes = [100, 105, 103, 108, 110, 104, 101, 99, 106, 111];
    const lines = lineBreakBars(barsOf(closes), 3);
    // 104 and 101 stay inside the last three lines (100 to 110); 99 turns, from 108; 106 stays
    // inside 99 to 110; 111 turns up, from the down line's open.
    expect(shape(lines)).toEqual([
      [1, 100, 105],
      [3, 105, 108],
      [4, 108, 110],
      [7, 108, 99],
      [9, 108, 111],
    ]);
    expect(lines.map((b) => b.volume)).toEqual([20, 20, 10, 30, 20]);
  });

  it('with one line, turns as soon as the close passes the last line’s start', () => {
    // 101 stays inside the line from 100 to 105; 99 passes its start.
    const lines = lineBreakBars(barsOf([100, 105, 103, 101, 99]), 1);
    expect(shape(lines)).toEqual([
      [1, 100, 105],
      [4, 100, 99],
    ]);
  });
});

describe('Kagi', () => {
  it('grows a line while the price goes its way and turns after the reversal amount', () => {
    const closes = [100, 103, 106, 104, 101, 99, 97, 102, 103];
    const lines = kagiBars(barsOf(closes), 5);
    // The first line once the price is 5 from the first close; 101 is 5 under 106; the down
    // line grows to 97 and carries its time; 102 is 5 over 97, and the line grows to 103.
    expect(shape(lines)).toEqual([
      [2, 100, 106],
      [6, 106, 97],
      [8, 97, 103],
    ]);
    expect(lines.map((b) => b.volume)).toEqual([30, 40, 20]);
  });
});

describe('Point & Figure', () => {
  it('stacks X’s a box at a time and turns to O’s after the reversal’s boxes', () => {
    const closes = [100, 101.5, 103.2, 102, 100.4, 99.9, 101, 103.5];
    const columns = pointFigureBars(barsOf(closes), 1, 3, 'close');
    // X's from 101 to 103; 99.9 is three boxes under 103: O's from 102 down to 100; 103.5 is
    // three over 100: X's from 101 to 103. Each column carries the time it last grew.
    expect(shape(columns)).toEqual([
      [2, 101, 103],
      [5, 102, 100],
      [7, 101, 103],
    ]);
  });

  it('from highs and lows, a new high goes before a turn on the same bar', () => {
    const bars: Bar[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { time: 3600, open: 100, high: 102.5, low: 99.5, close: 102, volume: 1 },
      // Both a box higher and three boxes back: the X's grow.
      { time: 7200, open: 102, high: 103.2, low: 98.9, close: 99, volume: 1 },
    ];
    expect(shape(pointFigureBars(bars, 1, 3, 'hl'))).toEqual([[2, 101, 103]]);
  });
});

describe('box sizes (Help Center: ATR and percentages to the tick)', () => {
  const bars = barsOf([100, 102, 104, 106, 108, 110, 112, 114]);

  it('takes ATR as ta.atr has it at the last bar', () => {
    // Every true range is 4 (a 2-point move and a point each side) but the first's, 2: the seed
    // is the first three's mean, 10/3, and Wilder's average closes a third of the gap a bar.
    expect(lastAtr(bars, 3)).toBeCloseTo(4 - (2 / 3) ** 6, 10);
    expect(boxSize('ATR', 3, bars, 0.01)).toBeCloseTo(3.91, 10);
    expect(boxSize('ATR', 30, bars, 0.01)).toBeNaN();
  });

  it('takes a percentage of the last close, rounded to the tick', () => {
    expect(boxSize('PercentageLTP', 1.5, bars, 0.01)).toBeCloseTo(1.71, 10);
    expect(boxSize('PercentageLTP', 0.001, bars, 0.01)).toBe(0.01);
  });

  it('keeps a Traditional size as given', () => {
    expect(boxSize('Traditional', 2.345, bars, 0.01)).toBe(2.345);
  });
});

describe('settings that can’t make bars', () => {
  it('names what is wrong', () => {
    expect(
      chartTypeProblem('renko', { style: 'Fixed', param: 10, wicks: false, source: 'Close' }),
    ).toMatch(/Invalid Renko style "Fixed"/);
    expect(chartTypeProblem('renko', { style: 'ATR', param: 2.5, source: 'Close' })).toMatch(
      /ATR length must be a whole number/,
    );
    expect(chartTypeProblem('kagi', { style: 'Traditional', param: 0 })).toMatch(
      /Kagi's reversal must be above 0/,
    );
    expect(chartTypeProblem('linebreak', { lines: 0 })).toMatch(/number of lines/);
    expect(
      chartTypeProblem('pointfigure', { source: 'ohlc', style: 'ATR', param: 14, reversal: 3 }),
    ).toMatch(/Point & Figure source "ohlc"/);
    expect(
      chartTypeProblem('pointfigure', { source: 'hl', style: 'ATR', param: 14, reversal: 3 }),
    ).toBeNull();
  });
});

describe('where made bars are trusted from (the warm-up rule for them)', () => {
  it('from where bars made from a later start are the same to the end', () => {
    // Started at 104, the grid is 100's; a bar later at 106, 110's; just after the first brick,
    // at 125, 130's. Their bricks are ours from the brick to 130 and from the brick to 150 (each
    // check's first brick holds the volume since its own start): trusted from the fifth.
    const closes = [104, 106, 112, 125, 131, 145, 152, 165];
    const bars = barsOf(closes);
    const make = chartTypeMaker(
      'renko',
      { style: 'Traditional', param: 10, wicks: false, source: 'Close' },
      bars,
      0.01,
    );
    if (!make) throw new Error('no maker');
    const made = make(bars);
    expect(shape(made)[0]).toEqual([2, 100, 110]);
    expect(made).toHaveLength(6);
    expect(settledFrom(made, make, bars)).toBe(4);
  });

  it('settles with a box that adds up with rounding errors (whole numbers of boxes)', () => {
    // A seeded walk around 60,000 with a box of 323.56: bricks built from two starts must give
    // the same prices, which repeated adding of the box doesn't.
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let price = 60_000;
    const closes = Array.from({ length: 600 }, () => {
      price *= 1 + (rand() - 0.5) * 0.02;
      return price;
    });
    const bars = barsOf(closes);
    for (const type of ['renko', 'pointfigure'] as const) {
      const inputs: ChartTypeInputs =
        type === 'renko'
          ? { style: 'Traditional', param: 323.56, wicks: false, source: 'Close' }
          : { style: 'Traditional', param: 323.56, reversal: 3, source: 'hl' };
      const make = chartTypeMaker(type, inputs, bars, 0.01);
      if (!make) throw new Error('no maker');
      const made = make(bars);
      expect(made.length).toBeGreaterThan(20);
      expect(settledFrom(made, make, bars)).toBeLessThan(5);
    }
  });

  it('tells bars that go on from bars that changed before their end', () => {
    const a = renkoBars(barsOf([100, 111, 121]), 10);
    expect(extendsBars(a, renkoBars(barsOf([100, 111, 121, 131]), 10))).toBe(true);
    expect(extendsBars(a, renkoBars(barsOf([100, 111]), 10))).toBe(false);
  });
});
