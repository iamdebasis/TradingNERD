import { formatResolution, parseResolution, parseSymbolId } from '@tradingnerd/core';

export const DEFAULT_SYMBOL = 'BINANCE:XRPUSDT';
export const DEFAULT_RESOLUTION = '1D';

export interface ChartRoute {
  symbol: string;
  resolution: string;
}

/**
 * Symbol and interval from the page URL, in TradingView's own format:
 * `?symbol=BINANCE:XRPUSDT&interval=1D` (interval accepts D, 60, 1W, …). Whatever the URL
 * lacks (or gets wrong) comes from the last symbol and interval used, then the defaults.
 */
export function chartRoute(
  search: string,
  lastInterval: unknown = null,
  lastSymbol: unknown = null,
): ChartRoute {
  const params = new URLSearchParams(search);
  const symbol =
    parseSymbolId(params.get('symbol') ?? '') ??
    (typeof lastSymbol === 'string' ? parseSymbolId(lastSymbol) : null);
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
  return withParam(search, 'interval', interval);
}

/** The page's query with `symbol` set, keeping every other parameter. */
export function withSymbol(search: string, symbol: string): string {
  return withParam(search, 'symbol', symbol);
}

function withParam(search: string, key: string, value: string): string {
  const params = new URLSearchParams(search);
  params.set(key, value);
  return `?${params.toString()}`;
}
