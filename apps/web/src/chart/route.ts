import { formatResolution, parseResolution, parseSymbolId } from '@tradingnerd/core';

export const DEFAULT_SYMBOL = 'BINANCE:XRPUSDT';
export const DEFAULT_RESOLUTION = '1D';

export interface ChartRoute {
  symbol: string;
  resolution: string;
}

/**
 * Symbol and interval from the page URL, in TradingView's own format:
 * `?symbol=BINANCE:XRPUSDT&interval=1D` (interval accepts D, 60, 1W, …).
 * Anything missing or invalid falls back to the defaults.
 */
export function chartRoute(search: string): ChartRoute {
  const params = new URLSearchParams(search);
  const symbol = parseSymbolId(params.get('symbol') ?? '');
  const resolution = parseResolution(params.get('interval') ?? '');
  return {
    symbol: symbol ? `${symbol.exchange}:${symbol.ticker}` : DEFAULT_SYMBOL,
    resolution: resolution ? formatResolution(resolution) : DEFAULT_RESOLUTION,
  };
}
