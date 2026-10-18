import type { Bar, ErrorCode, Resolution, SymbolInfo } from '@tradingnerd/core';

export type Unsubscribe = () => void;

/** One trade print. */
export interface Trade {
  price: number;
  quantity: number;
  /** Epoch ms. */
  time: number;
}

/** The exchange's own snapshot of a candle, valid as of `eventTime` (epoch ms). */
export interface CandleUpdate {
  bar: Bar;
  eventTime: number;
}

export interface BookTop {
  bid: number;
  ask: number;
}

/** Whether the exchange's live feed is connected (`up` fires again after each reconnect). */
export type FeedState = 'up' | 'down';

/** What the gateway needs from one exchange. Binance is the first implementation. */
export interface ExchangeAdapter {
  /** Exchange code used in symbol ids, e.g. "BINANCE". */
  readonly id: string;
  /** Display name, e.g. "Binance". */
  readonly name: string;
  /** Most bars one fetchBars call can return. */
  readonly maxBarsPerRequest: number;

  /** Rejects with MarketError('unknown_symbol') if the exchange doesn't list it. */
  resolveSymbol(ticker: string): Promise<SymbolInfo>;
  /** Native support only; resampled intervals arrive in M2. */
  supportsResolution(resolution: Resolution): boolean;
  /**
   * Up to `limit` bars opening strictly before `endTimeMs` (or the latest bars when null),
   * ascending by time.
   */
  fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]>;

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe;
  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe;
  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe;

  isFeedUp(): boolean;
  onFeedState(listener: (state: FeedState) => void): Unsubscribe;
  close(): Promise<void>;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unknown_symbol: 404,
  unsupported_resolution: 400,
  upstream_error: 502,
  rate_limited: 503,
  too_many_subscriptions: 429,
  internal_error: 500,
};

/** An error with a protocol error code, safe to show to the UI. */
export class MarketError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function toMarketError(error: unknown): MarketError {
  if (error instanceof MarketError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new MarketError('internal_error', `Unexpected gateway error: ${detail}`);
}
