import { defaultSettings, IndicatorRun, RSI } from '@tradingnerd/indicators';
import { describe, expect, it } from 'vitest';
import { COLORS, colorHex, DEFAULT_SYMBOL, unpackColor } from './index.ts';
import { closes, firstDifference, indicator, plots, runScript, series, walk } from './testing.ts';

const NA = Number.NaN;
/** Ten bars with these closes; each bar opens at the close before, ±0.5 around them. */
const TEN = closes([10, 11, 12, 11, 13, 14, 12, 15, 16, 14]);
const WALK = walk(400);
const CLOSE = WALK.map((bar) => bar.close);
const HIGH = WALK.map((bar) => bar.high);
const LOW = WALK.map((bar) => bar.low);
const VOLUME = WALK.map((bar) => bar.volume);

// ---- the Pine v6 reference's formulas, written out plainly ----

const window = (x: readonly number[], i: number, n: number) => x.slice(i - n + 1, i + 1);
const mean = (x: readonly number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const over = (x: readonly number[], n: number, f: (w: number[]) => number) =>
  x.map((_, i) => (i < n - 1 ? NA : f(window(x, i, n))));
const sma = (x: readonly number[], n: number) => over(x, n, mean);

/** An average seeded with the SMA of the first n values, then alpha-weighted. */
function smoothed(x: readonly number[], n: number, alpha: number): number[] {
  const out: number[] = [];
  let value = NA;
  let seen: number[] = [];
  for (const v of x) {
    if (Number.isNaN(v)) {
      out.push(value);
      continue;
    }
    if (Number.isNaN(value)) {
      seen.push(v);
      if (seen.length === n) {
        value = mean(seen);
        seen = [];
      }
    } else value = alpha * v + (1 - alpha) * value;
    out.push(value);
  }
  return out;
}
const ema = (x: readonly number[], n: number) => smoothed(x, n, 2 / (n + 1));
const rma = (x: readonly number[], n: number) => smoothed(x, n, 1 / n);
const wma = (x: readonly number[], n: number) =>
  over(x, n, (w) => w.reduce((sum, v, k) => sum + v * (k + 1), 0) / ((n * (n + 1)) / 2));
const stdev = (x: readonly number[], n: number) =>
  over(x, n, (w) => Math.sqrt(mean(w.map((v) => (v - mean(w)) ** 2))));
const highest = (x: readonly number[], n: number) => over(x, n, (w) => Math.max(...w));
const lowest = (x: readonly number[], n: number) => over(x, n, (w) => Math.min(...w));
const back = (x: readonly number[], k: number) => x.map((_, i) => x[i - k] ?? NA);

const same = (body: string, expected: readonly number[], bars = WALK) =>
  expect(firstDifference(series(body, bars), expected, 1e-9)).toBe(-1);

describe('ta.* moving averages', () => {
  it('ta.sma, ta.ema, ta.rma and ta.wma follow the reference', () => {
    same('plot(ta.sma(close, 14))', sma(CLOSE, 14));
    same('plot(ta.ema(close, 9))', ema(CLOSE, 9));
    same('plot(ta.rma(close, 14))', rma(CLOSE, 14));
    same('plot(ta.wma(close, 10))', wma(CLOSE, 10));
  });

  it('ta.vwma weighs by volume: sma(source × volume) / sma(volume)', () => {
    const weighted = sma(
      CLOSE.map((c, i) => c * (VOLUME[i] as number)),
      5,
    );
    const volumes = sma(VOLUME, 5);
    same(
      'plot(ta.vwma(close, 5))',
      weighted.map((w, i) => w / (volumes[i] as number)),
    );
  });

  it('ta.swma weighs the last four by 1/6, 2/6, 2/6, 1/6', () => {
    const expected = CLOSE.map((c, i) =>
      i < 3
        ? NA
        : ((CLOSE[i - 3] as number) +
            2 * (CLOSE[i - 2] as number) +
            2 * (CLOSE[i - 1] as number) +
            c) /
          6,
    );
    same('plot(ta.swma(close))', expected);
  });

  it('ta.rsi matches the built-in RSI’s values', () => {
    const rsi = new IndicatorRun(
      RSI,
      { ...defaultSettings(RSI).inputs, maType: 'None' },
      { base: 'X', hasVolume: true },
    );
    rsi.setBars(WALK);
    same('plot(ta.rsi(close, 14))', rsi.values[0] as number[]);
  });
});

describe('ta.* over windows', () => {
  it('ta.highest and ta.lowest read high and low with one argument, a source with two', () => {
    same('plot(ta.highest(5))', highest(HIGH, 5));
    same('plot(ta.lowest(5))', lowest(LOW, 5));
    same('plot(ta.highest(close, 7))', highest(CLOSE, 7));
  });

  it('ta.highestbars and ta.lowestbars give the offset back, as a negative number', () => {
    expect(series('plot(ta.highestbars(close, 3))', TEN)).toEqual([
      NA,
      NA,
      0,
      -1,
      0,
      0,
      -1,
      0,
      0,
      -1,
    ]);
    expect(series('plot(ta.lowestbars(close, 3))', TEN)).toEqual([
      NA,
      NA,
      -2,
      0,
      -1,
      -2,
      0,
      -1,
      -2,
      0,
    ]);
  });

  it('ta.change, ta.mom and ta.roc compare with the value length bars back', () => {
    same(
      'plot(ta.change(close))',
      CLOSE.map((c, i) => c - (CLOSE[i - 1] ?? NA)),
    );
    same(
      'plot(ta.change(close, 3))',
      CLOSE.map((c, i) => c - (CLOSE[i - 3] ?? NA)),
    );
    same(
      'plot(ta.mom(close, 4))',
      CLOSE.map((c, i) => c - (CLOSE[i - 4] ?? NA)),
    );
    const before = back(CLOSE, 2);
    same(
      'plot(ta.roc(close, 2))',
      CLOSE.map((c, i) => (100 * (c - (before[i] as number))) / (before[i] as number)),
    );
  });

  it('ta.change of a bool is whether it changed', () => {
    expect(series('plot(ta.change(close > 12) ? 1 : 0)', TEN)).toEqual([
      0, 0, 0, 0, 1, 0, 1, 1, 0, 0,
    ]);
  });

  it('ta.stdev is the population’s unless biased = false, and ta.variance its square', () => {
    const sd = stdev(CLOSE, 10);
    same('plot(ta.stdev(close, 10))', sd);
    same(
      'plot(ta.stdev(close, 10, false))',
      sd.map((v) => v * Math.sqrt(10 / 9)),
    );
    same(
      'plot(ta.variance(close, 10))',
      sd.map((v) => v * v),
    );
  });

  it('ta.dev, ta.cci and ta.stoch follow the reference', () => {
    const dev = over(CLOSE, 8, (w) => mean(w.map((v) => Math.abs(v - mean(w)))));
    same('plot(ta.dev(close, 8))', dev);
    const average = sma(CLOSE, 8);
    same(
      'plot(ta.cci(close, 8))',
      CLOSE.map((c, i) => (c - (average[i] as number)) / (0.015 * (dev[i] as number))),
    );
    const hh = highest(HIGH, 6);
    const ll = lowest(LOW, 6);
    same(
      'plot(ta.stoch(close, high, low, 6))',
      CLOSE.map(
        (c, i) => (100 * (c - (ll[i] as number))) / ((hh[i] as number) - (ll[i] as number)),
      ),
    );
  });

  it('ta.bb and ta.macd return their three lines', () => {
    const [basis, upper, lower] = plots(
      indicator('[b, u, l] = ta.bb(close, 20, 2)\nplot(b)\nplot(u)\nplot(l)'),
      WALK,
    );
    const sd = stdev(CLOSE, 20);
    const middle = sma(CLOSE, 20);
    expect(firstDifference(basis as number[], middle, 1e-9)).toBe(-1);
    expect(
      firstDifference(
        upper as number[],
        middle.map((m, i) => m + 2 * (sd[i] as number)),
        1e-9,
      ),
    ).toBe(-1);
    expect(
      firstDifference(
        lower as number[],
        middle.map((m, i) => m - 2 * (sd[i] as number)),
        1e-9,
      ),
    ).toBe(-1);
    const [line, signal, hist] = plots(
      indicator('[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(m)\nplot(s)\nplot(h)'),
      WALK,
    );
    const fast = ema(CLOSE, 12);
    const slow = ema(CLOSE, 26);
    const macd = fast.map((f, i) => f - (slow[i] as number));
    expect(firstDifference(line as number[], macd, 1e-9)).toBe(-1);
    expect(firstDifference(signal as number[], ema(macd, 9), 1e-9)).toBe(-1);
    expect(
      firstDifference(
        hist as number[],
        macd.map((m, i) => m - (ema(macd, 9)[i] as number)),
        1e-9,
      ),
    ).toBe(-1);
  });

  it('math.sum is the sliding sum, ta.cum the running one', () => {
    same(
      'plot(math.sum(close, 3))',
      over(CLOSE, 3, (w) => w.reduce((a, b) => a + b, 0)),
    );
    let total = 0;
    same(
      'plot(ta.cum(close))',
      CLOSE.map((c) => (total += c)),
    );
  });

  it('ta.rising and ta.falling compare with each of the last length values', () => {
    expect(series('plot(ta.rising(close, 2) ? 1 : 0)', TEN)).toEqual([
      0, 0, 1, 0, 1, 1, 0, 1, 1, 0,
    ]);
    expect(series('plot(ta.falling(close, 1) ? 1 : 0)', TEN)).toEqual([
      0, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });

  it('ta.pivothigh and ta.pivotlow report a pivot right bars after it', () => {
    expect(series('plot(ta.pivothigh(close, 1, 1))', TEN)).toEqual([
      NA,
      NA,
      NA,
      12,
      NA,
      NA,
      14,
      NA,
      NA,
      16,
    ]);
    expect(series('plot(ta.pivotlow(close, 1, 1))', TEN)).toEqual([
      NA,
      NA,
      NA,
      NA,
      11,
      NA,
      NA,
      12,
      NA,
      NA,
    ]);
  });
});

describe('ta.* events', () => {
  const UPS = closes([1, 3, 2, 4, 1]);

  it('ta.crossover, ta.crossunder and ta.cross against the bar before', () => {
    expect(series('plot(ta.crossover(close, 2.5) ? 1 : 0)', UPS)).toEqual([0, 1, 0, 1, 0]);
    expect(series('plot(ta.crossunder(close, 2.5) ? 1 : 0)', UPS)).toEqual([0, 0, 1, 0, 1]);
    expect(series('plot(ta.cross(close, 2.5) ? 1 : 0)', UPS)).toEqual([0, 1, 1, 1, 1]);
  });

  it('ta.barssince counts from the condition’s last bar, na before it ever held', () => {
    expect(series('plot(ta.barssince(close > open))', TEN)).toEqual([
      NA,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
    ]);
  });

  it('ta.valuewhen gives the source at the nth latest occurrence', () => {
    expect(series('plot(ta.valuewhen(close > open, close, 0))', TEN)).toEqual([
      NA,
      11,
      12,
      12,
      13,
      14,
      14,
      15,
      16,
      16,
    ]);
    expect(series('plot(ta.valuewhen(close > open, close, 1))', TEN)).toEqual([
      NA,
      NA,
      11,
      11,
      12,
      13,
      13,
      14,
      15,
      15,
    ]);
  });

  it('ta.tr is na on the first bar unless handle_na, and ta.atr is its RMA', () => {
    const tr = TEN.map((bar, i) => {
      const before = TEN[i - 1]?.close;
      if (before === undefined) return bar.high - bar.low;
      return Math.max(bar.high - bar.low, Math.abs(bar.high - before), Math.abs(bar.low - before));
    });
    expect(series('plot(ta.tr)', TEN)).toEqual([NA, ...tr.slice(1)]);
    expect(series('plot(ta.tr(true))', TEN)).toEqual(tr);
    same('plot(ta.atr(3))', rma(tr, 3), TEN);
  });

  it('fixnan carries the last value; nz replaces na', () => {
    expect(series('plot(fixnan(close > 12 ? close : na))', TEN)).toEqual([
      NA,
      NA,
      NA,
      NA,
      13,
      14,
      14,
      15,
      16,
      14,
    ]);
    expect(series('plot(nz(close[1]))', TEN.slice(0, 2))).toEqual([0, 10]);
    expect(series('plot(nz(close[1], -1))', TEN.slice(0, 2))).toEqual([-1, 10]);
  });
});

describe('math.*', () => {
  const one = (body: string) => series(body, TEN.slice(0, 1))[0];

  it('rounds ties up, to a precision when asked (the reference)', () => {
    expect(one('plot(math.round(2.5))')).toBe(3);
    expect(one('plot(math.round(-2.5))')).toBe(-2);
    expect(one('plot(math.round(2.3456, 2))')).toBe(2.35);
  });

  it('gives na from math.max and math.min of na, and takes many numbers', () => {
    expect(one('plot(math.max(close, na))')).toBeNaN();
    expect(one('plot(math.max(1, 5, 3))')).toBe(5);
    expect(one('plot(math.min(4, 2, 8))')).toBe(2);
    expect(one('plot(math.avg(1, 2, 6))')).toBe(3);
  });

  it('has the usual functions and constants', () => {
    expect(one('plot(math.abs(-3) + math.floor(2.7) + math.ceil(2.1) + math.sign(-4))')).toBe(7);
    expect(one('plot(math.pow(2, 10) + math.sqrt(16))')).toBe(1028);
    expect(one('plot(math.round(math.pi * 1000))')).toBe(3142);
    expect(one('plot(math.round_to_mintick(10.006))')).toBeCloseTo(10.01, 10);
  });
});

describe('color.*', () => {
  it('has v6’s color constants (the v6 migration guide)', () => {
    expect(colorHex(COLORS.red as number)).toBe('#F23645');
    expect(colorHex(COLORS.teal as number)).toBe('#089981');
    expect(colorHex(COLORS.yellow as number)).toBe('#FDD835');
    expect(colorHex(COLORS.blue as number)).toBe('#2962FF');
  });

  it('makes colors with color.new and color.rgb, and reads them back', () => {
    const one = (body: string) => series(body, TEN.slice(0, 1))[0];
    expect(one('plot(color.t(color.new(color.red, 40)))')).toBe(40);
    expect(one('plot(color.r(color.rgb(10, 20, 30)) + color.g(#102030) + color.b(#102030))')).toBe(
      10 + 32 + 48,
    );
    expect(one('plot(color.t(color.rgb(1, 2, 3, 75)))')).toBe(75);
  });

  it('mixes color.from_gradient in a straight line', () => {
    const run = runScript(
      indicator('plot(close, color = color.from_gradient(5, 0, 10, #000000, #FFFFFF))'),
      TEN.slice(0, 1),
    );
    const color = run.plotColors[0]?.[0] as number;
    expect(unpackColor(color)).toEqual({ r: 128, g: 128, b: 128, t: 0 });
  });
});

describe('Bars, bar states and the symbol', () => {
  it('counts bar_index from our first bar, with last_bar_index the last', () => {
    expect(series('plot(bar_index)', TEN.slice(0, 3))).toEqual([0, 1, 2]);
    expect(series('plot(last_bar_index)', TEN.slice(0, 3))).toEqual([2, 2, 2]);
  });

  it('gives time in milliseconds', () => {
    expect(series('plot(time)', TEN.slice(0, 2))).toEqual([1_700_000_000_000, 1_700_000_060_000]);
  });

  it('knows the first and last bars, and that only the live bar isn’t confirmed', () => {
    expect(series('plot(barstate.isfirst ? 1 : 0)', TEN.slice(0, 3))).toEqual([1, 0, 0]);
    expect(series('plot(barstate.islast ? 1 : 0)', TEN.slice(0, 3))).toEqual([0, 0, 1]);
    expect(series('plot(barstate.isconfirmed ? 1 : 0)', TEN.slice(0, 3))).toEqual([1, 1, 0]);
    expect(series('plot(barstate.isrealtime ? 1 : 0)', TEN.slice(0, 3))).toEqual([0, 0, 1]);
    expect(series('plot(barstate.islastconfirmedhistory ? 1 : 0)', TEN.slice(0, 3))).toEqual([
      0, 1, 0,
    ]);
  });

  it('works out hl2, hlc3, ohlc4 and hlcc4 as Pine does', () => {
    const bar = TEN[0] as (typeof TEN)[number];
    const [a, b, c, d] = plots(indicator('plot(hl2)\nplot(hlc3)\nplot(ohlc4)\nplot(hlcc4)'), [bar]);
    expect(a).toEqual([(bar.high + bar.low) / 2]);
    expect(b).toEqual([(bar.high + bar.low + bar.close) / 3]);
    expect(c).toEqual([(bar.open + bar.high + bar.low + bar.close) / 4]);
    expect(d).toEqual([(bar.high + bar.low + 2 * bar.close) / 4]);
  });

  it('reads syminfo.* and timeframe.* from the chart’s symbol', () => {
    const symbol = { ...DEFAULT_SYMBOL, ticker: 'XRPUSDT', mintick: 0.0001, timeframe: '60' };
    const source = indicator(
      'plot(syminfo.ticker == "XRPUSDT" ? 1 : 0)\nplot(syminfo.mintick)\nplot(timeframe.isintraday ? timeframe.multiplier : -1)',
    );
    expect(plots(source, TEN.slice(0, 1), [], symbol)).toEqual([[1], [0.0001], [60]]);
  });

  it('gives na volume for a symbol without real volume', () => {
    const symbol = { ...DEFAULT_SYMBOL, hasVolume: false };
    expect(
      plots(indicator('plot(volume)\nplot(ta.vwma(close, 2))'), TEN.slice(0, 3), [], symbol),
    ).toEqual([
      [NA, NA, NA],
      [NA, NA, NA],
    ]);
  });
});
