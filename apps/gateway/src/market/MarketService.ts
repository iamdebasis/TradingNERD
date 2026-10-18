import {
  type Bar,
  type BarsResponse,
  formatResolution,
  parseResolution,
  parseSymbolId,
  type Resolution,
  resolutionLabel,
  type StreamState,
  type SymbolInfo,
} from '@tradingnerd/core';
import { type Coalescer, createCoalescer } from './coalesce.ts';
import { type BarChange, LiveBarAggregator } from './liveBar.ts';
import {
  type BookTop,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  toMarketError,
  type Unsubscribe,
} from './types.ts';

export interface BarListener {
  onBar(bar: Bar, historical: boolean): void;
  onState(state: StreamState): void;
  onError(error: MarketError): void;
}

export interface BookListener {
  onBook(top: BookTop): void;
  onState(state: StreamState): void;
  onError(error: MarketError): void;
}

export interface MarketServiceOptions {
  /** Minimum gap between live updates sent for one subscription, in ms. */
  emitIntervalMs?: number;
  /** Wait before retrying a failed REST seed, by attempt number (0-based). */
  retryDelayMs?: (attempt: number) => number;
}

export const MAX_COUNT_BACK = 5_000;

/**
 * Market data for the UI: symbol lookup, paged history, and shared live feeds. Every browser
 * tab watching the same symbol and interval shares one upstream subscription.
 */
export class MarketService {
  private readonly exchanges = new Map<string, ExchangeAdapter>();
  private readonly barFeeds = new Map<string, BarFeed>();
  private readonly bookFeeds = new Map<string, BookFeed>();
  private readonly emitIntervalMs: number;
  private readonly retryDelayMs: (attempt: number) => number;

  constructor(adapters: readonly ExchangeAdapter[], options: MarketServiceOptions = {}) {
    for (const adapter of adapters) this.exchanges.set(adapter.id, adapter);
    this.emitIntervalMs = options.emitIntervalMs ?? 50;
    this.retryDelayMs = options.retryDelayMs ?? ((n) => Math.min(1_000 * 2 ** n, 30_000));
  }

  async resolveSymbol(symbolId: string): Promise<SymbolInfo> {
    const { adapter, ticker } = this.route(symbolId);
    return adapter.resolveSymbol(ticker);
  }

  /**
   * Up to `countBack` bars that open strictly before `toSec` (UTC seconds), or the latest bars
   * when `toSec` is null. Pages through the exchange as needed.
   */
  async getBars(
    symbolId: string,
    resolutionText: string,
    toSec: number | null,
    countBack: number,
  ): Promise<BarsResponse> {
    if (!Number.isInteger(countBack) || countBack < 1 || countBack > MAX_COUNT_BACK) {
      throw new MarketError(
        'bad_request',
        `countBack must be a whole number from 1 to ${MAX_COUNT_BACK}`,
      );
    }
    const { adapter, ticker } = this.route(symbolId);
    const resolution = supportedResolution(adapter, resolutionText);
    await adapter.resolveSymbol(ticker);

    const bars: Bar[] = [];
    let endMs = toSec === null ? null : toSec * 1000;
    while (bars.length < countBack) {
      const limit = Math.min(adapter.maxBarsPerRequest, countBack - bars.length);
      const page = await adapter.fetchBars(ticker, resolution, endMs, limit);
      const firstKnown = bars[0]?.time ?? Number.POSITIVE_INFINITY;
      const cutoff = endMs;
      const fresh = page.filter(
        (bar) => bar.time < firstKnown && (cutoff === null || bar.time * 1000 < cutoff),
      );
      bars.unshift(...fresh);
      const oldest = fresh[0];
      if (page.length < limit || !oldest) return { bars, hasMore: false };
      endMs = oldest.time * 1000;
    }
    return { bars, hasMore: true };
  }

  subscribeBars(symbolId: string, resolutionText: string, listener: BarListener): Unsubscribe {
    let feed: BarFeed;
    try {
      const { adapter, ticker, id } = this.route(symbolId);
      const resolution = supportedResolution(adapter, resolutionText);
      const key = `${id}|${formatResolution(resolution)}`;
      const existing = this.barFeeds.get(key);
      if (existing) {
        feed = existing;
      } else {
        feed = new BarFeed(
          adapter,
          ticker,
          resolution,
          this.emitIntervalMs,
          this.retryDelayMs,
          () => {
            if (this.barFeeds.get(key) === feed) this.barFeeds.delete(key);
          },
        );
        this.barFeeds.set(key, feed);
        feed.start();
      }
    } catch (error) {
      queueMicrotask(() => listener.onError(toMarketError(error)));
      return () => {};
    }
    feed.add(listener);
    return () => feed.remove(listener);
  }

  subscribeBook(symbolId: string, listener: BookListener): Unsubscribe {
    let feed: BookFeed;
    try {
      const { adapter, ticker, id } = this.route(symbolId);
      const existing = this.bookFeeds.get(id);
      if (existing) {
        feed = existing;
      } else {
        feed = new BookFeed(adapter, ticker, this.emitIntervalMs, () => {
          if (this.bookFeeds.get(id) === feed) this.bookFeeds.delete(id);
        });
        this.bookFeeds.set(id, feed);
        feed.start();
      }
    } catch (error) {
      queueMicrotask(() => listener.onError(toMarketError(error)));
      return () => {};
    }
    feed.add(listener);
    return () => feed.remove(listener);
  }

  /** Number of live upstream feeds; exposed for tests and diagnostics. */
  feedCount(): number {
    return this.barFeeds.size + this.bookFeeds.size;
  }

  async close(): Promise<void> {
    for (const feed of [...this.barFeeds.values(), ...this.bookFeeds.values()]) feed.close();
    await Promise.all([...this.exchanges.values()].map((adapter) => adapter.close()));
  }

  private route(symbolId: string) {
    const parsed = parseSymbolId(symbolId);
    if (!parsed) {
      throw new MarketError('bad_request', `"${symbolId}" is not a symbol like BINANCE:XRPUSDT`);
    }
    const adapter = this.exchanges.get(parsed.exchange);
    if (!adapter) {
      throw new MarketError('unknown_symbol', `Exchange "${parsed.exchange}" isn't supported yet`);
    }
    return { adapter, ticker: parsed.ticker, id: `${parsed.exchange}:${parsed.ticker}` };
  }
}

function supportedResolution(adapter: ExchangeAdapter, text: string): Resolution {
  const resolution = parseResolution(text);
  if (!resolution) {
    throw new MarketError('unsupported_resolution', `"${text}" is not a valid resolution`);
  }
  if (!adapter.supportsResolution(resolution)) {
    throw new MarketError(
      'unsupported_resolution',
      `${adapter.name} doesn't provide ${resolutionLabel(resolution)} bars yet`,
    );
  }
  return resolution;
}

interface FeedListener {
  onState(state: StreamState): void;
  onError(error: MarketError): void;
}

/** Shared plumbing for one upstream feed fanned out to many listeners. */
abstract class Feed<L extends FeedListener> {
  protected readonly listeners = new Set<L>();
  protected readonly unsubscribes: Unsubscribe[] = [];
  protected state: StreamState = 'reconnecting';
  protected disposed = false;
  private readonly onDispose: () => void;

  constructor(onDispose: () => void) {
    this.onDispose = onDispose;
  }

  add(listener: L): void {
    this.listeners.add(listener);
    // Catch the newcomer up asynchronously, never inside the subscribe call itself.
    queueMicrotask(() => {
      if (this.disposed || !this.listeners.has(listener) || this.state !== 'live') return;
      listener.onState('live');
      this.replay(listener);
    });
  }

  remove(listener: L): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.close();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.cleanup();
    this.onDispose();
  }

  protected setState(next: StreamState): void {
    if (next === this.state) return;
    this.state = next;
    this.broadcast((listener) => listener.onState(next));
  }

  protected broadcast(notify: (listener: L) => void): void {
    for (const listener of [...this.listeners]) notify(listener);
  }

  /** Ends the feed for everyone; later subscribers start a fresh feed and retry. */
  protected fail(error: MarketError): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    this.close();
    for (const listener of listeners) listener.onError(error);
  }

  /** Sends the current snapshot to a listener that joined while live. */
  protected abstract replay(listener: L): void;
  protected abstract cleanup(): void;
}

class BarFeed extends Feed<BarListener> {
  private readonly adapter: ExchangeAdapter;
  private readonly ticker: string;
  private readonly resolution: Resolution;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly aggregator: LiveBarAggregator;
  private readonly coalescer: Coalescer<Bar>;
  private feedUp = false;
  private seeded = false;
  private seeding = false;
  /** Bumped to discard seed results that were started before an outage. */
  private seedRun = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastBarTime: number | null = null;

  constructor(
    adapter: ExchangeAdapter,
    ticker: string,
    resolution: Resolution,
    emitIntervalMs: number,
    retryDelayMs: (attempt: number) => number,
    onDispose: () => void,
  ) {
    super(onDispose);
    this.adapter = adapter;
    this.ticker = ticker;
    this.resolution = resolution;
    this.retryDelayMs = retryDelayMs;
    this.aggregator = new LiveBarAggregator(resolution);
    this.coalescer = createCoalescer(emitIntervalMs, (bar) =>
      this.broadcast((listener) => listener.onBar(bar, false)),
    );
  }

  start(): void {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      await this.adapter.resolveSymbol(this.ticker);
    } catch (error) {
      this.fail(toMarketError(error));
      return;
    }
    if (this.disposed) return;
    this.unsubscribes.push(
      this.adapter.onFeedState((state) => this.onFeedState(state)),
      this.adapter.subscribeCandles(this.ticker, this.resolution, (update) =>
        this.apply(this.aggregator.applyCandle(update)),
      ),
      this.adapter.subscribeTrades(this.ticker, (trade) =>
        this.apply(this.aggregator.applyTrade(trade)),
      ),
    );
    this.feedUp = this.adapter.isFeedUp();
    this.seed(0);
  }

  /** Fetches the latest bar over REST so the chart has a live bar before the stream speaks. */
  private seed(attempt: number): void {
    const run = ++this.seedRun;
    this.seeding = true;
    clearTimeout(this.retryTimer);
    this.adapter.fetchBars(this.ticker, this.resolution, null, 1).then(
      ([latest]) => {
        if (this.disposed || run !== this.seedRun) return;
        this.seeding = false;
        this.seeded = true;
        this.updateState();
        if (latest) this.apply(this.aggregator.seed(latest));
      },
      (error: unknown) => {
        if (this.disposed || run !== this.seedRun) return;
        const failure = toMarketError(error);
        if (failure.code === 'unknown_symbol' || failure.code === 'unsupported_resolution') {
          this.fail(failure);
          return;
        }
        this.retryTimer = setTimeout(() => this.seed(attempt + 1), this.retryDelayMs(attempt));
      },
    );
  }

  private onFeedState(state: FeedState): void {
    if (state === 'down') {
      this.feedUp = false;
      this.seeded = false;
      this.seeding = false;
      this.seedRun++; // a seed started before the outage may be stale
      clearTimeout(this.retryTimer);
      this.aggregator.reset();
      this.coalescer.cancel();
      this.lastBarTime = null;
    } else {
      this.feedUp = true;
      if (!this.seeded && !this.seeding) this.seed(0);
    }
    this.updateState();
  }

  private updateState(): void {
    this.setState(this.seeded && this.feedUp ? 'live' : 'reconnecting');
  }

  private apply(changes: BarChange[]): void {
    for (const { bar, historical } of changes) {
      if (historical) {
        this.broadcast((listener) => listener.onBar(bar, true));
      } else if (this.lastBarTime !== null && bar.time !== this.lastBarTime) {
        // New bar: send the previous bar's final update first, then the new bar at once.
        this.coalescer.flush();
        this.lastBarTime = bar.time;
        this.coalescer.push(bar);
        this.coalescer.flush();
      } else {
        this.lastBarTime = bar.time;
        this.coalescer.push(bar);
      }
    }
  }

  protected replay(listener: BarListener): void {
    const bar = this.aggregator.current();
    if (bar) listener.onBar(bar, false);
  }

  protected cleanup(): void {
    clearTimeout(this.retryTimer);
    this.coalescer.cancel();
  }
}

class BookFeed extends Feed<BookListener> {
  private readonly adapter: ExchangeAdapter;
  private readonly ticker: string;
  private readonly coalescer: Coalescer<BookTop>;
  private feedUp = false;
  private last: BookTop | null = null;

  constructor(
    adapter: ExchangeAdapter,
    ticker: string,
    emitIntervalMs: number,
    onDispose: () => void,
  ) {
    super(onDispose);
    this.adapter = adapter;
    this.ticker = ticker;
    this.coalescer = createCoalescer(emitIntervalMs, (top) =>
      this.broadcast((listener) => listener.onBook(top)),
    );
  }

  start(): void {
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      await this.adapter.resolveSymbol(this.ticker);
    } catch (error) {
      this.fail(toMarketError(error));
      return;
    }
    if (this.disposed) return;
    this.unsubscribes.push(
      this.adapter.onFeedState((state) => {
        this.feedUp = state === 'up';
        if (!this.feedUp) {
          this.last = null;
          this.coalescer.cancel();
        }
        this.updateState();
      }),
      this.adapter.subscribeBook(this.ticker, (top) => {
        this.last = top;
        this.updateState();
        this.coalescer.push(top);
      }),
    );
    this.feedUp = this.adapter.isFeedUp();
  }

  /** Live once the feed is connected and the first quote has arrived. */
  private updateState(): void {
    this.setState(this.feedUp && this.last ? 'live' : 'reconnecting');
  }

  protected replay(listener: BookListener): void {
    if (this.last) listener.onBook(this.last);
  }

  protected cleanup(): void {
    this.coalescer.cancel();
  }
}
