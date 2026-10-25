import {
  type Bar,
  barOpenTime,
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
  type Trade,
  type Unsubscribe,
} from '../../src/market/types.ts';

const ONE_MINUTE = parseResolution('1') as Resolution;

/** An exchange with several pairs whose bars and live candles the test sets. */
export class FakePairsExchange implements ExchangeAdapter {
  readonly id: string;
  readonly name: string;
  readonly maxBarsPerRequest: number;
  readonly gapless = true;
  readonly nativeResolutions: readonly Resolution[];

  /** Ticker → interval (TradingView notation) → ascending bars. */
  readonly series = new Map<string, Map<string, Bar[]>>();
  readonly rangeCalls: { ticker: string; resolution: string; startMs: number; endMs: number }[] =
    [];
  /** Tickers whose history requests fail. */
  readonly failing = new Set<string>();
  private readonly candles = new Map<string, Set<(update: CandleUpdate) => void>>();
  private readonly stateListeners = new Set<(state: FeedState) => void>();
  private feedUp = true;

  constructor(
    id: string,
    { maxBarsPerRequest = 1_000, natives = ['1', '5', '15', '30', '60', '240', '1D'] } = {},
  ) {
    this.id = id;
    this.name = id;
    this.maxBarsPerRequest = maxBarsPerRequest;
    this.nativeResolutions = natives.map((text) => parseResolution(text) as Resolution);
  }

  /** Sets a pair's bars at one interval. */
  setBars(ticker: string, resolution: string, bars: Bar[]): void {
    let byResolution = this.series.get(ticker);
    if (!byResolution) {
      byResolution = new Map();
      this.series.set(ticker, byResolution);
    }
    byResolution.set(resolution, bars);
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    if (!this.series.has(ticker)) throw new MarketError('unknown_symbol', 'Not listed');
    return {
      id: `${this.id}:${ticker}`,
      exchange: this.id,
      exchangeName: this.name,
      ticker,
      base: ticker.replace(/USDT?$/, ''),
      quote: ticker.endsWith('USDT') ? 'USDT' : 'USD',
      description: ticker,
      type: 'spot',
      tickSize: 0.01,
      pricePrecision: 2,
      resolutions: ['1', '1D'],
      timezone: 'Etc/UTC',
      delayMs: 0,
      hasBook: true,
    };
  }

  private barsOf(ticker: string, resolution: Resolution): Bar[] {
    if (this.failing.has(ticker)) throw new MarketError('upstream_error', 'Unreachable');
    return this.series.get(ticker)?.get(formatResolution(resolution)) ?? [];
  }

  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    return this.barsOf(ticker, resolution)
      .filter((bar) => endTimeMs === null || bar.time * 1000 < endTimeMs)
      .slice(-limit)
      .map((bar) => ({ ...bar }));
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    this.rangeCalls.push({ ticker, resolution: formatResolution(resolution), startMs, endMs });
    return this.barsOf(ticker, resolution)
      .filter((bar) => bar.time * 1000 >= startMs && bar.time * 1000 < endMs)
      .slice(0, this.maxBarsPerRequest)
      .map((bar) => ({ ...bar }));
  }

  subscribeCandles(
    ticker: string,
    _resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    let listeners = this.candles.get(ticker);
    if (!listeners) {
      listeners = new Set();
      this.candles.set(ticker, listeners);
    }
    const set = listeners;
    set.add(onUpdate);
    return () => set.delete(onUpdate);
  }

  subscribeTrades(_ticker: string, _onTrade: (trade: Trade) => void): Unsubscribe {
    return () => {};
  }

  subscribeBook(_ticker: string, _onBook: (top: BookTop) => void): Unsubscribe {
    return () => {};
  }

  isFeedUp(): boolean {
    return this.feedUp;
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async close(): Promise<void> {}

  // ---- test controls ----

  /** A live 1-minute candle of `ticker` whose close is `price`. */
  emitPrice(ticker: string, price: number, timeMs: number): void {
    const time = barOpenTime(ONE_MINUTE, timeMs) / 1000;
    const bar: Bar = { time, open: price, high: price, low: price, close: price, volume: 1 };
    for (const listener of [...(this.candles.get(ticker) ?? [])]) {
      listener({ bar: { ...bar }, eventTime: timeMs });
    }
  }

  /** Pairs whose live candles are followed. */
  followed(): string[] {
    return [...this.candles].filter(([, set]) => set.size > 0).map(([ticker]) => ticker);
  }

  setFeed(state: FeedState): void {
    this.feedUp = state === 'up';
    for (const listener of [...this.stateListeners]) listener(state);
  }
}
