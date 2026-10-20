import { type Bar, type BarClock, type Resolution, resampleBars } from '@tradingnerd/core';
import type { CandleUpdate, FeedState, Unsubscribe } from '../market/types.ts';
import type { AlpacaClient } from './alpaca.ts';

const MINUTE = 60_000;
const DAY: Resolution = { count: 1, unit: 'day' };
/** Polls run this long after each minute, so the minute that just ended is in. */
const AFTER_MINUTE_MS = 5_000;
/** A new subscription's first poll waits this long, so a watchlist's rows go in one request. */
const GATHER_MS = 250;
/** Failed polls in a row before the feed counts as down. */
const FAILURES_DOWN = 2;

interface Subscription {
  resolution: Resolution;
  onUpdate: (update: CandleUpdate) => void;
  /** The last bar handed on, so an unchanged one isn't sent again. */
  sent: Bar | null;
}

interface SymbolState {
  subscriptions: Set<Subscription>;
  /** The session's regular-hours minute bars, by open time (s). */
  minutes: Map<number, Bar>;
  /** Open (ms) of the session they belong to. */
  session: number | null;
  /** Open (ms) of the last minute fetched; null until the session's first fetch. */
  through: number | null;
  /** Close (ms) of the session whose official daily bar has been sent. */
  finalFor: number | null;
}

export interface MinutePollerOptions {
  client: Pick<AlpacaClient, 'bars' | 'latestAvailable'>;
  /** Regular-hours bars (the calendar may arrive after the poller starts). */
  clock: () => BarClock;
  now?: () => number;
  /** Symbols per request. */
  batch?: number;
  onWarning?: (message: string) => void;
}

const sameBar = (a: Bar | null, b: Bar) =>
  a !== null &&
  a.time === b.time &&
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close &&
  a.volume === b.volume;

/**
 * Live bars for stocks, from minute bars polled once a minute: each poll fetches the minutes
 * that have just become available (15 minutes back on Alpaca's free plan) for every
 * subscribed symbol in one request, and each subscription's current bar is the fold of its
 * period's minutes in regular hours. When a session ends its daily bars are replaced by
 * Alpaca's official ones, whose close is the exchange's closing price.
 */
export class MinutePoller {
  private readonly client: Pick<AlpacaClient, 'bars' | 'latestAvailable'>;
  private readonly clock: () => BarClock;
  private readonly now: () => number;
  private readonly batch: number;
  private readonly warn: (message: string) => void;
  private readonly symbols = new Map<string, SymbolState>();
  private readonly stateListeners = new Set<(state: FeedState) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | null = null;
  /** A poll was asked for while one ran (new subscriptions): run another after it. */
  private again = false;
  private failures = 0;
  private up = true;
  private closed = false;

  constructor(options: MinutePollerOptions) {
    this.client = options.client;
    this.clock = options.clock;
    this.now = options.now ?? Date.now;
    this.batch = options.batch ?? 100;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Live `resolution` bars of `symbol` (1, 5, 15 or 30 minutes, or a day). */
  subscribe(
    symbol: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = {
        subscriptions: new Set(),
        minutes: new Map(),
        session: null,
        through: null,
        finalFor: null,
      };
      this.symbols.set(symbol, state);
    }
    const subscription: Subscription = { resolution, onUpdate, sent: null };
    state.subscriptions.add(subscription);
    this.schedule(GATHER_MS);
    return () => {
      const current = this.symbols.get(symbol);
      if (!current) return;
      current.subscriptions.delete(subscription);
      if (current.subscriptions.size === 0) this.symbols.delete(symbol);
      if (this.symbols.size === 0) clearTimeout(this.timer);
    };
  }

  isUp(): boolean {
    return this.up;
  }

  onState(listener: (state: FeedState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Polls now (tests, and a new key); a poll asked for during one runs right after it. */
  pollNow(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.polling = (async () => {
      do {
        this.again = false;
        await this.poll();
      } while (this.again && !this.closed);
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.symbols.clear();
  }

  private schedule(delayMs?: number): void {
    if (this.closed || this.symbols.size === 0) return;
    clearTimeout(this.timer);
    const now = this.now();
    const wait = delayMs ?? Math.floor(now / MINUTE) * MINUTE + MINUTE + AFTER_MINUTE_MS - now;
    this.timer = setTimeout(() => {
      void this.pollNow().finally(() => this.schedule());
    }, wait);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.symbols.size === 0) return;
    const clock = this.clock();
    const available = this.client.latestAvailable();
    const session = clock.open(DAY, available);
    const close = clock.close(DAY, session);
    const over = available >= close;
    // The last whole minute available, within the session.
    const last = Math.min(Math.floor(available / MINUTE) * MINUTE - MINUTE, close - MINUTE);
    for (const state of this.symbols.values()) {
      if (state.session === session) continue;
      state.session = session;
      state.minutes.clear();
      state.finalFor = null;
      // A session that has ended needs no minutes: its bars are history.
      state.through = over ? last : null;
    }
    try {
      const due = [...this.symbols.entries()].filter(
        ([, state]) => state.through === null || state.through < last,
      );
      for (let i = 0; i < due.length; i += this.batch) {
        await this.fetchMinutes(due.slice(i, i + this.batch), clock, session, close, last);
      }
      if (over) await this.fetchFinals(clock, session, close);
      this.succeeded();
    } catch (error) {
      this.failed(error);
    }
  }

  private async fetchMinutes(
    states: [string, SymbolState][],
    clock: BarClock,
    session: number,
    close: number,
    last: number,
  ): Promise<void> {
    if (last < session) return; // nothing traded yet this session
    const from = Math.min(
      ...states.map(([, state]) => (state.through === null ? session : state.through + MINUTE)),
    );
    const minutes = (last - from) / MINUTE + 1;
    const bars = await this.client.bars(
      states.map(([symbol]) => symbol),
      {
        timeframe: '1Min',
        start: from,
        end: last + MINUTE - 1,
        limit: states.length * minutes + 10,
        sort: 'asc',
      },
    );
    for (const [symbol, state] of states) {
      for (const bar of bars.get(symbol) ?? []) {
        const at = bar.time * 1000;
        if (at >= session && at < close && clock.isOpen(at)) state.minutes.set(bar.time, bar);
      }
      state.through = last;
      for (const subscription of state.subscriptions) this.emit(subscription, state, clock, last);
    }
  }

  /** Each subscription's current bar: its period's minutes, folded. */
  private emit(
    subscription: Subscription,
    state: SymbolState,
    clock: BarClock,
    last: number,
  ): void {
    let latest: number | null = null;
    for (const time of state.minutes.keys()) if (latest === null || time > latest) latest = time;
    if (latest === null) return;
    const open = clock.open(subscription.resolution, latest * 1000);
    const end = clock.close(subscription.resolution, open);
    const inPeriod = [...state.minutes.values()]
      .filter((bar) => bar.time * 1000 >= open && bar.time * 1000 < end)
      .sort((a, b) => a.time - b.time);
    const [bar] = resampleBars(inPeriod, subscription.resolution, clock);
    if (!bar || sameBar(subscription.sent, bar)) return;
    subscription.sent = bar;
    subscription.onUpdate({ bar: { ...bar }, eventTime: last + MINUTE });
  }

  /** After a session: Alpaca's official daily bars, for the daily subscriptions. */
  private async fetchFinals(clock: BarClock, session: number, close: number): Promise<void> {
    const due = [...this.symbols.entries()].filter(
      ([, state]) =>
        state.finalFor !== close &&
        [...state.subscriptions].some((subscription) => subscription.resolution.unit === 'day'),
    );
    const date = new Date(session).toISOString().slice(0, 10);
    for (let i = 0; i < due.length; i += this.batch) {
      const states = due.slice(i, i + this.batch);
      const bars = await this.client.bars(
        states.map(([symbol]) => symbol),
        {
          timeframe: '1Day',
          start: session - 86_400_000,
          end: close,
          limit: states.length * 2 + 4,
          sort: 'asc',
        },
      );
      for (const [symbol, state] of states) {
        state.finalFor = close;
        const official = (bars.get(symbol) ?? []).find(
          (bar) => new Date(bar.time * 1000).toISOString().slice(0, 10) === date,
        );
        if (!official) continue;
        const bar = { ...official, time: session / 1000 };
        for (const subscription of state.subscriptions) {
          if (subscription.resolution.unit !== 'day' || sameBar(subscription.sent, bar)) continue;
          if (clock.open(subscription.resolution, session) !== session) continue;
          subscription.sent = bar;
          subscription.onUpdate({ bar: { ...bar }, eventTime: close });
        }
      }
    }
  }

  private succeeded(): void {
    this.failures = 0;
    if (!this.up) this.setUp(true);
  }

  private failed(error: unknown): void {
    this.failures++;
    const detail = error instanceof Error ? error.message : String(error);
    this.warn(`Stock prices couldn't be fetched (${detail})`);
    if (this.up && this.failures >= FAILURES_DOWN) this.setUp(false);
  }

  private setUp(up: boolean): void {
    this.up = up;
    for (const listener of this.stateListeners) listener(up ? 'up' : 'down');
  }
}
