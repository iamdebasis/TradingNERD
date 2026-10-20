import {
  type Bar,
  formatResolution,
  parseResolution,
  type Resolution,
  type SymbolInfo,
} from '@tradingnerd/core';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type TickSource,
  type Trade,
  type Unsubscribe,
} from '../../src/market/types.ts';

export const FAKE_INFO: SymbolInfo = {
  id: 'FAKE:XRPUSDT',
  exchange: 'FAKE',
  exchangeName: 'Fake',
  ticker: 'XRPUSDT',
  base: 'XRP',
  quote: 'USDT',
  description: 'XRP / TetherUS',
  type: 'spot',
  tickSize: 0.0001,
  pricePrecision: 4,
  resolutions: ['1', '60', '1D'],
  timezone: 'Etc/UTC',
  delayMs: 0,
  hasBook: true,
};

const DAY = 86_400;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * `count` daily bars ending with the bar that opens at `lastTime` (UTC seconds). Bar i opens at
 * 1 + i/100 and closes 0.01 higher, rounded to 4 decimals (the last of 10 bars closes at 1.1).
 */
export function dailyBars(count: number, lastTime: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const time = lastTime - (count - 1 - i) * DAY;
    const open = round4(1 + i / 100);
    return {
      time,
      open,
      high: round4(open + 0.05),
      low: round4(open - 0.05),
      close: round4(open + 0.01),
      volume: 1000 + i,
    };
  });
}

/** An exchange whose data and live feed are driven by the test. */
export class FakeExchange implements ExchangeAdapter {
  readonly id = 'FAKE';
  readonly name = 'Fake';
  readonly maxBarsPerRequest: number;
  readonly gapless?: boolean;
  readonly nativeResolutions: readonly Resolution[];
  readonly ticks?: TickSource;

  /** Ascending bars served for any interval without its own entry in `series`. */
  bars: Bar[] = [];
  /** Ascending bars per interval, keyed by TradingView notation ("1", "1S", "1M"). */
  readonly series = new Map<string, Bar[]>();
  fetchError: Error | null = null;
  readonly fetchCalls: { resolution: string; endTimeMs: number | null; limit: number }[] = [];
  readonly rangeCalls: { resolution: string; startMs: number; endMs: number }[] = [];
  resolveCalls = 0;

  private feedUp = true;
  private readonly candles = new Set<(update: CandleUpdate) => void>();
  private readonly trades = new Set<(trade: Trade) => void>();
  private readonly books = new Set<(top: BookTop) => void>();
  private readonly stateListeners = new Set<(state: FeedState) => void>();

  constructor({
    maxBarsPerRequest = 1_000,
    natives = FAKE_INFO.resolutions,
    ticks,
    gapless,
  }: {
    maxBarsPerRequest?: number;
    natives?: string[];
    ticks?: TickSource;
    gapless?: boolean;
  } = {}) {
    this.maxBarsPerRequest = maxBarsPerRequest;
    if (ticks) this.ticks = ticks;
    if (gapless) this.gapless = true;
    this.nativeResolutions = natives.map((text) => {
      const resolution = parseResolution(text);
      if (!resolution) throw new Error(`bad resolution ${text}`);
      return resolution;
    });
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    this.resolveCalls++;
    if (ticker !== FAKE_INFO.ticker) throw new MarketError('unknown_symbol', 'Not listed');
    return { ...FAKE_INFO };
  }

  async fetchBars(
    _ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    this.fetchCalls.push({ resolution: formatResolution(resolution), endTimeMs, limit });
    if (this.fetchError) throw this.fetchError;
    const eligible = this.seriesFor(resolution).filter(
      (bar) => endTimeMs === null || bar.time * 1000 < endTimeMs,
    );
    return eligible.slice(-limit).map((bar) => ({ ...bar }));
  }

  async fetchRange(
    _ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    this.rangeCalls.push({ resolution: formatResolution(resolution), startMs, endMs });
    if (this.fetchError) throw this.fetchError;
    return this.seriesFor(resolution)
      .filter((bar) => bar.time * 1000 >= startMs && bar.time * 1000 < endMs)
      .slice(0, this.maxBarsPerRequest)
      .map((bar) => ({ ...bar }));
  }

  private seriesFor(resolution: Resolution): Bar[] {
    return this.series.get(formatResolution(resolution)) ?? this.bars;
  }

  subscribeCandles(_t: string, _r: Resolution, onUpdate: (u: CandleUpdate) => void): Unsubscribe {
    return track(this.candles, onUpdate);
  }

  subscribeTrades(_t: string, onTrade: (trade: Trade) => void): Unsubscribe {
    return track(this.trades, onTrade);
  }

  subscribeBook(_t: string, onBook: (top: BookTop) => void): Unsubscribe {
    return track(this.books, onBook);
  }

  isFeedUp(): boolean {
    return this.feedUp;
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    return track(this.stateListeners, listener);
  }

  async close(): Promise<void> {}

  // ---- test controls ----

  emitCandle(update: CandleUpdate): void {
    for (const handler of [...this.candles]) handler(update);
  }

  emitTrade(trade: Trade): void {
    for (const handler of [...this.trades]) handler(trade);
  }

  emitBook(top: BookTop): void {
    for (const handler of [...this.books]) handler(top);
  }

  setFeed(state: FeedState): void {
    this.feedUp = state === 'up';
    for (const listener of [...this.stateListeners]) listener(state);
  }

  /** Live upstream subscriptions currently held (candles + trades + book). */
  activeStreams(): number {
    return this.candles.size + this.trades.size + this.books.size;
  }
}

function track<T>(set: Set<T>, item: T): Unsubscribe {
  set.add(item);
  return () => set.delete(item);
}
