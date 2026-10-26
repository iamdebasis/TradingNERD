import type {
  IndicatorDefinition,
  IndicatorKind,
  IndicatorSettings,
  Inputs,
  StyleValue,
  ValueFormat,
} from '@tradingnerd/indicators';
import { LineStyle, type Time, type UTCTimestamp } from 'lightweight-charts';
import { formatVolume } from '../format';

/** An indicator on the chart, as the app keeps it (docs/SPEC.md §6.16). */
export interface ChartIndicator {
  /** The instance's own id: its row in the legend. */
  id: string;
  kind: IndicatorKind;
  settings: IndicatorSettings;
  /** The legend's eye: a hidden indicator draws nothing, but keeps its pane. */
  hidden: boolean;
  /** Its pane's height as a share of the price pane's, for one with a pane of its own. */
  paneStretch?: number;
}

/**
 * A new indicator pane's height as a share of the price pane's: about a fifth of the chart with
 * one pane below the price (ours, provisional until measured from a screenshot, §11).
 */
export const NEW_PANE_STRETCH = 0.25;
/** The price pane's stretch factor; an indicator pane's is a share of it. */
export const PRICE_PANE_STRETCH = 1;
/**
 * Volume's place in the price pane: its bottom quarter, as the Charting Library's own example
 * draws it (provisional until measured, §11).
 */
export const VOLUME_MARGINS = { top: 0.75, bottom: 0 } as const;

/** TradingView's minus sign, as format.ts writes it. */
const MINUS = '−';

/**
 * What TradingView's legend writes for a value a bar doesn't have (Pine's na): ∅ (as we recall
 * its status line; not found in its docs, provisional until measured from a screenshot, §11).
 */
export const NO_VALUE = '∅';

/** An indicator's value as its legend and price axis write it: "45.23", "1.32M". */
export function formatIndicatorValue(value: number, format: ValueFormat): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  if (format.kind === 'volume') return formatVolume(value);
  const text = Math.abs(value).toFixed(format.decimals);
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text;
}

/** "#RRGGBB" at an opacity, as a CSS color. */
export function withOpacity(color: string, opacity: number): string {
  const value = Number.parseInt(color.slice(1, 7), 16);
  if (opacity >= 1) return color;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

export function lineStyleOf(style: StyleValue): LineStyle {
  switch (style.dash) {
    case 'dashed':
      return LineStyle.Dashed;
    case 'dotted':
      return LineStyle.Dotted;
    default:
      return LineStyle.Solid;
  }
}

/**
 * The first bar a plot is drawn from (the warm-up rule, docs/SPEC.md §6.16): where its value no
 * longer depends on bars we haven't loaded, or from the first bar when that bar is the pair's
 * listing, where TradingView's history starts too. Infinity for a plot these inputs don't have.
 */
export function plotStart(
  definition: IndicatorDefinition,
  plotId: string,
  inputs: Inputs,
  fromListing: boolean,
): number {
  const settled = definition.settledFrom(plotId, inputs);
  if (!Number.isFinite(settled)) return Number.POSITIVE_INFINITY;
  return fromListing ? 0 : settled;
}

/** Whether a plot exists for these inputs (the bands only with "SMA + Bollinger Bands"). */
export function plotShown(
  definition: IndicatorDefinition,
  plotId: string,
  inputs: Inputs,
): boolean {
  const spec = definition.plots.find((plot) => plot.id === plotId);
  return spec !== undefined && (spec.shownWhen?.(inputs) ?? true);
}

/** A point of a line: its value, or a gap where it has none (Pine's na breaks the line). */
export function linePoint(time: number, value: number): { time: Time; value?: number } {
  return Number.isFinite(value)
    ? { time: time as UTCTimestamp, value }
    : { time: time as UTCTimestamp };
}

/** A line's points from bar `start` on, at the chart's times. */
export function linePoints(
  values: readonly number[],
  times: readonly number[],
  start: number,
): { time: Time; value?: number }[] {
  const points: { time: Time; value?: number }[] = [];
  for (let i = Math.max(0, start); i < times.length; i++) {
    points.push(linePoint(times[i] as number, values[i] ?? Number.NaN));
  }
  return points;
}

/** A column's point: its value in its bar's direction color. */
export function columnPoint(
  time: number,
  value: number,
  growing: boolean,
  colors: { growing: string; falling: string },
): { time: Time; value?: number; color?: string } {
  if (!Number.isFinite(value)) return { time: time as UTCTimestamp };
  return {
    time: time as UTCTimestamp,
    value,
    color: growing ? colors.growing : colors.falling,
  };
}

export function columnPoints(
  values: readonly number[],
  growing: readonly boolean[],
  times: readonly number[],
  start: number,
  colors: { growing: string; falling: string },
): { time: Time; value?: number; color?: string }[] {
  const points: { time: Time; value?: number; color?: string }[] = [];
  for (let i = Math.max(0, start); i < times.length; i++) {
    points.push(
      columnPoint(times[i] as number, values[i] ?? Number.NaN, growing[i] ?? true, colors),
    );
  }
  return points;
}

/** A price range widened to take in every level shown (Pine's hlines count in the scale). */
export function withLevels(
  range: { minValue: number; maxValue: number } | null,
  levels: readonly number[],
): { minValue: number; maxValue: number } | null {
  if (levels.length === 0) return range;
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  if (!range) return { minValue: low, maxValue: high };
  return { minValue: Math.min(range.minValue, low), maxValue: Math.max(range.maxValue, high) };
}

/** A label on the price axis: its first row centered on `y` (pane px). */
export interface StackedLabel {
  y: number;
}

/**
 * Moves labels apart so none covers another, as TradingView keeps its value labels readable:
 * each keeps its place unless the one above it is in the way, then sits just below it; labels
 * pushed past the pane's bottom move back up. Returns the new ys, in the labels' order.
 */
export function stackLabels(ys: readonly number[], height: number, paneHeight: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    const above = order[k - 1] as { y: number };
    const label = order[k] as { y: number };
    if (label.y - above.y < height) label.y = above.y + height;
  }
  const last = order.at(-1);
  if (last && last.y > paneHeight - height / 2) {
    let floor = paneHeight - height / 2;
    for (let k = order.length - 1; k >= 0; k--) {
      const label = order[k] as { y: number };
      if (label.y <= floor) break;
      label.y = floor;
      floor -= height;
    }
  }
  const out = new Array<number>(ys.length);
  for (const { y, i } of order) out[i] = y;
  return out;
}

/** Which pane a chart y is in (CSS px from the chart's top), and the y inside it. */
export function paneAt(
  y: number,
  heights: readonly number[],
  separator = 1,
): { index: number; y: number } | null {
  let top = 0;
  for (const [index, height] of heights.entries()) {
    if (y >= top && y < top + height) return { index, y: y - top };
    top += height + separator;
  }
  return null;
}

/** Each indicator pane's share of the price pane's height, from the library's stretch factors. */
export function paneShares(factors: readonly number[]): number[] {
  const price = factors[0];
  if (!(price !== undefined && price > 0)) return factors.slice(1).map(() => NEW_PANE_STRETCH);
  return factors.slice(1).map((factor) => factor / price);
}
