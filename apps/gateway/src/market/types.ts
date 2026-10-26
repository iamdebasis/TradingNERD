import type {
  AggTrade,
  Bar,
  BarClock,
  ErrorCode,
  Resolution,
  SessionHours,
  SymbolInfo,
} from '@tradingnerd/core';

export type Unsubscribe = () => void;

/** One trade print, or an aggregate of trades at one price. */
export interface Trade {
  price: number;
  quantity: number;
  /** Epoch ms. */
  time: number;
  /** The aggregate's id and its trades' ids, when the exchange numbers them (for tick bars). */
  id?: number;
  firstId?: number;
  lastId?: number;
}

/** Numbered trade history, which tick bars are built from. */
export interface TickSource {
  /** Most aggregates one `aggTrades` call returns. */
  readonly maxPerRequest: number;
  /**
   * Up to `limit` aggregate trades with ids from `fromId` up, or the latest when null;
   * ascending.
   */
  aggTrades(ticker: string, fromId: number | null, limit: number): Promise<AggTrade[]>;
  /** The aggregate holding trade `tradeId`, or null once the exchange no longer has it. */
  aggTradeContaining(ticker: string, tradeId: number): Promise<AggTrade | null>;
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
  /**
   * Whether every period has a bar from the first trade on (quiet ones filled in), so history
   * can be fetched as parallel time slices, and a slice that comes back short is where it starts.
   */
  readonly gapless?: boolean;

  /** Intervals the exchange serves itself; the gateway resamples the others from these. */
  readonly nativeResolutions: readonly Resolution[];
  /** Where its bars begin and end: its sessions, for markets that close (UTC when absent). */
  readonly clock?: BarClock;
  /**
   * For markets with pre- and post-market trading: the clock of intraday bars in those hours
   * too. Without it, every request gets the regular session's bars.
   */
  clockFor?(hours: SessionHours): BarClock;
  /** How far behind real time its data runs, ms (0 when absent). */
  readonly delayMs?: number;
  /** Numbered trades, for tick bars; exchanges without them have no tick intervals. */
  readonly ticks?: TickSource;
  /**
   * Whether its bars at `resolution`, the oldest opening at `firstBarMs`, reach back to the
   * pair's listing. Then a longer bar built from them may rightly start part way through its
   * period, as TradingView's first bar after a listing does. Absent or false: its history may
   * stop short of the listing, so such a bar would be wrong, and it's left out (docs/SPEC.md §6.5).
   */
  historyFromListing?(resolution: Resolution, firstBarMs: number): boolean;

  /** Rejects with MarketError('unknown_symbol') if the exchange doesn't list it. */
  resolveSymbol(ticker: string): Promise<SymbolInfo>;
  /**
   * Up to `limit` bars opening strictly before `endTimeMs` (or the latest bars when null),
   * ascending by time. Native intervals only. `hours`: which session's intraday bars, for
   * exchanges with `clockFor` (regular when absent).
   */
  fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
    hours?: SessionHours,
  ): Promise<Bar[]>;
  /**
   * Bars opening in [startMs, endMs), ascending, at most `maxBarsPerRequest` of them (the
   * earliest). Native intervals only.
   */
  fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
    hours?: SessionHours,
  ): Promise<Bar[]>;

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
    hours?: SessionHours,
  ): Unsubscribe;
  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe;
  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe;

  isFeedUp(): boolean;
  onFeedState(listener: (state: FeedState) => void): Unsubscribe;
  close(): Promise<void>;
  /** Loads what a first lookup would otherwise wait for (an exchange's pair list), at start. */
  prepare?(): Promise<void>;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unknown_symbol: 404,
  unsupported_resolution: 400,
  upstream_error: 502,
  rate_limited: 503,
  too_many_subscriptions: 429,
  internal_error: 500,
  needs_key: 424,
  not_found: 404,
};

/** An error with a protocol error code, safe to show to the UI. */
export class MarketError extends Error {
  readonly code: ErrorCode;
  /** What to use instead, when known (a formula with a symbol we have in place of one we don't). */
  readonly suggestion: string | undefined;

  constructor(code: ErrorCode, message: string, suggestion?: string) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    this.suggestion = suggestion;
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
