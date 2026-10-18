import { formatResolution, parseResolution, parseSymbolId } from '@tradingnerd/core';

export const DEFAULT_SYMBOL = 'BINANCE:XRPUSDT';
export const DEFAULT_RESOLUTION = '1D';

export interface ChartRoute {
  symbol: string;
  resolution: string;
}

/**
 * Symbol and interval from the page URL, in TradingView's own format:
 * `?symbol=BINANCE:XRPUSDT&interval=1D` (interval accepts D, 60, 1W, …). Without a valid
 * interval in the URL, the last one used applies, then the default.
 */
export function chartRoute(search: string, lastInterval: unknown = null): ChartRoute {
  const params = new URLSearchParams(search);
  const symbol = parseSymbolId(params.get('symbol') ?? '');
  const resolution =
    parseResolution(params.get('interval') ?? '') ??
    (typeof lastInterval === 'string' ? parseResolution(lastInterval) : null);
  return {
    symbol: symbol ? `${symbol.exchange}:${symbol.ticker}` : DEFAULT_SYMBOL,
    resolution: resolution ? formatResolution(resolution) : DEFAULT_RESOLUTION,
  };
}

/** The page's query with `interval` set, keeping every other parameter (like `?tune`). */
export function withInterval(search: string, interval: string): string {
  const params = new URLSearchParams(search);
  params.set('interval', interval);
  return `?${params.toString()}`;
}
