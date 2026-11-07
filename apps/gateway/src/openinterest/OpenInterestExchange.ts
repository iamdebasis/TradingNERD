import { join } from 'node:path';
import {
  type Bar,
  parseResolution,
  type Resolution,
  resolutionDurationMs,
  type SymbolInfo,
  UTC_CLOCK,
  UTC_ZONE,
} from '@tradingnerd/core';
import {
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type Unsubscribe,
} from '../market/types.ts';
import { oiBar, oiBarsBefore, oiBarsIn, withPolls } from './bars.ts';
import {
  dayRanges,
  daysOf,
  metaFile,
  type OiMeta,
  type OiPoint,
  OiSeries,
  STEP_MS,
} from './series.ts';
import type { Backfill, OiSource } from './sources.ts';
import { type OiContract, type OiExchange, parseOiTicker, unitDecimals } from './symbols.ts';

/**
 * The intervals open interest bars are built in; the gateway makes the others from these (a week
 * from days, 2 hours from 1). Nothing below 5 minutes: no exchange keeps finer history
 * (provisional, docs/SPEC.md §11).
 */
export const OI_RESOLUTIONS = ['5', '15', '30', '60', '240', '1D'] as const;

/** How often the open interest now is asked for while a chart shows it (the plan's 15 s). */
export const OI_POLL_MS = 15_000;
/** How often the exchange's own recent 5-minute points are recorded while one is watched. */
export const OI_RECORD_MS = 5 * 60_000;
/** Live polls kept, for the forming bars of every interval up to a day. */
const POLLS_KEPT_MS = 36 * 3_600_000;
/** After a failed download, the next request tries again once this has passed. */
const RETRY_BACKFILL_MS = 60_000;
/** Polls failing in a row before the feed counts as down. */
const DOWN_AFTER_FAILURES = 3;
const SAVE_DELAY_MS = 5_000;

export interface OpenInterestOptions {
  exchange: OiExchange;
  /** "Binance" */
  name: string;
  source: OiSource;
  /** The data folder; series go in its oi/ folder. */
  dataDir: string;
  now?: () => number;
  pollMs?: number;
  recordMs?: number;
  onWarning?: (message: string) => void;
}

interface Subscriber {
  resolution: Resolution;
  onUpdate: (update: CandleUpdate) => void;
}

interface Waiter {
  fromMs: number;
  resolve: () => void;
}

/** One perpetual's open interest as the gateway keeps it. */
class Tracked {
  readonly contract: OiContract;
  readonly series: OiSeries;
  readonly meta: ReturnType<typeof metaFile>;
  archiveFirst: string | null = null;
  archiveDays = new Set<string>();
  /** The open interest now, polled while a chart shows it, after the series' last point. */
  polls: OiPoint[] = [];
  /** Everything from here to now is in (while the download runs). */
  reach = Number.POSITIVE_INFINITY;
  state: 'idle' | 'running' | 'done' | 'failed' = 'idle';
  failedAt = 0;
  waiters: Waiter[] = [];
  readonly subscribers = new Set<Subscriber>();
  pollTimer: ReturnType<typeof setTimeout> | undefined;
  recordTimer: ReturnType<typeof setInterval> | undefined;
  saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(contract: OiContract, dir: string, warn: (message: string) => void) {
    this.contract = contract;
    this.series = new OiSeries(dir, warn);
    this.meta = metaFile(dir, warn);
  }

  /** Its points with the polls after them. */
  points() {
    return withPolls(this.series, this.polls);
  }
}

/**
 * An exchange's open interest symbols ("BINANCE:BTCUSDT.P_OI"), to the market service as an
 * exchange of their own (docs/SPEC.md §6.18): bars made from the exchange's points, history from
 * its API and Binance's archive kept in data/oi/, and the bar forming now from polls every 15 s.
 */
export class OpenInterestExchange implements ExchangeAdapter {
  readonly id: OiExchange;
  readonly name: string;
  readonly maxBarsPerRequest = 5_000;
  readonly nativeResolutions: readonly Resolution[] = OI_RESOLUTIONS.map(
    (text) => parseResolution(text) as Resolution,
  );

  private readonly source: OiSource;
  private readonly root: string;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly recordMs: number;
  private readonly warn: (message: string) => void;
  private readonly tracking = new Map<string, Promise<Tracked>>();
  private readonly ready = new Map<string, Tracked>();
  private readonly abort = new AbortController();
  private readonly feedListeners = new Set<(state: FeedState) => void>();
  private feedUp = true;
  private failures = 0;

  constructor(options: OpenInterestOptions) {
    this.id = options.exchange;
    this.name = options.name;
    this.source = options.source;
    this.root = join(options.dataDir, 'oi', options.exchange.toLowerCase());
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? OI_POLL_MS;
    this.recordMs = options.recordMs ?? OI_RECORD_MS;
    this.warn = options.onWarning ?? (() => {});
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const tracked = await this.track(ticker);
    return this.info(tracked.contract);
  }

  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const tracked = await this.track(ticker);
    const now = this.now();
    const span = resolutionDurationMs(resolution) ?? 31 * 86_400_000;
    const end = endTimeMs ?? UTC_CLOCK.next(resolution, UTC_CLOCK.open(resolution, now));
    await this.covered(tracked, end - limit * span);
    return oiBarsBefore(tracked.points(), resolution, endTimeMs, limit, now);
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const tracked = await this.track(ticker);
    await this.covered(tracked, startMs);
    return oiBarsIn(tracked.points(), resolution, startMs, endMs, this.maxBarsPerRequest);
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    const contract = parseOiTicker(this.id, ticker);
    const tracked = contract ? this.ready.get(contract.providerId) : undefined;
    // Every feed resolves its symbol before it subscribes.
    if (!tracked) return () => {};
    const subscriber: Subscriber = { resolution, onUpdate };
    tracked.subscribers.add(subscriber);
    this.startLive(tracked);
    return () => {
      tracked.subscribers.delete(subscriber);
      if (tracked.subscribers.size === 0) this.stopLive(tracked);
    };
  }

  /** Open interest isn't traded: its bars move with the polls. */
  subscribeTrades(): Unsubscribe {
    return () => {};
  }

  subscribeBook(): Unsubscribe {
    return () => {};
  }

  isFeedUp(): boolean {
    return this.feedUp;
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }

  /** Resolves once every download started so far has finished (tests and diagnostics). */
  async idle(): Promise<void> {
    for (const tracked of this.ready.values())
      await this.covered(tracked, Number.NEGATIVE_INFINITY);
  }

  async close(): Promise<void> {
    this.abort.abort();
    for (const tracked of this.ready.values()) {
      this.stopLive(tracked);
      clearTimeout(tracked.saveTimer);
      this.release(tracked, true);
      await this.save(tracked);
    }
  }

  private info(contract: OiContract): SymbolInfo {
    const decimals = unitDecimals(contract);
    return {
      id: `${this.id}:${contract.ticker}`,
      exchange: this.id,
      exchangeName: this.name,
      ticker: contract.ticker,
      base: contract.base,
      // What it's counted in, where that's a currency (provisional, docs/SPEC.md §11).
      quote: contract.unit === 'coin' ? contract.base : contract.unit === 'usd' ? 'USD' : '',
      // TradingView's symbol page: "BTCUSDT Open Interest" (its exact title provisional, §11).
      description: `${contract.pair} Open Interest`,
      type: 'index',
      tickSize: 10 ** -decimals,
      pricePrecision: decimals,
      format: 'volume',
      resolutions: [...OI_RESOLUTIONS],
      timezone: UTC_ZONE,
      delayMs: 0,
      hasBook: false,
    };
  }

  /** The perpetual behind a ticker, checked with the exchange once, its history loading. */
  private async track(ticker: string): Promise<Tracked> {
    const contract = parseOiTicker(this.id, ticker);
    if (!contract) {
      throw new MarketError('unknown_symbol', `${this.name} has no open interest symbol ${ticker}`);
    }
    const key = contract.providerId;
    let pending = this.tracking.get(key);
    if (!pending) {
      pending = this.load(contract);
      this.tracking.set(key, pending);
      pending.catch(() => {
        // Not found, or the exchange was unreachable: the next lookup asks again.
        if (this.tracking.get(key) === pending) this.tracking.delete(key);
      });
    }
    const tracked = await pending;
    this.startBackfill(tracked);
    return tracked;
  }

  private async load(contract: OiContract): Promise<Tracked> {
    const tracked = new Tracked(contract, join(this.root, contract.providerId), this.warn);
    await tracked.series.load();
    const meta = await tracked.meta.read();
    if (meta) {
      tracked.archiveFirst = meta.archiveFirst;
      tracked.archiveDays = daysOf(meta.archiveDays);
    }
    try {
      await this.source.check(contract);
    } catch (error) {
      // Kept history still shows while the exchange can't be reached; an unknown symbol doesn't.
      const unknown = error instanceof MarketError && error.code === 'unknown_symbol';
      if (unknown || tracked.series.first() === null) throw error;
      this.warn(`${contract.ticker}: showing kept history (${String(error)})`);
    }
    this.ready.set(contract.providerId, tracked);
    return tracked;
  }

  /** Brings a series up to date: the exchange's recent points, then what's older. */
  private startBackfill(tracked: Tracked): void {
    if (tracked.state === 'running' || tracked.state === 'done') return;
    if (tracked.state === 'failed' && this.now() - tracked.failedAt < RETRY_BACKFILL_MS) return;
    tracked.state = 'running';
    tracked.reach = Number.POSITIVE_INFINITY;
    void this.backfill(tracked);
  }

  private async backfill(tracked: Tracked): Promise<void> {
    const { contract } = tracked;
    const now = this.now();
    let failed = false;
    try {
      const last = tracked.series.last();
      const since = Math.max(now - this.source.recentWindowMs, (last ?? 0) - STEP_MS);
      tracked.series.put(await this.source.recent(contract, since));
      // Only what came counts as in: without it, those days wait for the older history (the
      // archive has them, a day behind).
      this.reached(tracked, now - this.source.recentWindowMs);
    } catch (error) {
      failed = true;
      this.warn(`${contract.ticker}: couldn't load recent open interest (${String(error)})`);
    }
    this.scheduleSave(tracked);
    try {
      await this.source.backfill(contract, this.into(tracked), this.abort.signal);
    } catch (error) {
      failed = true;
      if (!this.abort.signal.aborted) {
        this.warn(`${contract.ticker}: couldn't load older open interest (${String(error)})`);
      }
    }
    tracked.state = failed ? 'failed' : 'done';
    tracked.failedAt = failed ? this.now() : 0;
    this.release(tracked, true);
    this.scheduleSave(tracked, 0);
  }

  private into(tracked: Tracked): Backfill {
    return {
      put: (points) => {
        tracked.series.put(points);
        this.scheduleSave(tracked);
      },
      reached: (ms) => this.reached(tracked, ms),
      archive: {
        first: () => tracked.archiveFirst,
        setFirst: (day) => {
          tracked.archiveFirst = day;
          this.scheduleSave(tracked);
        },
        has: (day) => tracked.archiveDays.has(day),
        mark: (day) => {
          tracked.archiveDays.add(day);
          this.scheduleSave(tracked);
        },
      },
    };
  }

  private reached(tracked: Tracked, ms: number): void {
    tracked.reach = Math.min(tracked.reach, ms);
    this.release(tracked, false);
  }

  /** Lets go of the requests waiting for history now in (or for all, once the download ends). */
  private release(tracked: Tracked, all: boolean): void {
    const waiting = tracked.waiters;
    tracked.waiters = [];
    for (const waiter of waiting) {
      if (all || waiter.fromMs >= tracked.reach) waiter.resolve();
      else tracked.waiters.push(waiter);
    }
  }

  /** Resolves once the series holds everything from `fromMs` the exchange has. */
  private covered(tracked: Tracked, fromMs: number): Promise<void> {
    if (tracked.state !== 'running' || tracked.reach <= fromMs) return Promise.resolve();
    return new Promise((resolve) => tracked.waiters.push({ fromMs, resolve }));
  }

  private startLive(tracked: Tracked): void {
    if (tracked.pollTimer !== undefined || this.abort.signal.aborted) return;
    const poll = async () => {
      try {
        const point = await this.source.current(tracked.contract);
        this.addPoll(tracked, point);
        this.feedOk();
      } catch (error) {
        this.feedFailed(tracked, error);
      }
      if (tracked.subscribers.size > 0 && !this.abort.signal.aborted) {
        tracked.pollTimer = setTimeout(poll, this.pollMs);
      } else tracked.pollTimer = undefined;
    };
    tracked.pollTimer = setTimeout(poll, 0);
    tracked.recordTimer = setInterval(() => void this.record(tracked), this.recordMs);
  }

  private stopLive(tracked: Tracked): void {
    clearTimeout(tracked.pollTimer);
    clearInterval(tracked.recordTimer);
    tracked.pollTimer = undefined;
    tracked.recordTimer = undefined;
  }

  /** The exchange's own latest 5-minute points, kept: they outlast its window (recordings). */
  private async record(tracked: Tracked): Promise<void> {
    try {
      const last = tracked.series.last() ?? this.now() - 3_600_000;
      tracked.series.put(await this.source.recent(tracked.contract, last - STEP_MS));
      this.scheduleSave(tracked);
    } catch (error) {
      this.warn(`${tracked.contract.ticker}: couldn't record open interest (${String(error)})`);
    }
  }

  private addPoll(tracked: Tracked, point: OiPoint): void {
    const now = this.now();
    // The exchange's own time for it, unless it's off from ours by more than a poll.
    const time = Math.abs(point.time - now) < this.pollMs * 2 ? point.time : now;
    const last = tracked.polls.at(-1);
    if (last && time <= last.time) return;
    tracked.polls.push({ time, value: point.value });
    const keepFrom = now - POLLS_KEPT_MS;
    if ((tracked.polls[0]?.time ?? now) < keepFrom) {
      tracked.polls = tracked.polls.filter((p) => p.time >= keepFrom);
    }
    const points = tracked.points();
    for (const subscriber of tracked.subscribers) {
      const open = UTC_CLOCK.open(subscriber.resolution, time);
      const bar = oiBar(points, open, UTC_CLOCK.next(subscriber.resolution, open));
      if (bar) subscriber.onUpdate({ bar, eventTime: time });
    }
  }

  private feedOk(): void {
    this.failures = 0;
    if (this.feedUp) return;
    this.feedUp = true;
    for (const listener of [...this.feedListeners]) listener('up');
  }

  private feedFailed(tracked: Tracked, error: unknown): void {
    this.failures++;
    if (this.failures === 1) {
      this.warn(`${tracked.contract.ticker}: couldn't poll open interest (${String(error)})`);
    }
    if (this.failures < DOWN_AFTER_FAILURES || !this.feedUp) return;
    this.feedUp = false;
    for (const listener of [...this.feedListeners]) listener('down');
  }

  private scheduleSave(tracked: Tracked, delayMs = SAVE_DELAY_MS): void {
    if (delayMs > 0 && tracked.saveTimer !== undefined) return;
    clearTimeout(tracked.saveTimer);
    tracked.saveTimer = setTimeout(() => {
      tracked.saveTimer = undefined;
      void this.save(tracked);
    }, delayMs);
  }

  private async save(tracked: Tracked): Promise<void> {
    await tracked.series.save();
    const meta: OiMeta = {
      v: 1,
      archiveFirst: tracked.archiveFirst,
      archiveDays: dayRanges(tracked.archiveDays),
    };
    if (meta.archiveFirst === null && meta.archiveDays.length === 0) return;
    try {
      await tracked.meta.write(meta);
    } catch (error) {
      this.warn(`${tracked.contract.ticker}: couldn't save its archive days (${String(error)})`);
    }
  }
}
