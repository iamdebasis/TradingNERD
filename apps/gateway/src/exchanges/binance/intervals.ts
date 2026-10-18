import { formatResolution, type Resolution } from '@tradingnerd/core';

/**
 * TradingView resolution → Binance kline interval, shortest first, for the intervals Binance
 * serves natively. A list rather than an object: object keys like "1" and "60" would be
 * reordered ahead of "1S".
 */
const PAIRS: readonly (readonly [resolution: string, interval: string])[] = [
  ['1S', '1s'],
  ['1', '1m'],
  ['3', '3m'],
  ['5', '5m'],
  ['15', '15m'],
  ['30', '30m'],
  ['60', '1h'],
  ['120', '2h'],
  ['240', '4h'],
  ['360', '6h'],
  ['480', '8h'],
  ['720', '12h'],
  ['1D', '1d'],
  ['3D', '3d'],
  ['1W', '1w'],
  ['1M', '1M'],
];

/** Resolutions Binance serves natively, shortest first. */
export const BINANCE_RESOLUTIONS: readonly string[] = PAIRS.map(([resolution]) => resolution);

const INTERVAL_BY_RESOLUTION = new Map(PAIRS);

export function binanceInterval(resolution: Resolution): string | null {
  return INTERVAL_BY_RESOLUTION.get(formatResolution(resolution)) ?? null;
}
