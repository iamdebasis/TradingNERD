import { type Bar, formatResolution, type Resolution, type SymbolInfo } from '@tradingnerd/core';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
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

  /** Ascending bars served by fetchBars. */
  bars: Bar[] = [];
  fetchError: Error | null = null;
  readonly fetchCalls: { endTimeMs: number | null; limit: number }[] = [];
  resolveCalls = 0;

  private feedUp = true;
  private readonly candles = new Set<(update: CandleUpdate) => void>();
  private readonly trades = new Set<(trade: Trade) => void>();
  private readonly books = new Set<(top: BookTop) => void>();
  private readonly stateListeners = new Set<(state: FeedState) => void>();

  constructor({ maxBarsPerRequest = 1_000 } = {}) {
    this.maxBarsPerRequest = maxBarsPerRequest;
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    this.resolveCalls++;
    if (ticker !== FAKE_INFO.ticker) throw new MarketError('unknown_symbol', 'Not listed');
    return { ...FAKE_INFO };
  }

  supportsResolution(resolution: Resolution): boolean {
    return FAKE_INFO.resolutions.includes(formatResolution(resolution));
  }

  async fetchBars(
    _ticker: string,
    _resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    this.fetchCalls.push({ endTimeMs, limit });
    if (this.fetchError) throw this.fetchError;
    const eligible = this.bars.filter((bar) => endTimeMs === null || bar.time * 1000 < endTimeMs);
    return eligible.slice(-limit).map((bar) => ({ ...bar }));
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
