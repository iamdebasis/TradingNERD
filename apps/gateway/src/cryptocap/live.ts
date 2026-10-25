import {
  type Bar,
  barOpenTime,
  formatResolution,
  parseResolution,
  type Resolution,
  resolutionDurationMs,
} from '@tradingnerd/core';
import type { MarketCoin } from '../logos/coingecko.ts';
import type {
  BookTop,
  CandleUpdate,
  ExchangeAdapter,
  FeedState,
  Unsubscribe,
} from '../market/types.ts';
import type { AnchorBook } from './anchors.ts';
import { CANDIDATE_RANK, type CapHistory, type CapSource, PRICE_TOLERANCE } from './history.ts';
import { BITCOIN, type CoinCapBar, compositeBars } from './indices.ts';
import type { PairBook, PricePair } from './pairs.ts';
import { RATIO_OF } from './symbols.ts';
import type { CoinUniverse } from './universe.ts';

/** How often the market caps are worked out again while prices move. */
export const TICK_MS = 1_000;
/** After the last listener leaves, the coins' prices are followed this much longer. */
export const IDLE_MS = 30_000;
const ONE_MINUTE = parseResolution('1') as Resolution;

/** One live series: a symbol at an interval, its current bar and its listeners. */
interface Series {
  source: CapSource;
  resolution: Resolution;
  period: number;
  listeners: Set<(update: CandleUpdate) => void>;
  bar: Bar | null;
  seeded: boolean;
  seeding: boolean;
  /** Values that came while the bar was being seeded: its high, low and last since. */
  early: { high: number; low: number; close: number } | null;
}

export interface LiveCapsOptions {
  universe: CoinUniverse;
  anchors: AnchorBook;
  pairs: PairBook;
  adapters: ReadonlyMap<string, ExchangeAdapter>;
  history: CapHistory;
  now?: () => number;
  tickMs?: number;
  idleMs?: number;
  onWarning?: (message: string) => void;
}

/**
 * CRYPTOCAP's live values: while a symbol is watched, the largest coins' pairs are followed
 * through their exchanges' 1-minute candles (each candle's close is the latest trade), every
 * coin's market cap is its price in dollars times its supply (CoinGecko's own market cap for
 * coins we have no price for), and once a second the composites are added up again. Each
 * watched interval's bar starts from its history and moves with them.
 */
export class LiveCaps {
  private readonly universe: CoinUniverse;
  private readonly anchors: AnchorBook;
  private readonly pairs: PairBook;
  private readonly adapters: ReadonlyMap<string, ExchangeAdapter>;
  private readonly history: CapHistory;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly idleMs: number;
  private readonly warn: (message: string) => void;
  private readonly series = new Map<string, Series>();
  private readonly books = new Map<
    string,
    { source: CapSource; listeners: Set<(top: BookTop) => void> }
  >();
  private readonly stateListeners = new Set<(state: FeedState) => void>();
  /** Coin id → its latest price in the pair's quote, and the pair. */
  private readonly prices = new Map<string, { pair: PricePair; price: number }>();
  /** Coin id → how to stop following its pair. */
  private readonly following = new Map<string, Unsubscribe>();
  /** The coins followed were picked from the coins fetched at this time. */
  private followedFrom: number | null = null;
  /** Coins looked at in that pick, followed or not (no pair): a watched coin not among them
   * is picked at once. */
  private looked = new Set<string>();
  private readonly feedWatch: Unsubscribe[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private lastState: FeedState | null = null;

  constructor(options: LiveCapsOptions) {
    this.universe = options.universe;
    this.anchors = options.anchors;
    this.pairs = options.pairs;
    this.adapters = options.adapters;
    this.history = options.history;
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.warn = options.onWarning ?? (() => {});
  }

  subscribeCandles(
    key: string,
    source: CapSource,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    const period = resolutionDurationMs(resolution);
    if (period === null) return () => {};
    const id = `${key}|${formatResolution(resolution)}`;
    let series = this.series.get(id);
    if (!series) {
      series = {
        source,
        resolution,
        period,
        listeners: new Set(),
        bar: null,
        seeded: false,
        seeding: false,
        early: null,
      };
      this.series.set(id, series);
    }
    const watched = series;
    watched.listeners.add(onUpdate);
    this.start();
    return () => {
      watched.listeners.delete(onUpdate);
      if (watched.listeners.size === 0) this.series.delete(id);
      this.stopIfIdle();
    };
  }

  /** The value as both Sell and Buy, as TradingView shows a computed index. */
  subscribeBook(key: string, source: CapSource, onBook: (top: BookTop) => void): Unsubscribe {
    let book = this.books.get(key);
    if (!book) {
      book = { source, listeners: new Set() };
      this.books.set(key, book);
    }
    const watched = book;
    watched.listeners.add(onBook);
    this.start();
    return () => {
      watched.listeners.delete(onBook);
      if (watched.listeners.size === 0) this.books.delete(key);
      this.stopIfIdle();
    };
  }

  /**
   * Live once there are coins to add up and the exchange Bitcoin's price comes from is
   * connected: without Bitcoin's price, TOTAL would stand still.
   */
  isUp(): boolean {
    if (this.universe.fetchedAt() === null) return false;
    const pair = this.pairs.pairFor('BTC');
    const adapter = pair ? this.adapters.get(pair.exchange) : undefined;
    return adapter ? adapter.isFeedUp() : true;
  }

  onState(listener: (state: FeedState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    if (this.feedWatch.length === 0) {
      this.lastState = this.isUp() ? 'up' : 'down';
      for (const adapter of this.adapters.values()) {
        this.feedWatch.push(adapter.onFeedState(() => this.checkState()));
      }
    }
    return () => this.stateListeners.delete(listener);
  }

  close(): void {
    this.stop();
    for (const stop of this.feedWatch.splice(0)) stop();
    this.series.clear();
    this.books.clear();
  }

  private checkState(): void {
    const state: FeedState = this.isUp() ? 'up' : 'down';
    if (state === this.lastState) return;
    this.lastState = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  private start(): void {
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.follow();
    // A newcomer gets its bar at the next tick, without waiting for a price to move.
    this.dirty = true;
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      this.timer.unref?.();
      queueMicrotask(() => this.tick());
    }
  }

  private stopIfIdle(): void {
    if (this.series.size > 0 || this.books.size > 0 || this.stopTimer !== undefined) return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = undefined;
      if (this.series.size === 0 && this.books.size === 0) this.stop();
    }, this.idleMs);
    this.stopTimer.unref?.();
  }

  private stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.stopTimer);
    this.timer = undefined;
    this.stopTimer = undefined;
    for (const stop of this.following.values()) stop();
    this.following.clear();
    this.prices.clear();
    this.followedFrom = null;
    this.looked = new Set();
  }

  /**
   * Follows the pairs of the 140 largest eligible coins, Tether's (for USDT prices) and any
   * coin watched on its own; picked again whenever the coins are fetched again.
   */
  private follow(): void {
    const fetchedAt = this.universe.fetchedAt();
    if (fetchedAt === null) return;
    const watched = [...this.series.values(), ...this.books.values()].flatMap((series) => {
      const id = coinOf(series.source);
      return id ? [id] : [];
    });
    if (fetchedAt === this.followedFrom && watched.every((id) => this.looked.has(id))) return;
    this.followedFrom = fetchedAt;
    const wanted = new Set(
      this.universe
        .coins()
        .filter((coin) => this.universe.isEligible(coin.id))
        .sort((a, b) => b.cap - a.cap)
        .slice(0, CANDIDATE_RANK)
        .map((coin) => coin.id),
    );
    const tether = this.universe.bySymbol('USDT');
    if (tether) wanted.add(tether.id);
    for (const id of watched) wanted.add(id);
    this.looked = wanted;
    for (const [id, stop] of this.following) {
      if (wanted.has(id)) continue;
      stop();
      this.following.delete(id);
      this.prices.delete(id);
    }
    for (const id of wanted) {
      if (this.following.has(id)) continue;
      const coin = this.universe.coin(id);
      const pair = coin ? this.pairs.pairFor(coin.symbol) : null;
      const adapter = pair ? this.adapters.get(pair.exchange) : undefined;
      if (!coin || !pair || !adapter) continue;
      this.following.set(
        id,
        adapter.subscribeCandles(pair.ticker, ONE_MINUTE, (update) =>
          this.onPrice(coin, pair, update.bar.close),
        ),
      );
    }
  }

  private onPrice(coin: MarketCoin, pair: PricePair, price: number): void {
    if (!(price > 0)) return;
    const dollars = price * this.rate(pair.quote);
    // CoinGecko's price says which coin this is; a pair far from it trades another one.
    const reference = this.universe.coin(coin.id)?.price ?? coin.price;
    if (coin.symbol !== 'USDT' && Math.abs(dollars / reference - 1) > PRICE_TOLERANCE) {
      this.pairs.reject(pair);
      this.following.get(coin.id)?.();
      this.following.delete(coin.id);
      this.prices.delete(coin.id);
      this.warn(
        `${pair.exchange}:${pair.ticker} is priced unlike CoinGecko's ${coin.id}; using CoinGecko's market cap`,
      );
      return;
    }
    this.prices.set(coin.id, { pair, price });
    this.dirty = true;
  }

  /** US dollars per unit of a quote: Tether at its own price, USDC at CoinGecko's. */
  private rate(quote: PricePair['quote']): number {
    if (quote === 'USD') return 1;
    const coin = this.universe.bySymbol(quote);
    if (!coin) return 1;
    const live = this.prices.get(coin.id);
    return live && live.pair.quote === 'USD' ? live.price : coin.price;
  }

  /** A coin's market cap now: its live price times its supply, or CoinGecko's own. */
  private capOf(coin: MarketCoin, sec: number): number {
    const live = this.prices.get(coin.id);
    if (!live) return coin.cap;
    const supply = this.anchors.supplyAt(coin.id, sec) ?? coin.supply;
    return live.price * this.rate(live.pair.quote) * supply;
  }

  private tick(): void {
    if (this.timer === undefined) return;
    this.universe.touch(); // watched symbols keep the coins fresh
    this.follow();
    if (!this.dirty) return;
    this.dirty = false;
    const now = this.now();
    const sec = now / 1000;
    const coins: CoinCapBar[] = [];
    const caps = new Map<string, number>();
    for (const coin of this.universe.coins()) {
      if (!this.universe.isEligible(coin.id)) continue;
      const cap = this.capOf(coin, sec);
      caps.set(coin.id, cap);
      coins.push({
        id: coin.id,
        open: cap,
        high: cap,
        low: cap,
        close: cap,
        volume: 0,
        stable: this.universe.isStable(coin.id),
      });
    }
    const composites = compositeBars(coins);
    const valueFor = (source: CapSource): number | null => {
      switch (source.kind) {
        case 'composite':
          return composites[source.name].close;
        case 'coin':
          return caps.get(source.id) ?? null;
        case 'ratio': {
          const bitcoin = caps.get(BITCOIN);
          return bitcoin ? composites[RATIO_OF[source.name]].close / bitcoin : null;
        }
        case 'dominance': {
          const part = valueFor(source.of);
          const total = composites.TOTAL.close;
          return part !== null && total > 0 ? (part / total) * 100 : null;
        }
      }
    };
    for (const series of this.series.values()) {
      const value = valueFor(series.source);
      if (value !== null && value > 0) this.move(series, value, now);
    }
    for (const book of this.books.values()) {
      const value = valueFor(book.source);
      if (value === null || !(value > 0)) continue;
      for (const listener of [...book.listeners]) listener({ bid: value, ask: value });
    }
  }

  /** Moves a series' bar to `value`: starting the bar from its history the first time. */
  private move(series: Series, value: number, now: number): void {
    const open = barOpenTime(series.resolution, now) / 1000;
    if (!series.seeded) {
      const early = series.early;
      series.early = early
        ? { high: Math.max(early.high, value), low: Math.min(early.low, value), close: value }
        : { high: value, low: value, close: value };
      this.seed(series, open);
      return;
    }
    const bar = series.bar;
    if (!bar || open > bar.time) {
      series.bar = { time: open, open: value, high: value, low: value, close: value, volume: 1 };
    } else if (open === bar.time) {
      bar.close = value;
      bar.high = Math.max(bar.high, value);
      bar.low = Math.min(bar.low, value);
    } else {
      return;
    }
    this.emit(series, now);
  }

  private seed(series: Series, open: number): void {
    if (series.seeding) return;
    series.seeding = true;
    const startMs = open * 1000;
    this.history.bars(series.source, series.resolution, startMs, startMs + series.period).then(
      (bars) => {
        series.seeding = false;
        if (series.listeners.size === 0) return;
        const from = bars.at(-1);
        const early = series.early;
        const bar: Bar =
          from && from.time === open
            ? { ...from }
            : {
                time: open,
                open: early?.close ?? 0,
                high: early?.high ?? 0,
                low: early?.low ?? 0,
                close: early?.close ?? 0,
                volume: 1,
              };
        if (early) {
          bar.close = early.close;
          bar.high = Math.max(bar.high, early.high);
          bar.low = Math.min(bar.low, early.low);
        }
        if (!(bar.close > 0)) return; // nothing to start from yet: the next tick tries again
        series.bar = bar;
        series.seeded = true;
        series.early = null;
        this.emit(series, this.now());
      },
      () => {
        series.seeding = false; // the next tick tries again
      },
    );
  }

  private emit(series: Series, now: number): void {
    const bar = series.bar;
    if (!bar) return;
    for (const listener of [...series.listeners]) listener({ bar: { ...bar }, eventTime: now });
  }
}

function coinOf(source: CapSource): string | null {
  if (source.kind === 'coin') return source.id;
  if (source.kind === 'dominance' && source.of.kind === 'coin') return source.of.id;
  return null;
}
