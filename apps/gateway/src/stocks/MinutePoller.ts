import {
  type Bar,
  type BarClock,
  type MarketSchedule,
  type Resolution,
  resampleBars,
  type Session,
  type SessionHours,
} from '@tradingnerd/core';
import type { CandleUpdate, FeedState, Unsubscribe } from '../market/types.ts';
import type { AlpacaClient } from './alpaca.ts';

const MINUTE = 60_000;
/** Polls run this long after each minute, so the minute that just ended is in. */
const AFTER_MINUTE_MS = 5_000;
/** A new subscription's first poll waits this long, so a watchlist's rows go in one request. */
const GATHER_MS = 250;
/** Failed polls in a row before the feed counts as down. */
const FAILURES_DOWN = 2;
const SESSION_HOURS: readonly SessionHours[] = ['regular', 'extended'];

interface Subscription {
  resolution: Resolution;
  /** The hours its bars cover (day bars: the regular session either way). */
  hours: SessionHours;
  onUpdate: (update: CandleUpdate) => void;
  /** The last bar handed on, so an unchanged one isn't sent again. */
  sent: Bar | null;
  /** Open (s) of the newest minute in its hours that its last bar was built from. */
  latest: number | null;
}

interface SymbolState {
  subscriptions: Set<Subscription>;
  /** The hours its minutes cover: extended while any subscription wants them. */
  hours: SessionHours;
  /** The session's minute bars in those hours, by open time (s). */
  minutes: Map<number, Bar>;
  /** Open (ms) of the session they belong to. */
  session: number | null;
  /** Open (ms) of the last minute fetched; null until the session's first fetch. */
  through: number | null;
  /** Close (ms) of the regular session whose official daily bar has been sent. */
  finalFor: number | null;
}

export interface MinutePollerOptions {
  client: Pick<AlpacaClient, 'bars' | 'latestAvailable'>;
  /** Bars of each session's hours (the calendar may arrive after the poller starts). */
  clock: (hours: SessionHours) => BarClock;
  /** The trading calendar, for the sessions' hours. */
  schedule: () => MarketSchedule;
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

/** The last whole minute available (ms) within `session`. */
const lastMinute = (session: Session, available: number) =>
  Math.min(Math.floor(available / MINUTE) * MINUTE - MINUTE, session.close - MINUTE);

/**
 * Live bars for stocks, from minute bars polled once a minute: each poll fetches the minutes
 * that have just become available (15 minutes back on Alpaca's free plan) for every
 * subscribed symbol, in one request per batch, and each subscription's current bar is the
 * fold of its period's minutes in its hours. A symbol's minutes cover the pre- and
 * post-market while any of its subscriptions wants them. When a regular session ends its
 * daily bars are replaced by Alpaca's official ones, whose close is the exchange's closing
 * price.
 */
export class MinutePoller {
  private readonly client: Pick<AlpacaClient, 'bars' | 'latestAvailable'>;
  private readonly clock: (hours: SessionHours) => BarClock;
  private readonly calendar: () => MarketSchedule;
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
    this.calendar = options.schedule;
    this.now = options.now ?? Date.now;
    this.batch = options.batch ?? 100;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Live `resolution` bars of `symbol` (1, 5, 15 or 30 minutes, or a day) in `hours`. */
  subscribe(
    symbol: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
    hours: SessionHours = 'regular',
  ): Unsubscribe {
    let state = this.symbols.get(symbol);
    if (!state) {
      state = {
        subscriptions: new Set(),
        hours: 'regular',
        minutes: new Map(),
        session: null,
        through: null,
        finalFor: null,
      };
      this.symbols.set(symbol, state);
    }
    const subscription: Subscription = { resolution, hours, onUpdate, sent: null, latest: null };
    state.subscriptions.add(subscription);
    this.fitHours(state);
    this.schedule(GATHER_MS);
    return () => {
      const current = this.symbols.get(symbol);
      if (!current) return;
      current.subscriptions.delete(subscription);
      if (current.subscriptions.size === 0) this.symbols.delete(symbol);
      else this.fitHours(current);
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

  /** Extended hours while any subscription wants them; a change starts the session over. */
  private fitHours(state: SymbolState): void {
    const hours = [...state.subscriptions].some((s) => s.hours === 'extended')
      ? 'extended'
      : 'regular';
    if (hours === state.hours) return;
    state.hours = hours;
    state.session = null;
    state.minutes.clear();
    state.through = null;
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
    const schedule = this.calendar();
    const available = this.client.latestAvailable();
    const sessions: Record<SessionHours, Session> = {
      regular: schedule.sessionAtOrBefore(available, 'regular'),
      extended: schedule.sessionAtOrBefore(available, 'extended'),
    };
    for (const state of this.symbols.values()) {
      const session = sessions[state.hours];
      if (state.session === session.open) continue;
      state.session = session.open;
      state.minutes.clear();
      // A session that has ended needs no minutes: its bars are history.
      state.through = available >= session.close ? lastMinute(session, available) : null;
    }
    try {
      for (const hours of SESSION_HOURS) {
        const session = sessions[hours];
        const last = lastMinute(session, available);
        const due = [...this.symbols.entries()].filter(
          ([, state]) => state.hours === hours && (state.through === null || state.through < last),
        );
        for (let i = 0; i < due.length; i += this.batch) {
          await this.fetchMinutes(due.slice(i, i + this.batch), session, last);
        }
      }
      if (available >= sessions.regular.close) await this.fetchFinals(sessions.regular);
      this.succeeded();
    } catch (error) {
      this.failed(error);
    }
  }

  private async fetchMinutes(
    states: [string, SymbolState][],
    session: Session,
    last: number,
  ): Promise<void> {
    if (last < session.open) return; // nothing traded yet this session
    const from = Math.min(
      ...states.map(([, state]) =>
        state.through === null ? session.open : state.through + MINUTE,
      ),
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
        if (at >= session.open && at < session.close) state.minutes.set(bar.time, bar);
      }
      state.through = last;
      for (const subscription of state.subscriptions) this.emit(subscription, state, last);
    }
  }

  /**
   * A subscription's current bar: its period's minutes in its hours, folded. Sent only when a
   * newer minute is in, so a day's official bar stays once the regular session is over.
   */
  private emit(subscription: Subscription, state: SymbolState, last: number): void {
    const clock = this.clock(subscription.hours);
    let latest: number | null = null;
    for (const time of state.minutes.keys()) {
      if ((latest === null || time > latest) && clock.isOpen(time * 1000)) latest = time;
    }
    if (latest === null || latest === subscription.latest) return;
    subscription.latest = latest;
    const open = clock.open(subscription.resolution, latest * 1000);
    const end = clock.close(subscription.resolution, open);
    const inPeriod = [...state.minutes.values()]
      .filter(
        (bar) => bar.time * 1000 >= open && bar.time * 1000 < end && clock.isOpen(bar.time * 1000),
      )
      .sort((a, b) => a.time - b.time);
    const [bar] = resampleBars(inPeriod, subscription.resolution, clock);
    if (!bar || sameBar(subscription.sent, bar)) return;
    subscription.sent = bar;
    subscription.onUpdate({ bar: { ...bar }, eventTime: last + MINUTE });
  }

  /** After a regular session: Alpaca's official daily bars, for the daily subscriptions. */
  private async fetchFinals(session: Session): Promise<void> {
    const clock = this.clock('regular');
    const due = [...this.symbols.entries()].filter(
      ([, state]) =>
        state.finalFor !== session.close &&
        [...state.subscriptions].some((subscription) => subscription.resolution.unit === 'day'),
    );
    const date = new Date(session.open).toISOString().slice(0, 10);
    for (let i = 0; i < due.length; i += this.batch) {
      const states = due.slice(i, i + this.batch);
      const bars = await this.client.bars(
        states.map(([symbol]) => symbol),
        {
          timeframe: '1Day',
          start: session.open - 86_400_000,
          end: session.close,
          limit: states.length * 2 + 4,
          sort: 'asc',
        },
      );
      for (const [symbol, state] of states) {
        state.finalFor = session.close;
        const official = (bars.get(symbol) ?? []).find(
          (bar) => new Date(bar.time * 1000).toISOString().slice(0, 10) === date,
        );
        if (!official) continue;
        const bar = { ...official, time: session.open / 1000 };
        for (const subscription of state.subscriptions) {
          if (subscription.resolution.unit !== 'day' || sameBar(subscription.sent, bar)) continue;
          if (clock.open(subscription.resolution, session.open) !== session.open) continue;
          subscription.sent = bar;
          subscription.onUpdate({ bar: { ...bar }, eventTime: session.close });
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
