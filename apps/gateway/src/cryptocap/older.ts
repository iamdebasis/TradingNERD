import { join } from 'node:path';
import type { Bar, OlderCapsStatus } from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';
import { JsonFile } from '../storage/jsonFile.ts';
import { maskKey, type SecretStore } from '../storage/secrets.ts';
import {
  type CoinPoint,
  LiveCoinWatchClient,
  LiveCoinWatchError,
  type MarketPoint,
} from './livecoinwatch.ts';

/** The CRYPTOCAP symbols older history is kept for: what Live Coin Watch's market gives. */
export const OLDER_SERIES = ['TOTAL', 'TOTAL2', 'TOTAL3', 'BTC.D'] as const;
export type OlderSeries = (typeof OLDER_SERIES)[number];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Live Coin Watch's market history starts here (measured 2026-10-25). */
export const OLDER_ORIGIN_MS = Date.UTC(2013, 4, 1);
/** Ethereum's first point there; before it, TOTAL3 is TOTAL2. */
export const ETHEREUM_START_MS = Date.UTC(2015, 7, 8);
/** A request's span: 4 days come an hour apart, so each day's bar has 25 points. */
const WINDOW_DAYS = 4;
/** Days past the join fetched too, so the join day itself is there to blend against. */
const PAST_JOIN_DAYS = 4;
/** Over this many days before the join, older bars move toward ours, so the chart has no step. */
export const BLEND_DAYS = 30;
/** A day's bar needs points this close to its start and its end. */
const EDGE_MS = 3 * HOUR_MS;
/** Windows between saves. */
const SAVE_EVERY = 10;
/** Waits after a failed request, then the last one again and again. */
const RETRY_MS = [10_000, 60_000, 300_000];
/**
 * A pause after each request: Live Coin Watch turns a key away (429) when it asks faster than
 * about 0.4 a second for long (measured 2026-10-25), so the whole download takes about two hours.
 */
const GAP_MS = 2_500;
/** The wait after Live Coin Watch asks to slow down, while the day's requests aren't used up. */
const SLOW_DOWN_MS = 30_000;

/** A stored day: [open time (UTC s), open, high, low, close]. */
type StoredDay = [number, number, number, number, number];

interface Stored {
  version: 1;
  /** The days downloaded, [first day, end day) in epoch ms, without gaps. */
  covered: [number, number] | null;
  days: Record<OlderSeries, StoredDay[]>;
}

const emptyDays = (): Record<OlderSeries, StoredDay[]> => ({
  TOTAL: [],
  TOTAL2: [],
  TOTAL3: [],
  'BTC.D': [],
});

const isStoredDay = (value: unknown): value is StoredDay =>
  Array.isArray(value) &&
  value.length === 5 &&
  value.every((part) => typeof part === 'number' && Number.isFinite(part));

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, covered, days } = value as Record<string, unknown>;
  if (version !== 1 || typeof days !== 'object' || days === null) return null;
  let span: Stored['covered'] = null;
  if (covered !== null) {
    if (!Array.isArray(covered) || covered.length !== 2) return null;
    const [from, to] = covered as unknown[];
    if (typeof from !== 'number' || typeof to !== 'number' || !(from <= to)) return null;
    span = [from, to];
  }
  const parsed: Stored = { version: 1, covered: span, days: emptyDays() };
  for (const series of OLDER_SERIES) {
    const list = (days as Record<string, unknown>)[series];
    if (!Array.isArray(list) || !list.every(isStoredDay)) return null;
    parsed.days[series] = list;
  }
  return parsed;
}

/** Eight significant digits: plenty, and a third of the file. */
const compact = (value: number) => Number(value.toPrecision(8));

/**
 * A series' days with none missing between its first and its last: a day Live Coin Watch has
 * no points for repeats the close before it, as CRYPTOCAP has a bar every day.
 */
function withoutGaps(days: readonly StoredDay[]): StoredDay[] {
  const out: StoredDay[] = [];
  for (const day of days) {
    const before = out.at(-1);
    if (before) {
      const close = before[4];
      for (let time = before[0] + DAY_MS / 1000; time < day[0]; time += DAY_MS / 1000) {
        out.push([time, close, close, close, close]);
      }
    }
    out.push(day);
  }
  return out;
}

/** The day (epoch ms) holding `ms`, UTC. */
const dayOf = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * Each day's bar of each series from Live Coin Watch's points: the whole market's market cap
 * (TOTAL), without Bitcoin's share (TOTAL2) and Ethereum's market cap (TOTAL3), and Bitcoin's
 * share in percent (BTC.D). A day runs from its midnight to the next, both points included: its
 * open the first, its close the last, its high and low the extremes between. A day without
 * points near its start and its end is left out.
 */
export function dayBars(
  market: readonly MarketPoint[],
  ethereum: readonly CoinPoint[],
  fromMs: number,
  toMs: number,
): Record<OlderSeries, StoredDay[]> {
  const out = emptyDays();
  const ethAt = (ms: number): number | null => {
    if (ms < ETHEREUM_START_MS) return 0;
    let best: CoinPoint | null = null;
    for (const point of ethereum) {
      if (!best || Math.abs(point.date - ms) < Math.abs(best.date - ms)) best = point;
    }
    return best && Math.abs(best.date - ms) <= 2 * HOUR_MS ? best.cap : null;
  };
  const valuesOf: Record<OlderSeries, (point: MarketPoint) => number | null> = {
    TOTAL: (point) => point.cap,
    TOTAL2: (point) => point.cap * (1 - point.btcDominance),
    TOTAL3: (point) => {
      const eth = ethAt(point.date);
      return eth === null ? null : point.cap * (1 - point.btcDominance) - eth;
    },
    'BTC.D': (point) => point.btcDominance * 100,
  };
  for (let day = dayOf(fromMs); day < toMs; day += DAY_MS) {
    const points = market.filter((point) => point.date >= day && point.date <= day + DAY_MS);
    const first = points[0];
    const last = points.at(-1);
    if (!first || !last || first.date > day + EDGE_MS || last.date < day + DAY_MS - EDGE_MS) {
      continue;
    }
    for (const series of OLDER_SERIES) {
      const values = points.map(valuesOf[series]).filter((v): v is number => v !== null && v > 0);
      const open = valuesOf[series](first);
      const close = valuesOf[series](last);
      if (open === null || close === null || !(open > 0) || !(close > 0)) continue;
      out[series].push([
        day / 1000,
        compact(open),
        compact(Math.max(...values)),
        compact(Math.min(...values)),
        compact(close),
      ]);
    }
  }
  return out;
}

/**
 * How far a day's older bar moves toward ours: all the way at the join, not at all 30 days
 * before it, in a straight line between. `ratio` is ours ÷ older at the join, less 1.
 */
export function blendFactor(dayMs: number, joinMs: number, ratio: number): number {
  const weight = Math.max(0, 1 - (joinMs - dayMs) / (BLEND_DAYS * DAY_MS));
  return 1 + ratio * weight;
}

export interface OlderCapsOptions {
  secrets: SecretStore;
  dataDir: string;
  /** The first day of our own daily history: older bars end there (epoch ms). */
  joinMs: () => number;
  /** Our own close of a series on the join day, to blend toward; null while unknown. */
  ours: (series: OlderSeries, joinMs: number) => Promise<number | null>;
  client?: LiveCoinWatchClient;
  /** Where downloads start (tests start later). */
  originMs?: number;
  /** The pause after each request, ms (GAP_MS). */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/**
 * TOTAL, TOTAL2, TOTAL3 and BTC.D before our own history begins (M9e, docs/SPEC.md §5.13): Live
 * Coin Watch's market caps, downloaded once with the user's free key, a day's bar from each
 * day's hourly points, back to May 2013. They're within a few percent of TradingView's
 * (§4.14), and over the 30 days before the join they move toward ours, so the chart has no
 * step. The download goes back from the join at Live Coin Watch's pace, saved as it goes and
 * carried on after a restart; it slows down when asked, and waits when the day's requests run
 * out. Kept in data/cryptocap/older.json.
 */
export class OlderCaps {
  private readonly secrets: SecretStore;
  private readonly joinMs: () => number;
  private readonly ours: OlderCapsOptions['ours'];
  private readonly client: LiveCoinWatchClient;
  private readonly originMs: number;
  private readonly gapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly file: JsonFile<Stored>;
  private stored: Stored = { version: 1, covered: null, days: emptyDays() };
  private loaded: Promise<void> | null = null;
  /** The latest start: starts run one after another, so only one claims the download. */
  private starting: Promise<void> = Promise.resolve();
  /** The download under way, if any; `stop` ends it at its next step. */
  private job: { done: Promise<void>; stop: () => void } | null = null;
  /** Every download started, settled once all have ended (stopped ones finish their window). */
  private downloads: Promise<void> = Promise.resolve();
  private state: OlderCapsStatus['state'] = 'none';
  private message: string | null = null;
  /** Whether days came in since the last save. */
  private unsaved = false;
  /** Each series' days with none missing (withoutGaps), until more come in. */
  private filled: Record<OlderSeries, StoredDay[]> | null = null;

  constructor(options: OlderCapsOptions) {
    this.secrets = options.secrets;
    this.joinMs = options.joinMs;
    this.ours = options.ours;
    this.client = options.client ?? new LiveCoinWatchClient();
    this.originMs = options.originMs ?? OLDER_ORIGIN_MS;
    this.gapMs = options.gapMs ?? GAP_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? (() => {});
    this.file = new JsonFile(join(options.dataDir, 'cryptocap', 'older.json'), parseStored, {
      indent: 0,
      onInvalid: (to) => this.warn(`The saved older market caps were unreadable; moved to ${to}`),
    });
  }

  load(): Promise<void> {
    this.loaded ??= this.file.read().then(
      (stored) => {
        if (stored) this.stored = stored;
        this.filled = null;
        if (this.complete()) this.state = 'done';
      },
      (error: unknown) => this.warn(`Couldn't read the saved older market caps (${error})`),
    );
    return this.loaded;
  }

  /** Starts the download, or carries it on, when there's a key and something left to fetch. */
  start(): Promise<void> {
    const run = this.starting.then(() => this.begin());
    this.starting = run.catch(() => {});
    return run;
  }

  /** Checks a key with Live Coin Watch, keeps it, and starts the download with it. */
  async saveKey(raw: string): Promise<OlderCapsStatus> {
    const key = raw.trim();
    if (!key) throw new MarketError('bad_request', 'Enter your Live Coin Watch key');
    try {
      await this.client.credits(key);
    } catch (error) {
      if (error instanceof LiveCoinWatchError && error.kind === 'rejected') {
        throw new MarketError('bad_request', 'Live Coin Watch rejected this key');
      }
      throw new MarketError('upstream_error', (error as Error).message);
    }
    await this.secrets.saveLiveCoinWatch(key);
    await this.starting;
    this.stopJob();
    if (this.state === 'error') this.setState('none', null);
    await this.start();
    return this.status();
  }

  /** Forgets the key; what was downloaded stays. */
  async removeKey(): Promise<OlderCapsStatus> {
    await this.secrets.removeLiveCoinWatch();
    await this.starting;
    this.stopJob();
    if (!this.complete()) this.setState('none', null);
    return this.status();
  }

  async status(): Promise<OlderCapsStatus> {
    await this.load();
    const key = await this.secrets.livecoinwatch();
    const covered = this.stored.covered;
    const total = Math.max(1, this.targetEndMs() - this.originMs);
    const have = covered
      ? Math.min(covered[1], this.targetEndMs()) - Math.max(covered[0], this.originMs)
      : 0;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const first = this.stored.days.TOTAL[0]?.[0];
    const last = this.stored.days.TOTAL.at(-1)?.[0];
    return {
      key: key ? { masked: maskKey(key.key), source: key.source } : null,
      state: this.state,
      progress: Math.max(0, Math.min(1, have / total)),
      from: first === undefined ? null : day(first * 1000),
      until: last === undefined ? null : day(last * 1000),
      message: this.message,
    };
  }

  /**
   * A series' older daily bars opening in [startMs, endMs), all before the join; over the 30
   * days before it, moved toward ours.
   */
  async bars(series: OlderSeries, startMs: number, endMs: number): Promise<Bar[]> {
    await this.load();
    const join = this.joinMs();
    const end = Math.min(endMs, join);
    if (startMs >= end) return [];
    const ratio = await this.ratio(series, join);
    const out: Bar[] = [];
    for (const [time, open, high, low, close] of this.days(series)) {
      const ms = time * 1000;
      if (ms < startMs) continue;
      if (ms >= end) break;
      const factor = ratio === null ? 1 : blendFactor(ms, join, ratio);
      out.push({
        time,
        open: open * factor,
        high: high * factor,
        low: low * factor,
        close: close * factor,
        // Counted as traded, as CapHistory's bars are, so weeks and months take every day.
        volume: 1,
      });
    }
    return out;
  }

  /** Resolves once the downloads started or starting have ended (tests and diagnostics). */
  async idle(): Promise<void> {
    await this.starting;
    await this.downloads;
  }

  /** Stops the download, keeping what came in. */
  async close(): Promise<void> {
    this.stopJob();
    await this.save();
  }

  // ----

  private async begin(): Promise<void> {
    await this.load();
    if (this.job || this.complete()) return;
    const key = await this.secrets.livecoinwatch();
    if (!key) return;
    let stopped = false;
    const done = this.download(key.key, () => stopped)
      .catch((error: unknown) => {
        this.warn(`The older market caps' download stopped (${error})`);
        this.setState('error', (error as Error).message);
      })
      .finally(() => {
        if (this.job?.done === done) this.job = null;
      });
    this.job = { done, stop: () => (stopped = true) };
    this.downloads = Promise.all([this.downloads, done]).then(() => {});
  }

  private stopJob(): void {
    this.job?.stop();
    this.job = null;
  }

  private setState(state: OlderCapsStatus['state'], message: string | null): void {
    this.state = state;
    this.message = message;
  }

  /** The end of what's wanted: a few days past the join, so the join day is in. */
  private targetEndMs(): number {
    return dayOf(this.joinMs()) + PAST_JOIN_DAYS * DAY_MS;
  }

  private complete(): boolean {
    const covered = this.stored.covered;
    return !!covered && covered[0] <= this.originMs && covered[1] >= this.targetEndMs();
  }

  private days(series: OlderSeries): StoredDay[] {
    if (!this.filled) {
      const filled = emptyDays();
      for (const name of OLDER_SERIES) filled[name] = withoutGaps(this.stored.days[name]);
      this.filled = filled;
    }
    return this.filled[series];
  }

  /**
   * Ours ÷ older on the join day, less 1: null while either is unknown. Asked each time, as
   * ours settles while our history loads (it's computed once and kept by CapHistory).
   */
  private async ratio(series: OlderSeries, join: number): Promise<number | null> {
    const older = this.days(series).find(([time]) => time * 1000 === join)?.[4];
    if (!older) return null;
    const ours = await this.ours(series, join).catch(() => null);
    return ours ? ours / older - 1 : null;
  }

  /** The windows still to fetch: first any days past what's covered, then back to the origin. */
  private windows(): [number, number][] {
    const end = this.targetEndMs();
    const covered = this.stored.covered;
    const windows: [number, number][] = [];
    const span = WINDOW_DAYS * DAY_MS;
    if (covered) {
      for (let from = covered[1]; from < end; from += span)
        windows.push([from, Math.min(from + span, end)]);
      for (let to = covered[0]; to > this.originMs; to -= span)
        windows.push([Math.max(to - span, this.originMs), to]);
    } else {
      for (let to = end; to > this.originMs; to -= span)
        windows.push([Math.max(to - span, this.originMs), to]);
    }
    return windows;
  }

  private async download(key: string, stopped: () => boolean): Promise<void> {
    this.setState('loading', null);
    let fetched = 0;
    windows: for (const [from, to] of this.windows()) {
      for (let attempt = 0; ; attempt++) {
        if (stopped()) break windows;
        try {
          const market = await this.client.market(key, from, to);
          await this.sleep(this.gapMs);
          let ethereum: CoinPoint[] = [];
          if (to > ETHEREUM_START_MS) {
            ethereum = await this.client.coin(key, 'ETH', from, to);
            await this.sleep(this.gapMs);
          }
          this.merge(dayBars(market, ethereum, from, to), from, to);
          if (this.message) this.setState('loading', null);
          break;
        } catch (error) {
          if (stopped()) break windows;
          if (error instanceof LiveCoinWatchError && error.kind === 'rejected') {
            this.setState('error', 'Live Coin Watch rejected the key');
            await this.save();
            return;
          }
          if (error instanceof LiveCoinWatchError && error.kind === 'limited') {
            await this.save();
            // Too fast, or the day's requests used up: those renew at UTC midnight.
            const left = await this.client.credits(key).catch(() => null);
            if (left !== null && left <= 0) {
              this.setState(
                'loading',
                "Waiting for Live Coin Watch's requests to renew at 00:00 UTC",
              );
              await this.sleep(dayOf(this.now()) + DAY_MS + 5 * 60_000 - this.now());
            } else {
              this.setState('loading', 'Live Coin Watch asked to slow down; going on in 30 s');
              await this.sleep(SLOW_DOWN_MS);
            }
            continue;
          }
          const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] as number;
          this.setState('loading', `${(error as Error).message}; trying again`);
          await this.sleep(wait);
        }
      }
      if (++fetched % SAVE_EVERY === 0) await this.save();
    }
    await this.save();
    if (this.complete()) this.setState('done', null);
  }

  /** A window's days into the store, and what's covered with it. */
  private merge(days: Record<OlderSeries, StoredDay[]>, from: number, to: number): void {
    for (const series of OLDER_SERIES) {
      const byTime = new Map(this.stored.days[series].map((day) => [day[0], day]));
      for (const day of days[series]) byTime.set(day[0], day);
      this.stored.days[series] = [...byTime.values()].sort((a, b) => a[0] - b[0]);
    }
    const covered = this.stored.covered;
    this.stored.covered = covered
      ? [Math.min(covered[0], from), Math.max(covered[1], to)]
      : [from, to];
    this.unsaved = true;
    this.filled = null;
  }

  /** Saves the days that came in since the last save, if any. */
  private async save(): Promise<void> {
    if (!this.unsaved) return;
    this.unsaved = false;
    await this.file.write(this.stored).catch((error: unknown) => {
      this.unsaved = true;
      this.warn(`Couldn't save the older market caps (${error})`);
    });
  }
}
