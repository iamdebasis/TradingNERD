import type { Bar, BarsResponse, StreamState } from '@tradingnerd/core';
import { type Coalescer, createCoalescer } from './coalesce.ts';
import { Feed } from './feed.ts';
import type { MarketError, Unsubscribe } from './types.ts';

export interface QuoteListener {
  /** `prevClose`: the previous daily bar's close, or null while unknown (e.g. listed today). */
  onQuote(last: number, prevClose: number | null): void;
  onState(state: StreamState): void;
  onError(error: MarketError): void;
}

/** What a quote needs from the market service: the symbol's daily bars. */
export interface DailyBars {
  /** The shared live daily bar feed. */
  subscribe(listener: {
    onBar(bar: Bar, historical: boolean): void;
    onState(state: StreamState): void;
    onError(error: MarketError): void;
  }): Unsubscribe;
  /** The latest daily bars over REST: the previous one and the live one. */
  fetchRecent(): Promise<BarsResponse>;
}

/**
 * A watchlist row's quote: the live price, and the previous daily bar's close that TradingView
 * measures Chg and Chg% against. It rides on the symbol's shared daily bar feed, so a row and a
 * daily chart of the same symbol always show the same price. When a new day starts, the old
 * day's last price becomes the previous close, and the exchange's late final candle corrects
 * it. Nothing goes out until the previous close is known (or failed to load), so a row never
 * flickers from no change to its change; after that, at most one update per window.
 */
export class QuoteFeed extends Feed<QuoteListener> {
  private readonly daily: DailyBars;
  private readonly coalescer: Coalescer<[number, number | null]>;
  private last: number | null = null;
  private prevClose: number | null = null;
  /** The REST answer for the previous close is in, or failed. */
  private prevSettled = false;
  /** Open time of the live daily bar, and of the one before it (UTC s). */
  private day: number | null = null;
  private prevDay: number | null = null;
  /** The last quote handed on, so trades that change neither number send nothing. */
  private pushed: { last: number; prevClose: number | null } | null = null;

  constructor(daily: DailyBars, emitIntervalMs: number, onDispose: () => void) {
    super(onDispose);
    this.daily = daily;
    this.coalescer = createCoalescer(emitIntervalMs, ([last, prevClose]) =>
      this.broadcast((listener) => listener.onQuote(last, prevClose)),
    );
  }

  start(): void {
    this.unsubscribes.push(
      this.daily.subscribe({
        onBar: (bar, historical) => this.onBar(bar, historical),
        onState: (state) => this.setState(state),
        onError: (error) => this.fail(error),
      }),
    );
    this.daily.fetchRecent().then(
      ({ bars }) => this.seedPrevious(bars),
      () => {
        // Chg stays blank until the day rolls over; the daily feed reports real failures.
        this.prevSettled = true;
        this.emit();
      },
    );
  }

  private onBar(bar: Bar, historical: boolean): void {
    if (historical) {
      if (bar.time === this.prevDay) {
        this.prevClose = bar.close;
        this.emit();
      }
      return;
    }
    if (this.day !== null && bar.time < this.day) return;
    if (this.day !== null && bar.time > this.day) {
      this.prevDay = this.day;
      this.prevClose = this.last;
    }
    this.day = bar.time;
    this.last = bar.close;
    this.emit();
  }

  /** `bars`: the latest daily bars, ascending; the last one is live. */
  private seedPrevious(bars: readonly Bar[]): void {
    if (this.disposed) return;
    this.prevSettled = true;
    const live = bars.at(-1);
    const previous = bars.at(-2);
    // Unless the stream already moved on to a later day, whose rollover set the previous close.
    if (live && (this.day === null || live.time >= this.day)) {
      if (previous) {
        this.prevDay = previous.time;
        this.prevClose = previous.close;
      }
      if (this.last === null) {
        this.day = live.time;
        this.last = live.close;
      }
    }
    this.emit();
  }

  private emit(): void {
    if (!this.prevSettled || this.last === null) return;
    if (this.pushed?.last === this.last && this.pushed.prevClose === this.prevClose) return;
    this.pushed = { last: this.last, prevClose: this.prevClose };
    this.coalescer.push([this.last, this.prevClose]);
  }

  protected replay(listener: QuoteListener): void {
    if (this.prevSettled && this.last !== null) listener.onQuote(this.last, this.prevClose);
  }

  protected cleanup(): void {
    this.coalescer.cancel();
  }
}
