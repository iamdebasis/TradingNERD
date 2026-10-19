import {
  type AggTrade,
  type Bar,
  type BarsResponse,
  barCloseTime,
  barOpenTime,
  formatResolution,
  maxBasePerBar,
  parseResolution,
  parseSymbolId,
  type Resolution,
  resampleBars,
  resampleBase,
  resolutionLabel,
  type StreamState,
  type SymbolInfo,
} from '@tradingnerd/core';
import { type Coalescer, createCoalescer } from './coalesce.ts';
import { Feed } from './feed.ts';
import { fetchHistory, fetchSlices, pageBack } from './history.ts';
import { HistoryCache } from './historyCache.ts';
import type { BarChange } from './liveBar.ts';
import { QuoteFeed, type QuoteListener } from './quotes.ts';
import { nativeLiveBars, ResampledBarAggregator } from './resampledBar.ts';
import { TickBars, TickHistory } from './ticks.ts';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type TickSource,
  type Trade,
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
  /** Minimum gap between quote updates for one watchlist row, in ms. */
  quoteIntervalMs?: number;
  /** Wait before retrying a failed REST seed, by attempt number (0-based). */
  retryDelayMs?: (attempt: number) => number;
  /** Keeps recent history pages (default); false fetches every page from the exchange. */
  cacheHistory?: boolean;
}

export const MAX_COUNT_BACK = 5_000;
/** Requests one history call may make for a resampled interval (~0.5 s at 6 in parallel). */
export const RESAMPLE_MAX_REQUESTS = 12;

/** How an interval is served: natively, resampled from a native `base`, or from trades. */
type IntervalPlan =
  | { kind: 'native'; target: Resolution }
  | { kind: 'resampled'; target: Resolution; base: Resolution }
  | { kind: 'ticks'; target: Resolution; source: TickSource };

/**
 * Market data for the UI: symbol lookup, paged history, and shared live feeds. Every browser
 * tab watching the same symbol and interval shares one upstream subscription.
 */
export class MarketService {
  private readonly exchanges = new Map<string, ExchangeAdapter>();
  private readonly barFeeds = new Map<string, BarFeed<unknown>>();
  private readonly tickHistory = new TickHistory();
  private readonly bookFeeds = new Map<string, BookFeed>();
  private readonly quoteFeeds = new Map<string, QuoteFeed>();
  private readonly history: HistoryCache | null;
  private readonly emitIntervalMs: number;
  private readonly quoteIntervalMs: number;
  private readonly retryDelayMs: (attempt: number) => number;

  constructor(adapters: readonly ExchangeAdapter[], options: MarketServiceOptions = {}) {
    for (const adapter of adapters) this.exchanges.set(adapter.id, adapter);
    this.emitIntervalMs = options.emitIntervalMs ?? 50;
    this.quoteIntervalMs = options.quoteIntervalMs ?? 250;
    this.retryDelayMs = options.retryDelayMs ?? ((n) => Math.min(1_000 * 2 ** n, 30_000));
    this.history = options.cacheHistory === false ? null : new HistoryCache();
  }

  async resolveSymbol(symbolId: string): Promise<SymbolInfo> {
    const { adapter, ticker } = this.route(symbolId);
    return adapter.resolveSymbol(ticker);
  }

  /**
   * Up to `countBack` bars that open strictly before `toSec` (UTC seconds), or the latest bars
   * when `toSec` is null. Pages through the exchange as needed; recent pages are kept, so going
   * back to a chart is instant (historyCache.ts).
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
    const { adapter, ticker, id } = this.route(symbolId);
    const plan = intervalPlan(adapter, resolutionText);
    await adapter.resolveSymbol(ticker);
    switch (plan.kind) {
      case 'native':
      case 'resampled': {
        const load = (to: number | null, count: number) =>
          plan.kind === 'native'
            ? fetchHistory(adapter, ticker, plan.target, to === null ? null : to * 1000, count)
            : getResampledBars(adapter, ticker, plan.target, plan.base, to, count);
        if (!this.history) return load(toSec, countBack);
        const page = `${id}|${formatResolution(plan.target)}|${countBack}`;
        return toSec === null
          ? this.history.latest(page, plan.target, countBack, (count) => load(null, count))
          : this.history.older(`${page}|${toSec}`, plan.target, () => load(toSec, countBack));
      }
      case 'ticks':
        // For tick bars `toSec` is a bar number (see Bar.time).
        return this.tickHistory.bars(plan.source, id, ticker, plan.target.count, toSec, countBack);
    }
  }

  subscribeBars(symbolId: string, resolutionText: string, listener: BarListener): Unsubscribe {
    let feed: BarFeed<unknown>;
    try {
      const { adapter, ticker, id } = this.route(symbolId);
      const plan = intervalPlan(adapter, resolutionText);
      const key = `${id}|${formatResolution(plan.target)}`;
      const existing = this.barFeeds.get(key);
      if (existing) {
        feed = existing;
      } else {
        const strategy = liveStrategy(adapter, ticker, plan) as LiveStrategy<unknown>;
        feed = new BarFeed(
          adapter,
          ticker,
          strategy,
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

  /**
   * A watchlist row's live price and previous daily close (see QuoteFeed). Rows of the same
   * symbol share one feed.
   */
  subscribeQuote(symbolId: string, listener: QuoteListener): Unsubscribe {
    let feed: QuoteFeed;
    try {
      const { id } = this.route(symbolId);
      const existing = this.quoteFeeds.get(id);
      if (existing) {
        feed = existing;
      } else {
        const daily = {
          subscribe: (inner: BarListener) => this.subscribeBars(id, '1D', inner),
          fetchRecent: () => this.getBars(id, '1D', null, 2),
        };
        feed = new QuoteFeed(daily, this.quoteIntervalMs, () => {
          if (this.quoteFeeds.get(id) === feed) this.quoteFeeds.delete(id);
        });
        this.quoteFeeds.set(id, feed);
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
    return this.barFeeds.size + this.bookFeeds.size + this.quoteFeeds.size;
  }

  async close(): Promise<void> {
    for (const feed of [...this.quoteFeeds.values()]) feed.close();
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

const sameResolution = (a: Resolution, b: Resolution) => a.unit === b.unit && a.count === b.count;

/** Native if the exchange serves the interval, else resampled from its coarsest fitting one. */
function intervalPlan(adapter: ExchangeAdapter, text: string): IntervalPlan {
  const target = parseResolution(text);
  if (!target) {
    throw new MarketError('unsupported_resolution', `"${text}" is not a valid resolution`);
  }
  if (adapter.nativeResolutions.some((native) => sameResolution(native, target))) {
    return { kind: 'native', target };
  }
  if (target.unit === 'tick' && adapter.ticks)
    return { kind: 'ticks', target, source: adapter.ticks };
  const base = resampleBase(target, adapter.nativeResolutions);
  if (!base) {
    throw new MarketError(
      'unsupported_resolution',
      `${adapter.name} doesn't provide ${resolutionLabel(target)} bars yet`,
    );
  }
  return { kind: 'resampled', target, base };
}

/**
 * History for a resampled interval: enough base bars for `countBack` bars plus one, folded.
 * The oldest bar is dropped if the base bars may not reach back to its start.
 */
async function getResampledBars(
  adapter: ExchangeAdapter,
  ticker: string,
  target: Resolution,
  base: Resolution,
  toSec: number | null,
  countBack: number,
): Promise<BarsResponse> {
  const perBar = maxBasePerBar(base, target);
  const endMs = toSec === null ? null : periodEnd(target, toSec * 1000);
  const history = await fetchSlices(
    adapter,
    ticker,
    base,
    endMs,
    (countBack + 1) * perBar,
    RESAMPLE_MAX_REQUESTS,
  );
  let bars = resampleBars(history.bars, target);
  const firstBase = history.bars[0];
  if (history.hasMore && firstBase && bars[0] && firstBase.time > bars[0].time) {
    bars = bars.slice(1);
  }
  if (toSec !== null) bars = bars.filter((bar) => bar.time < toSec);
  let hasMore = history.hasMore;
  if (bars.length > countBack) {
    bars = bars.slice(-countBack);
    hasMore = true;
  }
  return { bars, hasMore };
}

/** The end of the bar that contains `ms`, or `ms` itself when a bar opens there. */
function periodEnd(target: Resolution, ms: number): number {
  const open = barOpenTime(target, ms);
  return open === ms ? ms : barCloseTime(target, open);
}

/** How a bar feed builds its live bar from the exchange. */
interface LiveStrategy<Seed> {
  /** Candles to stream: the interval itself or the base it's resampled from; none for ticks. */
  readonly candles: Resolution | null;
  /** Recent history over REST, for the live bar to start from. */
  fetchSeed(): Promise<Seed>;
  /** Starts the live bar; 'gap' if live data already got ahead of it. */
  seed(data: Seed): BarChange[] | 'gap';
  applyCandle(update: CandleUpdate): BarChange[];
  /** 'gap' when trades went missing and the bar can't be trusted. */
  applyTrade(trade: Trade): BarChange[] | 'gap';
  current(): Bar | null;
  reset(): void;
}

function liveStrategy(
  adapter: ExchangeAdapter,
  ticker: string,
  plan: IntervalPlan,
): LiveStrategy<Bar[]> | LiveStrategy<AggTrade[]> {
  if (plan.kind === 'ticks') {
    const { source } = plan;
    const live = new TickBars(plan.target.count);
    const ticks: LiveStrategy<AggTrade[]> = {
      candles: null,
      fetchSeed: () => source.aggTrades(ticker, null, source.maxPerRequest),
      seed: (latest) => live.seed(latest),
      applyCandle: () => [],
      applyTrade: (trade) => live.apply(trade),
      current: () => live.current(),
      reset: () => live.reset(),
    };
    return ticks;
  }
  const { target } = plan;
  const base = plan.kind === 'resampled' ? plan.base : null;
  const live = base ? new ResampledBarAggregator(target, base) : nativeLiveBars(target);
  const bars: LiveStrategy<Bar[]> = {
    candles: base ?? target,
    // A resampled interval needs every base bar of its current period.
    fetchSeed: () =>
      base
        ? pageBack(adapter, ticker, base, null, maxBasePerBar(base, target)).then((h) => h.bars)
        : adapter.fetchBars(ticker, target, null, 1),
    seed: (seed) => live.seed(seed),
    applyCandle: (update) => live.applyCandle(update),
    applyTrade: (trade) => live.applyTrade(trade),
    current: () => live.current(),
    reset: () => live.reset(),
  };
  return bars;
}

/**
 * Sends bar changes to listeners: corrections at once, updates to the current bar at most
 * once per window, and a new bar at once, right after the previous bar's final update.
 */
class BarEmitter {
  private readonly coalescer: Coalescer<Bar>;
  private readonly send: (bar: Bar, historical: boolean) => void;
  private lastBarTime: number | null = null;

  constructor(emitIntervalMs: number, send: (bar: Bar, historical: boolean) => void) {
    this.send = send;
    this.coalescer = createCoalescer(emitIntervalMs, (bar) => send(bar, false));
  }

  apply(changes: BarChange[]): void {
    for (const { bar, historical } of changes) {
      if (historical) {
        this.send(bar, true);
      } else if (this.lastBarTime !== null && bar.time !== this.lastBarTime) {
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

  reset(): void {
    this.coalescer.cancel();
    this.lastBarTime = null;
  }
}

class BarFeed<Seed> extends Feed<BarListener> {
  private readonly adapter: ExchangeAdapter;
  private readonly ticker: string;
  private readonly strategy: LiveStrategy<Seed>;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly emitter: BarEmitter;
  private feedUp = false;
  private seeded = false;
  private seeding = false;
  /** Bumped to discard seed results that were started before an outage. */
  private seedRun = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    adapter: ExchangeAdapter,
    ticker: string,
    strategy: LiveStrategy<Seed>,
    emitIntervalMs: number,
    retryDelayMs: (attempt: number) => number,
    onDispose: () => void,
  ) {
    super(onDispose);
    this.adapter = adapter;
    this.ticker = ticker;
    this.strategy = strategy;
    this.retryDelayMs = retryDelayMs;
    this.emitter = new BarEmitter(emitIntervalMs, (bar, historical) =>
      this.broadcast((listener) => listener.onBar(bar, historical)),
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
    const { candles } = this.strategy;
    this.unsubscribes.push(
      this.adapter.onFeedState((state) => this.onFeedState(state)),
      this.adapter.subscribeTrades(this.ticker, (trade) =>
        this.apply(this.strategy.applyTrade(trade)),
      ),
    );
    if (candles) {
      this.unsubscribes.push(
        this.adapter.subscribeCandles(this.ticker, candles, (update) =>
          this.apply(this.strategy.applyCandle(update)),
        ),
      );
    }
    this.feedUp = this.adapter.isFeedUp();
    this.seed(0);
  }

  /** Fetches recent history over REST so the chart has a live bar before the stream speaks. */
  private seed(attempt: number): void {
    const run = ++this.seedRun;
    this.seeding = true;
    clearTimeout(this.retryTimer);
    this.strategy.fetchSeed().then(
      (data) => {
        if (this.disposed || run !== this.seedRun) return;
        this.seeding = false;
        const changes = this.strategy.seed(data);
        if (changes === 'gap') {
          this.restart();
          return;
        }
        this.seeded = true;
        this.updateState();
        this.emitter.apply(changes);
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

  private apply(changes: BarChange[] | 'gap'): void {
    if (changes === 'gap') this.restart();
    else this.emitter.apply(changes);
  }

  /**
   * Live data went missing: start the bar over. Listeners see 'reconnecting' and then 'live'
   * again, so they reload recent history and pick up what was missed.
   */
  private restart(): void {
    this.seeded = false;
    this.seeding = false;
    this.seedRun++;
    clearTimeout(this.retryTimer);
    this.strategy.reset();
    this.emitter.reset();
    this.updateState();
    if (this.feedUp) this.seed(0);
  }

  private onFeedState(state: FeedState): void {
    if (state === 'down') {
      this.feedUp = false;
      this.seeded = false;
      this.seeding = false;
      this.seedRun++; // a seed started before the outage may be stale
      clearTimeout(this.retryTimer);
      this.strategy.reset();
      this.emitter.reset();
    } else {
      this.feedUp = true;
      if (!this.seeded && !this.seeding) this.seed(0);
    }
    this.updateState();
  }

  private updateState(): void {
    this.setState(this.seeded && this.feedUp ? 'live' : 'reconnecting');
  }

  protected replay(listener: BarListener): void {
    const bar = this.strategy.current();
    if (bar) listener.onBar(bar, false);
  }

  protected cleanup(): void {
    clearTimeout(this.retryTimer);
    this.emitter.reset();
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
