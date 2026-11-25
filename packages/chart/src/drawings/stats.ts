import type { DrawingStats } from '@tradingnerd/core';
import { angleOf, formatAngle, formatDuration, type Pt } from './geometry';

/**
 * A line's stats as TradingView's Info line shows them (Help Center, Info line drawing tool: "the
 * absolute price change, percentage change, distance in bars and time, and the angle"). The rows'
 * order and wording are a third-party capture of TradingView's (deepentropy/lightweight-charts-
 * drawing, MIT): "−12.5 (−1.02%), −1250", "40 bars (1d 21h 30m), distance: 312 px", "45º".
 * Provisional until measured from the user's screenshots (docs/SPEC.md §11).
 */

/** Which icon a row has: the price's, the bars', or the angle's. */
export type StatsIcon = 'price' | 'bars' | 'angle';

export interface StatsRow {
  icon: StatsIcon;
  text: string;
}

export interface StatsInput {
  /** The line's first and second points: their prices and times (UTC seconds). */
  from: { price: number; time: number };
  to: { price: number; time: number };
  /** The points on screen (CSS px). */
  a: Pt;
  b: Pt;
  /** Bars from the first point to the second (logical indexes apart). */
  bars: number;
  stats: DrawingStats;
  /** A price in its pane's format: "1.2955", "−0.0042". */
  formatPrice: (value: number) => string;
  /** One step of the price (a pip), for the change in pips. */
  tickSize: number;
}

const MINUS = '−';

/** A whole number, a true minus before a fall. */
const signedInteger = (value: number): string => {
  const rounded = Math.round(value);
  return rounded < 0 ? `${MINUS}${Math.abs(rounded)}` : String(rounded);
};

export function statsRows(input: StatsInput): StatsRow[] {
  const { from, to, a, b, stats } = input;
  const rows: StatsRow[] = [];
  const change = to.price - from.price;

  // Price: the change, the percent change (in brackets after the change) and the pips.
  let price = '';
  if (stats.priceRange) price = input.formatPrice(change);
  if (stats.percentChange && from.price !== 0) {
    const percent = (change / Math.abs(from.price)) * 100;
    const text = `${formatPercent(percent)}%`;
    price = price ? `${price} (${text})` : text;
  }
  if (stats.pips && input.tickSize > 0) {
    const pips = signedInteger(change / input.tickSize);
    price = price ? `${price}, ${pips}` : pips;
  }
  if (price) rows.push({ icon: 'price', text: price });

  // Bars and time: "40 bars (1d 21h 30m)", then the distance on screen.
  let span = '';
  if (stats.barsRange) span = `${Math.round(input.bars)} bars`;
  if (stats.dateTimeRange) {
    const time = formatDuration(to.time - from.time);
    span = span ? `${span} (${time})` : time;
  }
  if (stats.distance) {
    const distance = `distance: ${Math.round(Math.hypot(b.x - a.x, b.y - a.y))} px`;
    span = span ? `${span}, ${distance}` : distance;
  }
  if (span) rows.push({ icon: 'bars', text: span });

  if (stats.angle) rows.push({ icon: 'angle', text: formatAngle(angleOf(a, b)) });
  return rows;
}

/** A percentage with two decimals and a true minus: "1.02", "−0.48". */
function formatPercent(value: number): string {
  const text = Math.abs(value).toFixed(2);
  return value < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text;
}
