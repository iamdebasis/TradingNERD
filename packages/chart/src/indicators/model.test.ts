import { defaultSettings, RSI, VOLUME } from '@tradingnerd/indicators';
import { LineStyle } from 'lightweight-charts';
import { describe, expect, it } from 'vitest';
import { luminance } from '../plugins/ValueLabelsPrimitive';
import {
  columnPoints,
  formatIndicatorValue,
  linePoints,
  lineStyleOf,
  NO_VALUE,
  paneAt,
  paneShares,
  plotShown,
  plotStart,
  stackLabels,
  withLevels,
  withOpacity,
} from './model';

describe("an indicator's values as TradingView writes them", () => {
  it('in fixed decimals, with a true minus sign', () => {
    expect(formatIndicatorValue(45.2349, { kind: 'decimals', decimals: 2 })).toBe('45.23');
    expect(formatIndicatorValue(-0.004, { kind: 'decimals', decimals: 2 })).toBe('0.00');
    expect(formatIndicatorValue(-3.5, { kind: 'decimals', decimals: 2 })).toBe('−3.50');
  });

  it('volumes in thousands to trillions', () => {
    expect(formatIndicatorValue(123_456_789, { kind: 'volume' })).toBe('123.46M');
    expect(formatIndicatorValue(950, { kind: 'volume' })).toBe('950');
  });

  it('a bar without a value as ∅', () => {
    expect(formatIndicatorValue(Number.NaN, { kind: 'volume' })).toBe(NO_VALUE);
    expect(NO_VALUE).toBe('∅');
  });
});

describe('colors and line styles', () => {
  it('turns a color and an opacity into CSS', () => {
    expect(withOpacity('#089981', 0.5)).toBe('rgba(8, 153, 129, 0.5)');
    expect(withOpacity('#7E57C2', 1)).toBe('#7E57C2');
  });

  it("maps the Style tab's dashes onto the library's", () => {
    expect(lineStyleOf({ visible: true, color: '#000000', opacity: 1, dash: 'dashed' })).toBe(
      LineStyle.Dashed,
    );
    expect(lineStyleOf({ visible: true, color: '#000000', opacity: 1, dash: 'dotted' })).toBe(
      LineStyle.Dotted,
    );
    expect(lineStyleOf({ visible: true, color: '#000000', opacity: 1 })).toBe(LineStyle.Solid);
  });

  it('knows light label colors from dark ones', () => {
    expect(luminance('#FDD835')).toBeGreaterThan(0.5); // RSI's MA: dark text
    expect(luminance('#7E57C2')).toBeLessThan(0.5); // RSI: white text
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 6);
  });
});

describe('the warm-up rule on the chart', () => {
  const inputs = defaultSettings(RSI).inputs;

  it('draws a plot once settled, or from the first bar at the listing', () => {
    expect(plotStart(RSI, 'rsi', inputs, false)).toBe(294);
    expect(plotStart(RSI, 'ma', inputs, false)).toBe(307);
    expect(plotStart(RSI, 'rsi', inputs, true)).toBe(0);
    expect(plotStart(VOLUME, 'volume', defaultSettings(VOLUME).inputs, false)).toBe(0);
  });

  it("never draws a plot these inputs don't have", () => {
    expect(plotStart(RSI, 'bbUpper', inputs, true)).toBe(Number.POSITIVE_INFINITY);
    expect(plotShown(RSI, 'bbUpper', inputs)).toBe(false);
    expect(plotShown(RSI, 'bbUpper', { ...inputs, maType: 'SMA + Bollinger Bands' })).toBe(true);
  });
});

describe('series points', () => {
  const times = [100, 200, 300, 400];

  it('start at the first drawn bar, with gaps where Pine has na', () => {
    expect(linePoints([1, Number.NaN, 3, 4], times, 1)).toEqual([
      { time: 200 },
      { time: 300, value: 3 },
      { time: 400, value: 4 },
    ]);
    expect(linePoints([1, 2, 3, 4], times, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('color columns by their bar', () => {
    const colors = { growing: 'g', falling: 'f' };
    expect(
      columnPoints([5, 6, Number.NaN, 8], [true, false, true, true], times, 0, colors),
    ).toEqual([
      { time: 100, value: 5, color: 'g' },
      { time: 200, value: 6, color: 'f' },
      { time: 300 },
      { time: 400, value: 8, color: 'g' },
    ]);
  });
});

describe("a pane's scale", () => {
  it('takes in its levels, as the RSI pane always shows 70 and 30', () => {
    expect(withLevels({ minValue: 40, maxValue: 60 }, [70, 50, 30])).toEqual({
      minValue: 30,
      maxValue: 70,
    });
    expect(withLevels({ minValue: 10, maxValue: 90 }, [70, 30])).toEqual({
      minValue: 10,
      maxValue: 90,
    });
    expect(withLevels(null, [70, 30])).toEqual({ minValue: 30, maxValue: 70 });
    expect(withLevels(null, [])).toBeNull();
  });
});

describe('value labels on the price axis', () => {
  it('keep their places when clear of each other', () => {
    expect(stackLabels([50, 100], 17, 300)).toEqual([50, 100]);
  });

  it('stack below the one above when they would cover it, in their own order', () => {
    expect(stackLabels([105, 100], 17, 300)).toEqual([117, 100]);
    expect(stackLabels([100, 101, 102], 17, 300)).toEqual([100, 117, 134]);
  });

  it('move back up from the bottom of the pane', () => {
    expect(stackLabels([290, 292], 17, 300)).toEqual([274.5, 291.5]);
  });
});

describe('panes', () => {
  const heights = [600, 150, 150];

  it('finds the pane under a point, past the 1 px separators', () => {
    expect(paneAt(10, heights)).toEqual({ index: 0, y: 10 });
    expect(paneAt(599, heights)).toEqual({ index: 0, y: 599 });
    expect(paneAt(600, heights)).toBeNull(); // the separator
    expect(paneAt(601, heights)).toEqual({ index: 1, y: 0 });
    expect(paneAt(752, heights)).toEqual({ index: 2, y: 0 });
    expect(paneAt(903, heights)).toBeNull(); // the time axis
  });

  it("keeps an indicator pane's height as a share of the price pane's", () => {
    expect(paneShares([1, 0.25])).toEqual([0.25]);
    expect(paneShares([0.8, 0.4, 0.2])).toEqual([0.5, 0.25]);
  });
});
