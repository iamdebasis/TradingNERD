import type { Bar, DrawingStyle } from '@tradingnerd/core';
import { sourceValue } from '@tradingnerd/indicators';
import { FILL_REACH, lineSegment, opacityOf, type Pt, type Size } from './geometry';
import type { FillArea, LookLine, PartHandle, ShapeParts } from './parts';

/**
 * TradingView's Regression trend (docs/SPEC.md §6.24, milestone D2): a least-squares line
 * through the source price of every bar from its first point's bar to its second's, both
 * included, and lines a number of standard deviations above and below it (Help Center,
 * Regression trend: "upper and lower bands … a user defined number of standard deviations away
 * from a base line"). TradingView doesn't say which deviation; this is the residuals' sample
 * deviation (n − 1), as its Linear Regression Channel indicator's and the third-party capture's
 * (deepentropy/lightweight-charts-drawing, MIT). With Use upper (lower) deviation off, the band
 * reaches the highest high (lowest low) instead, as that indicator's does. Provisional until
 * measured against the user's screenshot (§11).
 */

/** A regression over a range of bars: its line's prices at the range's ends, and its bands. */
export interface RegressionFit {
  /** The range's first and last bars, as indexes into the chart's bars. */
  from: number;
  to: number;
  /** The line's price at the first bar and at the last. */
  start: number;
  end: number;
  /** The Up and Down lines' offsets from the line, in price (the Down's negative below it). */
  upper: number;
  lower: number;
  /** Pearson's correlation of the prices with their bars' order, −1 to 1. */
  pearson: number;
}

/** The bars from the earlier time to the later, both included (indexes; `times` oldest first). */
export function barRange(
  times: readonly number[],
  t0: number,
  t1: number,
): [number, number] | null {
  const low = Math.min(t0, t1);
  const high = Math.max(t0, t1);
  // The first time at or after `low`, and the last at or before `high`.
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) < low) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  lo = 0;
  hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= high) lo = mid + 1;
    else hi = mid;
  }
  const to = lo - 1;
  return from <= to ? [from, to] : null;
}

/**
 * The regression through bars `from` to `to` (indexes, both included) of the drawing's source:
 * x is each bar's place in the range, y its price. Null for fewer than two bars.
 */
export function fitRegression(
  bars: readonly Bar[],
  from: number,
  to: number,
  settings: DrawingStyle['regression'],
): RegressionFit | null {
  const n = to - from + 1;
  if (n < 2 || from < 0 || to >= bars.length) return null;
  const ys = new Float64Array(n);
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const y = sourceValue(bars[from + i] as Bar, settings.source);
    ys[i] = y;
    sumY += y;
  }
  // Centred sums, so large prices with small moves keep their precision.
  const meanX = (n - 1) / 2;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = (ys[i] as number) - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxy / sxx;
  const at = (i: number) => meanY + slope * (i - meanX);
  let squares = 0;
  let aboveHigh = Number.NEGATIVE_INFINITY;
  let belowLow = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const base = at(i);
    const residual = (ys[i] as number) - base;
    squares += residual * residual;
    const bar = bars[from + i] as Bar;
    aboveHigh = Math.max(aboveHigh, bar.high - base);
    belowLow = Math.max(belowLow, base - bar.low);
  }
  const deviation = Math.sqrt(squares / (n - 1));
  return {
    from,
    to,
    start: at(0),
    end: at(n - 1),
    upper: settings.useUpperDeviation ? settings.upperDeviation * deviation : aboveHigh,
    lower: settings.useLowerDeviation ? settings.lowerDeviation * deviation : -belowLow,
    pearson: syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0,
  };
}

/** Pearson's R as TradingView writes it under the drawing: every digit (the capture's; §11). */
export function formatPearson(r: number): string {
  return String(r);
}

/**
 * A fitted regression on a pane: its base line (the main look, unless turned off), its Up and
 * Down lines in their own looks, carried to the pane's right edge with Extend lines; the band
 * from each line to the next one up filled in that upper line's color at the background's
 * opacity (Help Center: Base sets "the lower channel background"); Pearson's R 4 px under the
 * Down line's start in its color, 12 px; and a handle at each end of the base line. `order`
 * names the drawing's points at the range's first bar and its last. Null where the range's ends
 * can't be placed.
 */
export function regressionParts(
  fit: RegressionFit,
  xOf: (index: number) => number | null,
  yOf: (price: number) => number | null,
  style: DrawingStyle,
  size: Size,
  order: [number, number],
): ShapeParts | null {
  const x0 = xOf(fit.from);
  const x1 = xOf(fit.to);
  if (x0 === null || x1 === null) return null;
  const pointAt = (x: number, price: number): Pt | null => {
    const y = yOf(price);
    return y === null ? null : { x, y };
  };
  const ends = (offset: number) => {
    const a = pointAt(x0, fit.start + offset);
    const b = pointAt(x1, fit.end + offset);
    return a && b ? ([a, b] as [Pt, Pt]) : null;
  };
  const { regression } = style;
  const lineOf = (offset: number, margin?: number) => {
    const at = ends(offset);
    return at ? lineSegment(at[0], at[1], false, style.extendLines, size, margin) : null;
  };
  const base = ends(0);
  if (!base) return null;
  // Bottom to top: Down, base, Up, each shown or not; each band takes its upper line's color.
  const rows = [
    { offset: fit.lower, shown: regression.down.visible, color: regression.down.color },
    { offset: 0, shown: style.lineVisible, color: style.color },
    { offset: fit.upper, shown: regression.up.visible, color: regression.up.color },
  ]
    .filter((row) => row.shown)
    .sort((a, b) => a.offset - b.offset);
  const fills: FillArea[] = [];
  if (style.fill.on) {
    const opacity = opacityOf(style.fill.color);
    for (let i = 1; i < rows.length; i++) {
      const low = lineOf((rows[i - 1] as (typeof rows)[number]).offset, FILL_REACH);
      const row = rows[i] as (typeof rows)[number];
      const high = lineOf(row.offset, FILL_REACH);
      if (low && high) {
        fills.push({ points: [low[0], low[1], high[1], high[0]], color: row.color, opacity });
      }
    }
  }
  const lines: [Pt, Pt][] = [];
  const baseLine = lineOf(0);
  if (style.lineVisible && baseLine) lines.push(baseLine);
  const looks: LookLine[] = [];
  for (const [offset, look] of [
    [fit.upper, regression.up],
    [fit.lower, regression.down],
  ] as const) {
    const line = lineOf(offset);
    if (look.visible && line) {
      looks.push({
        a: line[0],
        b: line[1],
        color: look.color,
        width: look.width,
        lineStyle: look.lineStyle,
      });
    }
  }
  const handles: PartHandle[] = [
    { ...base[0], point: order[0], square: false },
    { ...base[1], point: order[1], square: false },
  ];
  const downStart = pointAt(x0, fit.start + fit.lower);
  const label =
    regression.showPearsons && downStart
      ? {
          at: { x: downStart.x, y: downStart.y + 4 },
          text: formatPearson(fit.pearson),
          color: regression.down.color,
          size: 12,
        }
      : null;
  return { lines, looks, fills, fillsTakeClicks: false, handles, frame: null, label };
}
