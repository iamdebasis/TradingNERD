/** Exchange-qualified symbol in TradingView's format, e.g. "BINANCE:XRPUSDT". */
export type SymbolId = string;

export interface ParsedSymbolId {
  /** Exchange code, e.g. "BINANCE". */
  exchange: string;
  /** Exchange ticker, e.g. "XRPUSDT". */
  ticker: string;
}

const SYMBOL_ID = /^([A-Z][A-Z0-9_]{0,31}):([A-Z0-9][A-Z0-9._-]{0,47})$/;

/** Parses "binance:xrpusdt" or "BINANCE:XRPUSDT" (case-insensitive, like TradingView URLs). */
export function parseSymbolId(id: string): ParsedSymbolId | null {
  const match = SYMBOL_ID.exec(id.trim().toUpperCase());
  if (!match?.[1] || !match[2]) return null;
  return { exchange: match[1], ticker: match[2] };
}

/**
 * One OHLCV bar. `time` is the bar's open time in UTC seconds (Lightweight Charts'
 * UTCTimestamp); for tick bars it is the bar's number instead, and `start` tells the time.
 */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Tick bars only: when the bar's first trade happened, UTC ms. */
  start?: number;
}

export interface SymbolInfo {
  /** "BINANCE:XRPUSDT" */
  id: SymbolId;
  /** "BINANCE" */
  exchange: string;
  /** "Binance" */
  exchangeName: string;
  /** "XRPUSDT" */
  ticker: string;
  base: string;
  quote: string;
  /** "XRP / TetherUS", built from the exchange's own asset names like TradingView does. */
  description: string;
  type: 'spot';
  /** Smallest price increment, e.g. 0.0001. */
  tickSize: number;
  /** Decimal places shown for prices, derived from the tick size. */
  pricePrecision: number;
  /** Resolutions the exchange serves natively, in TradingView notation. */
  resolutions: string[];
}

/** Body of GET /api/bars. */
export interface BarsResponse {
  /** Ascending by time, all strictly before the requested `to`. */
  bars: Bar[];
  /** False once the start of the exchange's history has been reached. */
  hasMore: boolean;
}

/** Decimal places needed to show a tick size such as 0.0001 (→ 4) or 1e-8 (→ 8). */
export function precisionOf(tickSize: number): number {
  if (!(tickSize > 0) || !Number.isFinite(tickSize)) return 2;
  for (let decimals = 0; decimals <= 12; decimals++) {
    const scaled = tickSize * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, scaled)) return decimals;
  }
  return 12;
}
