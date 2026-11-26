import { type Bar, defaultDrawingStyle } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { barRange, fitRegression, formatPearson, regressionParts } from './regression';

// Six bars, a day apart; the expected numbers were worked out apart from this code, with the
// textbook (uncentred) least-squares sums in Python (2026-11-26).
const closes = [10, 12, 11, 15, 14, 18];
const above = [1, 0.5, 2, 1, 0.5, 1];
const below = [1, 2, 0.5, 1, 1.5, 0.5];
const bars: Bar[] = closes.map((close, i) => ({
  time: 1_700_000_000 + i * 86_400,
  open: close,
  high: close + (above[i] as number),
  low: close - (below[i] as number),
  close,
  volume: 1,
}));
const settings = () => defaultDrawingStyle('regression-trend').regression;

describe('the bars a regression trend takes', () => {
  const times = [10, 20, 30, 40, 50];

  it('runs from the earlier point’s bar to the later’s, both included, either way round', () => {
    expect(barRange(times, 20, 40)).toEqual([1, 3]);
    expect(barRange(times, 45, 15)).toEqual([1, 3]);
    expect(barRange(times, 0, 100)).toEqual([0, 4]);
    expect(barRange(times, 50, 50)).toEqual([4, 4]);
  });

  it('is none when no bar falls between its points', () => {
    expect(barRange(times, 12, 18)).toBeNull();
    expect(barRange([], 0, 100)).toBeNull();
  });
});

describe('a regression trend’s line and bands', () => {
  it('fits the closes by least squares, its bands two sample deviations away', () => {
    const fit = fitRegression(bars, 0, 5, settings());
    expect(fit?.start).toBeCloseTo(9.761904761904761, 12);
    expect(fit?.end).toBeCloseTo(16.904761904761905, 12);
    expect(fit?.upper).toBeCloseTo(2.4688535993934697, 12);
    expect(fit?.lower).toBeCloseTo(-2.4688535993934697, 12);
    expect(fit?.pearson).toBeCloseTo(0.9078412990032037, 12);
  });

  it('reaches the highest high and the lowest low with its deviations off', () => {
    const own = settings();
    own.useUpperDeviation = false;
    own.useLowerDeviation = false;
    const fit = fitRegression(bars, 0, 5, own);
    expect(fit?.upper).toBeCloseTo(2.095238095238095, 12);
    expect(fit?.lower).toBeCloseTo(-2.9761904761904745, 12);
  });

  it('fits the source it’s set to', () => {
    const own = settings();
    own.source = 'hlc3';
    const fit = fitRegression(bars, 0, 5, own);
    expect(fit?.start).toBeCloseTo(9.674603174603174, 12);
    expect(fit?.end).toBeCloseTo(16.936507936507937, 12);
  });

  it('keeps its precision on large prices that hardly move', () => {
    const big = bars.map((bar) => ({
      ...bar,
      open: bar.open + 1e7,
      high: bar.high + 1e7,
      low: bar.low + 1e7,
      close: bar.close + 1e7,
    }));
    const fit = fitRegression(big, 0, 5, settings());
    expect(fit?.upper).toBeCloseTo(2.4688535993934697, 6);
    expect(fit?.pearson).toBeCloseTo(0.9078412990032037, 9);
  });

  it('has none under two bars, and a flat one no correlation', () => {
    expect(fitRegression(bars, 2, 2, settings())).toBeNull();
    const flat = bars.map((bar) => ({ ...bar, close: 5 }));
    const fit = fitRegression(flat, 0, 5, settings());
    expect([fit?.start, fit?.end, fit?.upper, fit?.pearson]).toEqual([5, 5, 0, 0]);
  });

  it('writes Pearson’s R with every digit', () => {
    expect(formatPearson(0.9078412990032037)).toBe('0.9078412990032037');
  });
});

describe('a regression trend on a pane', () => {
  const fit = fitRegression(bars, 0, 5, settings());
  const xOf = (index: number) => 100 + index * 10;
  const yOf = (price: number) => 500 - price * 10;
  const pane = { width: 400, height: 600 };
  if (!fit) throw new Error('no fit');

  it('draws its base line, its Up and Down lines, and its handles on the base line’s ends', () => {
    const parts = regressionParts(
      fit,
      xOf,
      yOf,
      defaultDrawingStyle('regression-trend'),
      pane,
      [1, 0],
    );
    expect(parts?.lines).toHaveLength(1);
    expect(parts?.lines[0]?.[0].x).toBe(100);
    expect(parts?.lines[0]?.[0].y).toBeCloseTo(402.380952381, 6);
    expect(parts?.lines[0]?.[1].x).toBe(150);
    expect(parts?.lines[0]?.[1].y).toBeCloseTo(330.952380952, 6);
    expect(parts?.looks.map((look) => [look.color, look.width, look.lineStyle])).toEqual([
      ['#2962FF', 2, 'solid'],
      ['#2962FF', 2, 'solid'],
    ]);
    expect(parts?.looks[0]?.a.y).toBeCloseTo(377.692416387, 6);
    // The later point first in the drawing: the range's first bar is its second point's.
    expect(parts?.handles.map((handle) => [handle.x, handle.point])).toEqual([
      [100, 1],
      [150, 0],
    ]);
  });

  it('fills Down to base in the base’s red and base to Up in Up’s blue, at 30%', () => {
    const parts = regressionParts(
      fit,
      xOf,
      yOf,
      defaultDrawingStyle('regression-trend'),
      pane,
      [0, 1],
    );
    expect(parts?.fills.map((fill) => fill.color)).toEqual(['#F23645', '#2962FF']);
    expect(parts?.fills[0]?.opacity).toBeCloseTo(77 / 255, 9);
  });

  it('writes Pearson’s R 4 px under the Down line’s start, in its color', () => {
    const label = regressionParts(
      fit,
      xOf,
      yOf,
      defaultDrawingStyle('regression-trend'),
      pane,
      [0, 1],
    )?.label;
    expect(label?.at.x).toBe(100);
    expect(label?.at.y).toBeCloseTo(431.069488375, 6);
    expect([label?.text, label?.color, label?.size]).toEqual(['0.9078412990032037', '#2962FF', 12]);
  });

  it('carries its lines to the pane’s right edge with Extend lines, and drops what’s turned off', () => {
    const style = defaultDrawingStyle('regression-trend');
    style.extendLines = true;
    style.lineVisible = false;
    style.regression.showPearsons = false;
    style.regression.up.visible = false;
    // A pane narrow enough that the rising Down line meets its right edge before its top.
    const parts = regressionParts(fit, xOf, yOf, style, { width: 200, height: 600 }, [0, 1]);
    expect(parts?.lines).toEqual([]);
    expect(parts?.looks).toHaveLength(1);
    expect(parts?.looks[0]?.b.x).toBe(204);
    expect(parts?.label).toBeNull();
    // Only the Down line and nothing above it: no band.
    expect(parts?.fills).toEqual([]);
  });
});
