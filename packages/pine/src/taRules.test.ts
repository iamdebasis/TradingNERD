import { describe, expect, it } from 'vitest';
import { closes, series } from './testing.ts';

/**
 * The ta.* rules TradingView's reference doesn't state, each matched to TradingView's own
 * values: PineTS's published BINANCE:BTCUSDT 1h data (third-party, checked 2026-11-01:
 * docs/SPEC.md §4.17). Each test's numbers are small and our own, chosen so that the obvious
 * other reading gives another value.
 */

const NA = Number.NaN;

describe('a call inside an if or a ternary', () => {
  // Calls on bars 0, 2 and 4.
  const bars = closes([10, 11, 12, 13, 14, 15]);
  const even = (call: string) =>
    series(`float v = na\nif bar_index % 2 == 0\n    v := ${call}\nplot(v)`, bars);

  it('reads ta.change’s source by bar, a skipped bar repeating the last call’s value', () => {
    // On bar 4, two bars back is bar 2's call, through bar 3's repeat of it: 14 − 12.
    expect(even('ta.change(close, 2)')[4]).toBe(2);
  });

  it('keeps ta.sma over the calls themselves', () => {
    // The calls' values 10, 12, 14 (not 14, 12, 12 by bar).
    expect(even('ta.sma(close, 3)')[4]).toBe(12);
  });

  it('counts ta.highestbars in bars back to the highest call', () => {
    const v = series(
      'float v = na\nif bar_index % 2 == 0\n    v := ta.highestbars(close, 2)\nplot(v)',
      closes([5, 1, 3, 1, 2]),
    );
    // On bar 2 the calls are 3 and 5; 5 was bar 0's: two bars back, not one call back.
    expect(v[2]).toBe(-2);
  });

  it('finds a pivot only at the call made rightbars bars back', () => {
    // Bar 3 skips the call, so bar 2's 5 has no call the bar after it: no pivot.
    const v = series(
      'float v = na\nif bar_index != 3\n    v := ta.pivothigh(close, 1, 1)\nplot(v)',
      closes([1, 2, 5, 2, 1, 0]),
    );
    expect(v[4]).toBeNaN();
    // At the top level the same closes have their pivot.
    expect(series('plot(ta.pivothigh(close, 1, 1))', closes([1, 2, 5, 2, 1, 0]))[3]).toBe(5);
  });
});

describe('a call run several times on one bar, in a loop', () => {
  it('re-evaluates the bar each time, the last run counting', () => {
    const v = series(
      'float s = 0.0\nfor i = 0 to 1\n    s += nz(ta.sma(close + i * 10, 2))\nplot(s)',
      closes([10, 11, 12]),
    );
    // Bar 1: (20 + 11) / 2 + (20 + 21) / 2, bar 0 keeping only its last run's 20.
    expect(v[1]).toBe(36);
  });

  it('gives ta.percentile_* every run’s value', () => {
    const v = series(
      'float s = 0.0\nfor i = 0 to 1\n    s := ta.percentile_nearest_rank(close + i * 10, 2, 0)\nplot(s)',
      // A third bar, so bar 1 is a closed one (the live bar's runs don't commit).
      closes([10, 11, 12]),
    );
    // Its window on bar 1's second run: 21 and that bar's first run's 11, so the smallest is 11
    // (re-evaluating the bar would give 20, bar 0's last run).
    expect(v[1]).toBe(11);
  });
});

describe('na in a window', () => {
  const g = (body: string, values: number[]) =>
    series(`g = bar_index == 2 ? na : close\n${body}`, closes(values));

  it('compares a cross with the last bar where both weren’t na', () => {
    const v = series(
      'g = bar_index == 1 ? na : close\nplot(ta.crossover(g, 10) ? 1 : 0)',
      closes([9, 50, 11]),
    );
    expect(v).toEqual([0, 0, 1]);
  });

  it('gives na from ta.ema and ta.cum on an na bar, then goes on as before', () => {
    const ema = g('plot(ta.ema(g, 2))', [10, 12, 99, 14]);
    expect(ema[2]).toBeNaN();
    // Seeded with the SMA 11 on bar 1, then 2/3 × 14 + 1/3 × 11 on bar 3.
    expect(ema[3]).toBeCloseTo(13, 12);
    expect(g('plot(ta.cum(g))', [1, 2, 99, 4])).toEqual([1, 3, NA, 7]);
  });

  it('gives ta.percentrank 0 on an na bar', () => {
    expect(g('plot(ta.percentrank(g, 2))', [1, 2, 99, 4])[2]).toBe(0);
  });

  it('repeats ta.stoch’s last value on a flat range when the source is on it', () => {
    const v = series('plot(ta.stoch(close, 5.0, 5.0, 1))', closes([5, 5]));
    expect(v[1]).toBeNaN();
    const w = series('plot(ta.stoch(close, high, low, 2))', closes([10, 12, 11]));
    expect(w[2]).toBeCloseTo((100 * (11 - 9.5)) / (12.5 - 9.5), 12);
  });
});

describe('percentiles and volume series', () => {
  it('interpolates percentiles at percentage / 100 × length − 0.5', () => {
    // 1, 2, 3, 4 at 30%: position 0.7 → 1.7 (the (n − 1)·p reading would give 1.9).
    expect(
      series('plot(ta.percentile_linear_interpolation(close, 4, 30))', closes([4, 2, 1, 3]))[3],
    ).toBeCloseTo(1.7, 12);
  });

  it('keeps ta.obv on every bar, so ta.obv[k] is right inside a ternary too', () => {
    const bars = closes([10, 12, 11, 13, 15, 14]);
    const top = series('plot(ta.obv - ta.obv[2])', bars);
    const inside = series('plot(bar_index % 2 == 1 ? ta.obv - ta.obv[2] : na)', bars);
    expect(inside[3]).toBe(top[3]);
    expect(inside[5]).toBe(top[5]);
  });

  it('multiplies ta.iii by the volume, as TradingView does', () => {
    const bars = closes([10, 12]);
    const bar = bars[1] as (typeof bars)[number];
    const want = ((2 * bar.close - bar.high - bar.low) / (bar.high - bar.low)) * bar.volume;
    expect(series('plot(ta.iii)', bars)[1]).toBeCloseTo(want, 12);
  });

  it('starts ta.vwap afresh each session, and an na source makes it na until then', () => {
    // Hourly bars across midnight UTC.
    const start = Date.UTC(2024, 0, 1, 22) / 1000;
    const bars = [10, 20, 30, 40].map((close, i) => ({
      time: start + i * 3600,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
    }));
    expect(series('plot(ta.vwap(close))', bars)).toEqual([10, 15, 30, 35]);
    expect(series('g = bar_index == 0 ? na : close\nplot(ta.vwap(g))', bars)).toEqual([
      NA,
      NA,
      30,
      35,
    ]);
  });
});
