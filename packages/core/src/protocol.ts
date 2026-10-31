import { MAX_FORMULA_LENGTH } from './formula.ts';
import { type Bar, type BarsResponse, isSymbolKind, type SymbolInfo } from './market.ts';
import { isSessionHours, parseMarketSchedule, type SessionHours } from './schedule.ts';

/**
 * Wire protocol between the UI and the local gateway.
 * Bump PROTOCOL_VERSION on any breaking change so a stale UI can tell it needs a reload.
 */
/**
 * 3: tick bars, whose `time` is a bar number and `start` their first trade's time.
 * 4: the `quotes` channel for watchlist rows.
 * 5: US stocks: symbol kinds, time zones, data delays and trading calendars; `needs_key`.
 * 6: extended hours: bars of a session (`session` on bar requests and subscriptions).
 * 7: several watchlists (/api/watchlists); `not_found`.
 * 8: CRYPTOCAP market caps: the `index` kind and a symbol's price `format`.
 * 9: formulas (spreads): the `spread` kind, symbols up to 256 characters, and an unknown
 *    symbol's `suggestion`.
 * 10: indicators: a history page's `fromListing`.
 */
export const PROTOCOL_VERSION = 10;

/** Body of GET /api/health. */
export interface HealthResponse {
  status: 'ok';
  protocolVersion: number;
  uptimeSec: number;
  /** Gateway clock in epoch ms. */
  serverTime: number;
}

export const ERROR_CODES = [
  'bad_request',
  'unknown_symbol',
  'unsupported_resolution',
  'upstream_error',
  'rate_limited',
  'too_many_subscriptions',
  'internal_error',
  /** The data needs a key the user hasn't given yet (US stocks: Alpaca's). */
  'needs_key',
  /** Something asked for by id doesn't exist (a watchlist). */
  'not_found',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Body of every REST error response. */
export interface ApiErrorBody {
  error: ErrorCode;
  message: string;
  /**
   * What to use instead, when the gateway can tell: a formula with its symbol we don't have
   * swapped for one we do (EURONEXT:USDC → CRYPTOCAP:USDC beside market caps).
   */
  suggestion?: string;
}

/** Health of one live subscription: `reconnecting` while the exchange feed is down. */
export type StreamState = 'live' | 'reconnecting';

/** Messages the gateway sends over the WebSocket. */
export type ServerMessage =
  | { type: 'hello'; protocolVersion: number; serverTime: number }
  | { type: 'pong'; t: number }
  /** Live bar update. `historical` marks a late correction to a bar before the current one. */
  | { type: 'bar'; id: string; bar: Bar; historical: boolean }
  /** Best bid and ask. */
  | { type: 'book'; id: string; bid: number; ask: number }
  /**
   * A watchlist quote: the last price and the previous daily bar's close, which TradingView
   * measures the day's change against (null for a symbol listed today).
   */
  | { type: 'quote'; id: string; last: number; prevClose: number | null }
  | { type: 'status'; id: string; state: StreamState }
  | { type: 'error'; id: string | null; code: ErrorCode; message: string };

/** Messages the UI sends over the WebSocket. */
export type ClientMessage =
  | { type: 'ping'; t: number }
  | {
      type: 'subscribe';
      id: string;
      channel: 'bars';
      symbol: string;
      resolution: string;
      /** Intraday bars of the regular session (the default) or with pre- and post-market. */
      session?: SessionHours;
    }
  | { type: 'subscribe'; id: string; channel: 'book'; symbol: string }
  | { type: 'subscribe'; id: string; channel: 'quotes'; symbol: string }
  | { type: 'unsubscribe'; id: string };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isShortString = (v: unknown, max = 64): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const isErrorCode = (v: unknown): v is ErrorCode => ERROR_CODES.includes(v as ErrorCode);

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Validates a bar received from outside; all six fields must be finite numbers. */
export function parseBar(value: unknown): Bar | null {
  if (typeof value !== 'object' || value === null) return null;
  const { time, open, high, low, close, volume, start } = value as Record<string, unknown>;
  if (
    !isNumber(time) ||
    !isNumber(open) ||
    !isNumber(high) ||
    !isNumber(low) ||
    !isNumber(close) ||
    !isNumber(volume) ||
    (start !== undefined && !isNumber(start))
  ) {
    return null;
  }
  const bar: Bar = { time, open, high, low, close, volume };
  if (start !== undefined) bar.start = start;
  return bar;
}

/**
 * Validates GET /api/bars output: bars must be valid and strictly ascending. A page without
 * `fromListing` (a gateway before protocol 10) doesn't vouch for a listing.
 */
export function parseBarsResponse(value: unknown): BarsResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const { bars, hasMore, fromListing = false } = value as Record<string, unknown>;
  if (!Array.isArray(bars) || typeof hasMore !== 'boolean' || typeof fromListing !== 'boolean') {
    return null;
  }
  const parsed: Bar[] = [];
  for (const item of bars) {
    const bar = parseBar(item);
    const previous = parsed.at(-1);
    if (!bar || (previous && bar.time <= previous.time)) return null;
    parsed.push(bar);
  }
  return { bars: parsed, hasMore, fromListing: fromListing && !hasMore };
}

/** Validates GET /api/symbols/resolve output. */
export function parseSymbolInfo(value: unknown): SymbolInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const strings = ['id', 'exchange', 'exchangeName', 'ticker', 'base', 'quote', 'description'];
  if (!strings.every((key) => typeof v[key] === 'string')) return null;
  if (!isSymbolKind(v.type) || !isNumber(v.tickSize) || v.tickSize <= 0) return null;
  if (!isNumber(v.pricePrecision) || !Number.isInteger(v.pricePrecision) || v.pricePrecision < 0) {
    return null;
  }
  if (!Array.isArray(v.resolutions) || !v.resolutions.every((r) => typeof r === 'string'))
    return null;
  if (typeof v.timezone !== 'string' || v.timezone === '') return null;
  if (!isNumber(v.delayMs) || v.delayMs < 0 || typeof v.hasBook !== 'boolean') return null;
  if (v.format !== undefined && v.format !== 'price' && v.format !== 'volume') return null;
  const schedule = v.schedule === undefined ? undefined : parseMarketSchedule(v.schedule);
  if (schedule === null) return null;
  const info: SymbolInfo = {
    id: v.id as string,
    exchange: v.exchange as string,
    exchangeName: v.exchangeName as string,
    ticker: v.ticker as string,
    base: v.base as string,
    quote: v.quote as string,
    description: v.description as string,
    type: v.type,
    tickSize: v.tickSize,
    pricePrecision: v.pricePrecision,
    resolutions: [...(v.resolutions as string[])],
    timezone: v.timezone,
    delayMs: v.delayMs,
    hasBook: v.hasBook,
  };
  if (v.format !== undefined) info.format = v.format;
  if (schedule) info.schedule = schedule;
  return info;
}

/** Validates a REST error body. */
export function parseApiError(value: unknown): ApiErrorBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const { error, message, suggestion } = value as Record<string, unknown>;
  if (!isErrorCode(error) || typeof message !== 'string') return null;
  return typeof suggestion === 'string' && suggestion.length <= MAX_FORMULA_LENGTH
    ? { error, message, suggestion }
    : { error, message };
}

/** Parses a gateway → UI message. Returns null for anything malformed or unknown. */
export function parseServerMessage(raw: string): ServerMessage | null {
  const msg = parseObject(raw);
  if (!msg) return null;
  switch (msg.type) {
    case 'hello':
      return isNumber(msg.protocolVersion) && isNumber(msg.serverTime)
        ? { type: 'hello', protocolVersion: msg.protocolVersion, serverTime: msg.serverTime }
        : null;
    case 'pong':
      return isNumber(msg.t) ? { type: 'pong', t: msg.t } : null;
    case 'bar': {
      const bar = parseBar(msg.bar);
      return isShortString(msg.id) && bar && typeof msg.historical === 'boolean'
        ? { type: 'bar', id: msg.id, bar, historical: msg.historical }
        : null;
    }
    case 'book':
      return isShortString(msg.id) && isNumber(msg.bid) && isNumber(msg.ask)
        ? { type: 'book', id: msg.id, bid: msg.bid, ask: msg.ask }
        : null;
    case 'quote':
      return isShortString(msg.id) &&
        isNumber(msg.last) &&
        (msg.prevClose === null || isNumber(msg.prevClose))
        ? { type: 'quote', id: msg.id, last: msg.last, prevClose: msg.prevClose }
        : null;
    case 'status':
      return isShortString(msg.id) && (msg.state === 'live' || msg.state === 'reconnecting')
        ? { type: 'status', id: msg.id, state: msg.state }
        : null;
    case 'error':
      return (msg.id === null || isShortString(msg.id)) &&
        isErrorCode(msg.code) &&
        typeof msg.message === 'string'
        ? { type: 'error', id: msg.id, code: msg.code, message: msg.message }
        : null;
    default:
      return null;
  }
}

/** Parses a UI → gateway message. Returns null for anything malformed or unknown. */
export function parseClientMessage(raw: string): ClientMessage | null {
  const msg = parseObject(raw);
  if (!msg) return null;
  switch (msg.type) {
    case 'ping':
      return isNumber(msg.t) ? { type: 'ping', t: msg.t } : null;
    case 'unsubscribe':
      return isShortString(msg.id) ? { type: 'unsubscribe', id: msg.id } : null;
    case 'subscribe': {
      if (!isShortString(msg.id) || !isShortString(msg.symbol, MAX_FORMULA_LENGTH)) return null;
      if (msg.channel === 'bars') {
        if (!isShortString(msg.resolution, 16)) return null;
        if (msg.session !== undefined && !isSessionHours(msg.session)) return null;
        return {
          type: 'subscribe',
          id: msg.id,
          channel: 'bars',
          symbol: msg.symbol,
          resolution: msg.resolution,
          ...(msg.session ? { session: msg.session } : {}),
        };
      }
      if (msg.channel === 'book' || msg.channel === 'quotes') {
        return { type: 'subscribe', id: msg.id, channel: msg.channel, symbol: msg.symbol };
      }
      return null;
    }
    default:
      return null;
  }
}
