import type { Bar } from '@tradingnerd/core';

/**
 * TradingView's magnet (Help Center, Drawing points don't snap to OHLC values correctly): "Weak
 * Magnet pulls the drawing points to chart values (bars) when you are drawing near them", and
 * Strong Magnet "regardless of the distance between the points and chart values". Holding
 * Ctrl (⌘ on a Mac) turns it off for the moment, or on when it's off (TradingView blog, Drawing
 * on the chart just got easier).
 */
export type MagnetMode = 'weak' | 'strong';

/** How near a bar's price the pointer must be for the weak magnet, CSS px (provisional, §11). */
export const WEAK_MAGNET_PX = 12;

/**
 * The open, high, low or close of `bar` nearest the pointer's height, or null when the weak
 * magnet finds none near enough.
 */
export function magnetPrice(
  bar: Bar,
  y: number,
  priceToY: (price: number) => number | null,
  mode: MagnetMode,
): number | null {
  let best: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const price of [bar.open, bar.high, bar.low, bar.close]) {
    const at = priceToY(price);
    if (at === null) continue;
    const gap = Math.abs(at - y);
    if (gap < distance) {
      best = price;
      distance = gap;
    }
  }
  if (best === null) return null;
  return mode === 'strong' || distance <= WEAK_MAGNET_PX ? best : null;
}
