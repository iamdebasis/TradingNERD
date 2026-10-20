import type { MarketScheduleData } from './schedule.ts';

/**
 * Exchange-qualified symbol in TradingView's format: "BINANCE:XRPUSDT", "NASDAQ:AAPL",
 * "NYSE:BRK.B", or a preferred share like "NYSE:JPM/PD".
 */
export type SymbolId = string;

export interface ParsedSymbolId {
  /** Exchange code, e.g. "BINANCE". */
  exchange: string;
  /** Exchange ticker, e.g. "XRPUSDT". */
  ticker: string;
}

const SYMBOL_ID = /^([A-Z][A-Z0-9_]{0,31}):([A-Z0-9][A-Z0-9._/-]{0,47})$/;

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

/**
 * What a symbol is: a crypto spot pair, or a kind of US-listed security (a depositary receipt
 * is a foreign company's shares, "dr" as TradingView calls it).
 */
export const SYMBOL_KINDS = [
  'spot',
  'stock',
  'dr',
  'preferred',
  'etf',
  'warrant',
  'right',
  'unit',
  'note',
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const isSymbolKind = (value: unknown): value is SymbolKind =>
  SYMBOL_KINDS.includes(value as SymbolKind);

/** The time zone crypto's bars and time axis follow. */
export const UTC_ZONE = 'Etc/UTC';

export interface SymbolInfo {
  /** "BINANCE:XRPUSDT" */
  id: SymbolId;
  /** "BINANCE" */
  exchange: string;
  /** "Binance", "NASDAQ", "NYSE Arca" */
  exchangeName: string;
  /** "XRPUSDT" */
  ticker: string;
  /** A pair's assets; a stock's root symbol ("JPM" for JPM/PD) and "USD". */
  base: string;
  quote: string;
  /** "XRP / TetherUS", built from the exchange's own asset names like TradingView does. */
  description: string;
  type: SymbolKind;
  /** Smallest price increment, e.g. 0.0001. */
  tickSize: number;
  /** Decimal places shown for prices, derived from the tick size. */
  pricePrecision: number;
  /** Resolutions the exchange serves natively, in TradingView notation. */
  resolutions: string[];
  /** The exchange's time zone, which bars and the time axis follow: UTC for crypto. */
  timezone: string;
  /** How far behind real time the data runs, ms: 0 when live. */
  delayMs: number;
  /** Whether a best bid and ask stream (the legend's Sell and Buy). */
  hasBook: boolean;
  /** Trading hours, for markets that close; absent for those trading around the clock. */
  schedule?: MarketScheduleData;
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
