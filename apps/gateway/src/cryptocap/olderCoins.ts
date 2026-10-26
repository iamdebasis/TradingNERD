import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OlderCoinsStatus } from '@tradingnerd/core';
import { JsonFile } from '../storage/jsonFile.ts';
import type { SecretStore } from '../storage/secrets.ts';
import { ETH_ZURICH_CAPS, ETH_ZURICH_CLOSES, ETH_ZURICH_URL } from './ethzurich.ts';
import {
  type ListedCoin,
  LiveCoinWatchClient,
  LiveCoinWatchError,
  type PricedPoint,
} from './livecoinwatch.ts';

const DAY_MS = 86_400_000;
/** Live Coin Watch's part begins here, a week before the dataset ends, so the two overlap. */
export const COINS_FROM_MS = Date.UTC(2018, 1, 1);
/** …and reaches this many days past our own first day, so it overlaps ours too. */
const PAST_JOIN_DAYS = 7;
/** Coins a list request returns, at most (Live Coin Watch's limit). */
export const LIST_PAGE = 100;
/** A request's span when every day is wanted: about 100 points come back, a day apart. */
export const WINDOW_DAYS = 100;
/**
 * A listed coin may have been one of the 200 largest from 2018 on when its highest price ever
 * times its largest supply figure reaches this (at least what it was ever worth, mostly more):
 * the 200th coin was worth more in every month since (docs/SPEC.md §4.14).
 */
export const PEAK_MIN = 20e6;
/** Above this, a peak is no coin's worth: a price spike times a supply in the trillions. */
export const PEAK_MAX = 5e12;
/**
 * Looking at a group of coins stops once this many in a row never came within the 250 largest
 * of any month (of those looked at): the group's later ones are ever less likely.
 */
export const GIVE_UP_AFTER = 1_000;
/** The rank a coin must reach in some month for the looking to carry on. */
const NEAR_RANK = 250;
/** Coins ranked this high in some month get every day; stablecoins, this high among themselves. */
export const CHOSEN_RANK = 200;
export const CHOSEN_STABLE_RANK = 60;
/** Requests between saves. */
const SAVE_EVERY = 20;
/** Waits after a failed request, then the last one again and again. */
const RETRY_MS = [10_000, 60_000, 300_000];
/** A pause after each request, at Live Coin Watch's pace (as the older market caps' download). */
const GAP_MS = 2_500;
/** The wait after Live Coin Watch asks to slow down, while the day's requests aren't used up. */
const SLOW_DOWN_MS = 30_000;
/** What's said once Live Coin Watch's part is in while ETH Zurich's dataset isn't in place. */
const DATASET_MISSING = `ETH Zurich's dataset is missing: download its two files from ${ETH_ZURICH_URL.replace('/files', '')} into data/cryptocap/older-coins/`;
/** Guesses for the progress bar, until each step knows its own size. */
const GUESS = { pages: 650, coarse: 3_000, daily: 16_000 };

/** A listed coin as kept: [code, name, peak worth (US$), price, categories, markets now]. */
export type StoredListed = [string, string, number, number, string[], number];

interface Index {
  version: 1;
  /** What Live Coin Watch is asked for, [from, to) epoch ms; fixed once set. */
  span: [number, number] | null;
  /** The next list page's offset; null once the whole list is read. */
  scan: number | null;
  /** The listed coins that may have counted, or that are CoinGecko's coins today. */
  listed: StoredListed[];
  /** Codes found to be CoinGecko's coins: code → CoinGecko id. */
  matched: Record<string, string>;
  /** The coins whose every day is downloaded, most important first; null until chosen. */
  chosen: string[] | null;
  /** Of those, the ones whose days are all in. */
  done: string[];
}

/** Each looked-at coin's market cap by month: code → [month (since January 2018), highest]. */
interface Coarse {
  version: 1;
  months: Record<string, [number, number][]>;
}

/** One chosen coin's days. */
export interface CoinDays {
  version: 1;
  code: string;
  /** Its first day (UTC s); the lists hold a value a day from it, null where none came. */
  start: number;
  caps: (number | null)[];
  prices: (number | null)[];
  /** How far its download has come (epoch ms): days before this are in. */
  fetched: number;
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function parseIndex(value: unknown): Index | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, span, scan, listed, matched, chosen, done } = value as Record<string, unknown>;
  if (version !== 1) return null;
  if (span !== null && !(Array.isArray(span) && span.length === 2 && span.every(isFiniteNumber)))
    return null;
  if (scan !== null && !isFiniteNumber(scan)) return null;
  if (!Array.isArray(listed)) return null;
  for (const item of listed) {
    if (!Array.isArray(item) || item.length !== 6) return null;
    const [code, name, peak, price, categories, markets] = item as unknown[];
    if (typeof code !== 'string' || typeof name !== 'string') return null;
    if (!isFiniteNumber(peak) || !isFiniteNumber(price) || !isStringList(categories)) return null;
    if (!isFiniteNumber(markets)) return null;
  }
  if (typeof matched !== 'object' || matched === null) return null;
  if (!Object.values(matched).every((id) => typeof id === 'string')) return null;
  if (chosen !== null && !isStringList(chosen)) return null;
  if (!isStringList(done)) return null;
  return {
    version: 1,
    span: span as [number, number] | null,
    scan: scan as number | null,
    listed: listed as StoredListed[],
    matched: matched as Record<string, string>,
    chosen: chosen as string[] | null,
    done: done as string[],
  };
}

function parseCoarse(value: unknown): Coarse | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, months } = value as Record<string, unknown>;
  if (version !== 1 || typeof months !== 'object' || months === null) return null;
  for (const list of Object.values(months)) {
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      if (!Array.isArray(entry) || entry.length !== 2 || !entry.every(isFiniteNumber)) return null;
    }
  }
  return { version: 1, months: months as Coarse['months'] };
}

const isDayList = (value: unknown): value is (number | null)[] =>
  Array.isArray(value) && value.every((item) => item === null || isFiniteNumber(item));

export function parseCoinDays(value: unknown): CoinDays | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, code, start, caps, prices, fetched } = value as Record<string, unknown>;
  if (version !== 1 || typeof code !== 'string') return null;
  if (!isFiniteNumber(start) || !isFiniteNumber(fetched)) return null;
  if (!isDayList(caps) || !isDayList(prices) || caps.length !== prices.length) return null;
  return { version: 1, code, start, caps, prices, fetched };
}

const emptyIndex = (): Index => ({
  version: 1,
  span: null,
  scan: 0,
  listed: [],
  matched: {},
  chosen: null,
  done: [],
});

/** Eight significant digits: plenty for market caps and prices. */
const compact = (value: number) => Number(value.toPrecision(8));
/** The day (epoch ms) holding `ms`, UTC. */
const dayOf = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
/** Months since January 2018, UTC, of a moment. */
export function monthOf(ms: number): number {
  const date = new Date(ms);
  return (date.getUTCFullYear() - 2018) * 12 + date.getUTCMonth();
}
const monthStartMs = (month: number) => Date.UTC(2018 + Math.floor(month / 12), month % 12, 1);

/** A coin's points as its highest market cap of each month, to three digits. */
export function monthCaps(points: readonly PricedPoint[]): [number, number][] {
  const byMonth = new Map<number, number>();
  for (const point of points) {
    const month = monthOf(point.date);
    byMonth.set(month, Math.max(byMonth.get(month) ?? 0, point.cap));
  }
  return [...byMonth].map(([month, cap]) => [month, Number(cap.toPrecision(3))]);
}

/** A code without the underscores Live Coin Watch puts before a symbol that's taken. */
const bareCode = (code: string) => code.replace(/^_+/, '').toUpperCase();
const normalName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What a listed coin may have been worth at most: its highest price ever times its circulating
 * or total supply now, or 0 when it has neither. Mostly more than it was ever worth, but not
 * always: Luna Classic's supply grew a thousandfold after its fall (8×10^14), and some coins have
 * no supply figure left (Fantom), so coins still traded are looked at whatever this says.
 */
export function peakOf(coin: ListedCoin): number {
  return coin.allTimeHighUSD * Math.max(coin.circulatingSupply, coin.totalSupply);
}

/**
 * The listed coins to look at month by month, in groups, each most likely first: CoinGecko's
 * coins of today; coins still traded, by their peak worth; those whose peak is no guide (none,
 * or past any coin's); and coins no longer traded with a peak worth a look, by peak. Coins no
 * longer traded without a believable peak are left out (dead coins of their kind: Waltonchain,
 * Pundi X, MaidSafeCoin all have one).
 */
export function lookAtGroups(
  listed: readonly StoredListed[],
  matched: Readonly<Record<string, string>>,
): string[][] {
  const plausible = (peak: number) => peak >= PEAK_MIN && peak <= PEAK_MAX;
  const byPeak = (a: StoredListed, b: StoredListed) => b[2] - a[2] || a[0].localeCompare(b[0]);
  const rest = listed.filter(([code]) => !(code in matched));
  const codes = (group: readonly StoredListed[]) => group.map(([code]) => code);
  return [
    Object.keys(matched).sort(),
    codes(rest.filter(([, , peak, , , markets]) => markets > 0 && plausible(peak)).sort(byPeak)),
    codes(
      rest
        .filter(([, , peak, , , markets]) => markets > 0 && !plausible(peak))
        .sort((a, b) => b[5] - a[5] || a[0].localeCompare(b[0])),
    ),
    codes(rest.filter(([, , peak, , , markets]) => markets === 0 && plausible(peak)).sort(byPeak)),
  ];
}

/**
 * The 250 largest market caps of each month among the coins looked at so far, to tell whether
 * the next one comes near them.
 */
export class MonthRanks {
  private readonly top = new Map<number, number[]>();

  /** Adds a coin's months; true when it's among the 250 largest of some month. */
  add(months: readonly (readonly [number, number])[]): boolean {
    let near = false;
    for (const [month, cap] of months) {
      const caps = this.top.get(month) ?? [];
      if (caps.length >= NEAR_RANK && cap <= (caps.at(-1) as number)) continue;
      near = true;
      let at = caps.findIndex((other) => other < cap);
      if (at < 0) at = caps.length;
      caps.splice(at, 0, cap);
      if (caps.length > NEAR_RANK) caps.pop();
      this.top.set(month, caps);
    }
    return near;
  }
}

/** A token standing for another coin (Wrapped Bitcoin, Lido Staked ETH): TradingView counts neither. */
export function isDerivative(name: string, categories: readonly string[]): boolean {
  if (/\b(wrapped|bridged|staked|restaked|binance-peg)\b/i.test(name)) return true;
  return categories.some((category) => /wrapped|bridged|liquid[-_ ]?staking/i.test(category));
}

export const isStablecoin = (categories: readonly string[]) =>
  categories.some((category) => /stablecoin/i.test(category));

/** A coin CoinGecko ranks today, to find on Live Coin Watch. */
export interface UniverseCoin {
  id: string;
  symbol: string;
  name: string;
  price: number;
}

/**
 * CoinGecko's coins found among the listed ones: the same symbol, at a price within 15% of
 * CoinGecko's (the nearest, when several share it), or else the same name. Live Coin Watch's
 * codes collide (its BTM is Bitmark, not Bytom), so a symbol alone isn't enough.
 */
export function matchCoins(
  listed: readonly StoredListed[],
  universe: readonly UniverseCoin[],
): Record<string, string> {
  const bySymbol = new Map<string, StoredListed[]>();
  for (const coin of listed) {
    const symbol = bareCode(coin[0]);
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), coin]);
  }
  const matched: Record<string, string> = {};
  const taken = new Set<string>();
  for (const coin of universe) {
    const candidates = (bySymbol.get(coin.symbol.toUpperCase()) ?? []).filter(
      ([code]) => !taken.has(code),
    );
    const priced = candidates
      .filter(([, , , price]) => price > 0 && coin.price > 0)
      .map((listed) => ({ listed, off: Math.abs(Math.log(listed[3] / coin.price)) }))
      .filter(({ off }) => off <= Math.log(1.15))
      .sort((a, b) => a.off - b.off);
    const found =
      priced[0]?.listed ??
      candidates.find(([, name]) => normalName(name) === normalName(coin.name));
    if (!found) continue;
    matched[found[0]] = coin.id;
    taken.add(found[0]);
  }
  return matched;
}

/**
 * The coins whose every day is wanted, most important first: those among the 200 largest
 * (tokens standing for other coins left out) in some month, stablecoins among the 60 largest
 * stablecoins, and CoinGecko's coins of today.
 */
export function chooseCoins(
  listed: readonly StoredListed[],
  months: Readonly<Record<string, readonly (readonly [number, number])[]>>,
  matched: Readonly<Record<string, string>>,
): string[] {
  const info = new Map(listed.map((coin) => [coin[0], coin]));
  const byMonth = new Map<number, { code: string; cap: number }[]>();
  for (const [code, list] of Object.entries(months)) {
    const coin = info.get(code);
    if (!coin || isDerivative(coin[1], coin[4])) continue;
    for (const [month, cap] of list) {
      byMonth.set(month, [...(byMonth.get(month) ?? []), { code, cap }]);
    }
  }
  const best = new Map<string, number>();
  const better = (code: string, rank: number) =>
    best.set(code, Math.min(best.get(code) ?? Number.POSITIVE_INFINITY, rank));
  for (const coins of byMonth.values()) {
    coins.sort((a, b) => b.cap - a.cap || a.code.localeCompare(b.code));
    for (const [i, { code }] of coins.slice(0, CHOSEN_RANK).entries()) better(code, i + 1);
    const stables = coins.filter(({ code }) => isStablecoin(info.get(code)?.[4] ?? []));
    for (const [i, { code }] of stables.slice(0, CHOSEN_STABLE_RANK).entries()) {
      better(code, CHOSEN_RANK + i + 1);
    }
  }
  const chosen = [...best].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  const rest = Object.keys(matched)
    .filter((code) => !best.has(code))
    .sort();
  return [...chosen, ...rest];
}

/** The windows of a coin's download: from its first month with a market cap, or the span's start. */
export function coinWindows(
  span: readonly [number, number],
  months: readonly (readonly [number, number])[] | undefined,
  fetched: number,
): [number, number][] {
  const firstMonth = months?.length ? Math.min(...months.map(([month]) => month)) : null;
  const from = Math.max(
    span[0],
    fetched,
    firstMonth === null ? span[0] : monthStartMs(firstMonth) - 31 * DAY_MS,
  );
  const windows: [number, number][] = [];
  for (let start = from; start < span[1]; start += WINDOW_DAYS * DAY_MS) {
    windows.push([start, Math.min(start + WINDOW_DAYS * DAY_MS, span[1])]);
  }
  return windows;
}

/** A coin's points into its days: the last point of each UTC day is that day's. */
export function addPoints(days: CoinDays, points: readonly PricedPoint[]): CoinDays {
  const out = { ...days, caps: [...days.caps], prices: [...days.prices] };
  for (const point of points) {
    const day = dayOf(point.date) / 1000;
    if (out.caps.length === 0) out.start = day;
    if (day < out.start) {
      const pad = (day - out.start) / 86_400;
      out.caps.unshift(...new Array(-pad).fill(null));
      out.prices.unshift(...new Array(-pad).fill(null));
      out.start = day;
    }
    const i = (day - out.start) / 86_400;
    while (out.caps.length <= i) {
      out.caps.push(null);
      out.prices.push(null);
    }
    out.caps[i] = compact(point.cap);
    out.prices[i] = compact(point.rate);
  }
  return out;
}

export interface OlderCoinsOptions {
  secrets: SecretStore;
  dataDir: string;
  /** Our own first day (epoch ms): the download reaches a week past it. */
  joinMs: () => number;
  /** CoinGecko's coins today, to find on Live Coin Watch. */
  universe: () => readonly UniverseCoin[];
  client?: LiveCoinWatchClient;
  /** The pause after each request, ms (GAP_MS). */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/** Thrown to end a download that was stopped. */
class Stopped extends Error {}

/**
 * Each coin's older days, for every CRYPTOCAP symbol before our own history (M9f, docs/SPEC.md
 * §5.14): ETH Zurich's copy of CoinMarketCap's figures to 7 February 2018 (two files, once), then
 * Live Coin Watch's with the user's free key, in four steps that carry on after a restart: its
 * whole list read for coins that may have counted; each such coin's market cap by month, a
 * request each, to find those among the 200 largest in some month; then each of those, and each
 * of CoinGecko's coins of today, a day at a time, 100 days a request. A few days of the key's
 * 10,000 daily requests in all, at Live Coin Watch's pace. Kept in data/cryptocap/older-coins/.
 */
export class OlderCoins {
  private readonly secrets: SecretStore;
  private readonly dir: string;
  private readonly joinMs: () => number;
  private readonly universe: () => readonly UniverseCoin[];
  private readonly client: LiveCoinWatchClient;
  private readonly gapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly indexFile: JsonFile<Index>;
  private readonly coarseFile: JsonFile<Coarse>;
  private index: Index = emptyIndex();
  private coarse: Coarse = { version: 1, months: {} };
  private loaded: Promise<void> | null = null;
  private starting: Promise<void> = Promise.resolve();
  private job: { done: Promise<void>; stop: () => void } | null = null;
  private downloads: Promise<void> = Promise.resolve();
  private state: OlderCoinsStatus['state'] = 'none';
  /** The step under way, and what the download waits for, if anything. */
  private step: string | null = null;
  private waiting: string | null = null;
  private hasDataset = false;
  /** Requests made toward the chosen coins' days, for the progress bar. */
  private dailyFetched = 0;
  private unsaved = 0;

  constructor(options: OlderCoinsOptions) {
    this.secrets = options.secrets;
    this.dir = join(options.dataDir, 'cryptocap', 'older-coins');
    this.joinMs = options.joinMs;
    this.universe = options.universe;
    this.client = options.client ?? new LiveCoinWatchClient();
    this.gapMs = options.gapMs ?? GAP_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? (() => {});
    const onInvalid = (to: string) =>
      this.warn(`The older coins' download record was unreadable; moved to ${to}`);
    this.indexFile = new JsonFile(join(this.dir, 'index.json'), parseIndex, {
      indent: 0,
      onInvalid,
    });
    this.coarseFile = new JsonFile(join(this.dir, 'coarse.json'), parseCoarse, {
      indent: 0,
      onInvalid,
    });
  }

  /** Where ETH Zurich's files and the coins' days are kept. */
  get directory(): string {
    return this.dir;
  }

  load(): Promise<void> {
    this.loaded ??= Promise.all([
      this.indexFile.read().then((index) => {
        if (index) this.index = index;
      }),
      this.coarseFile.read().then((coarse) => {
        if (coarse) this.coarse = coarse;
      }),
      this.checkDataset(),
    ]).then(
      () => {
        if (this.complete()) this.state = 'done';
      },
      (error: unknown) => this.warn(`Couldn't read the older coins' download (${error})`),
    );
    return this.loaded;
  }

  /** Starts the download, or carries it on, when there's a Live Coin Watch key. */
  start(): Promise<void> {
    const run = this.starting.then(() => this.begin());
    this.starting = run.catch(() => {});
    return run;
  }

  /** Stops the download and starts it again: after the key changed. */
  async restart(): Promise<void> {
    await this.starting;
    this.stopJob();
    if (this.state === 'error') this.setState('none');
    await this.start();
  }

  async status(): Promise<OlderCoinsStatus> {
    await this.load();
    return {
      state: this.state,
      progress: this.progress(),
      message:
        this.state === 'done'
          ? this.hasDataset
            ? null
            : DATASET_MISSING
          : (this.waiting ?? this.step),
    };
  }

  /** The chosen coins, their CoinGecko ids where they're CoinGecko's, and what's in. */
  async contents(): Promise<{
    chosen: readonly string[];
    matched: Readonly<Record<string, string>>;
    listed: readonly StoredListed[];
    done: readonly string[];
  }> {
    await this.load();
    return {
      chosen: this.index.chosen ?? [],
      matched: this.index.matched,
      listed: this.index.listed,
      done: this.index.done,
    };
  }

  /** The file a chosen coin's days are kept in. */
  coinPath(code: string): string | null {
    const i = this.index.chosen?.indexOf(code) ?? -1;
    return i < 0 ? null : join(this.dir, 'coins', `${String(i).padStart(4, '0')}.json`);
  }

  async idle(): Promise<void> {
    await this.starting;
    await this.downloads;
  }

  async close(): Promise<void> {
    this.stopJob();
    await this.save();
  }

  // ----

  /** Whether Live Coin Watch's part is all in (ETH Zurich's dataset is put in place by hand). */
  private complete(): boolean {
    return this.index.chosen?.every((code) => this.index.done.includes(code)) ?? false;
  }

  private async begin(): Promise<void> {
    await this.load();
    if (this.job || this.complete()) return;
    const key = (await this.secrets.livecoinwatch())?.key;
    if (!key) return;
    let stopped = false;
    const done = this.download(key, () => stopped)
      .catch((error: unknown) => {
        if (error instanceof Stopped) return;
        this.warn(`The older coins' download stopped (${error})`);
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

  private setState(state: OlderCoinsStatus['state'], step: string | null = null): void {
    this.state = state;
    this.step = step;
    this.waiting = null;
  }

  private progress(): number {
    if (this.complete()) return 1;
    const scanDone = this.index.scan === null;
    const pages = scanDone
      ? Math.ceil(this.index.listed.length / LIST_PAGE)
      : (this.index.scan ?? 0) / LIST_PAGE;
    const pageTotal = scanDone ? pages : Math.max(GUESS.pages, pages + 1);
    const coarseDone = Object.keys(this.coarse.months).length;
    const coarseTotal = scanDone ? this.toLookAt().length : GUESS.coarse;
    let daily = this.dailyFetched;
    let dailyTotal = GUESS.daily;
    const { chosen, span } = this.index;
    if (chosen && span) {
      dailyTotal = 0;
      daily = 0;
      for (const code of chosen) {
        const all = coinWindows(span, this.coarse.months[code], span[0]).length;
        dailyTotal += all;
        if (this.index.done.includes(code)) daily += all;
      }
      daily = Math.min(dailyTotal, daily + this.dailyFetched);
    }
    const done = pages + coarseDone + daily;
    const total = pageTotal + Math.max(coarseTotal, coarseDone) + dailyTotal;
    return Math.max(0, Math.min(1, done / total));
  }

  /** The listed coins to look at month by month, at most (lookAtGroups). */
  private toLookAt(): string[] {
    return lookAtGroups(this.index.listed, this.index.matched).flat();
  }

  private async download(key: string, stopped: () => boolean): Promise<void> {
    this.setState('loading', null);
    this.index.span ??= [COINS_FROM_MS, dayOf(this.joinMs()) + PAST_JOIN_DAYS * DAY_MS];
    const span = this.index.span;
    await this.scan(key, stopped);
    await this.lookAtMonths(key, span, stopped);
    if (!this.index.chosen) {
      this.index.chosen = chooseCoins(this.index.listed, this.coarse.months, this.index.matched);
      this.unsaved++;
      await this.save();
    }
    await this.fetchDays(key, span, this.index.chosen, stopped);
    await this.save();
    await this.checkDataset();
    if (this.complete()) this.setState('done');
  }

  /** Whether ETH Zurich's two files are in place (put there by hand: Zenodo turns programs away). */
  private async checkDataset(): Promise<void> {
    this.hasDataset = await Promise.all(
      [ETH_ZURICH_CAPS, ETH_ZURICH_CLOSES].map((name) => stat(join(this.dir, name))),
    ).then(
      () => true,
      () => false,
    );
  }

  /** Reads Live Coin Watch's whole list, keeping the coins that may have counted. */
  private async scan(key: string, stopped: () => boolean): Promise<void> {
    const symbols = new Set(this.universe().map((coin) => coin.symbol.toUpperCase()));
    while (this.index.scan !== null) {
      const offset = this.index.scan;
      this.step = `Finding coins on Live Coin Watch: ${offset.toLocaleString('en-US')} of its list read`;
      const page = await this.call(key, stopped, () => this.client.list(key, offset, LIST_PAGE));
      // A page it can't give isn't the list's end: the scan stops here, to carry on next time.
      if (page === null) throw new Error("Live Coin Watch's list couldn't be read");
      for (const coin of page) {
        const peak = peakOf(coin);
        const kept = peak >= PEAK_MIN || coin.markets > 0 || symbols.has(bareCode(coin.code));
        if (!kept || this.index.listed.some(([code]) => code === coin.code)) continue;
        this.index.listed.push([
          coin.code,
          coin.name,
          compact(peak),
          compact(coin.rate),
          coin.categories,
          coin.markets,
        ]);
      }
      this.index.scan = page.length < LIST_PAGE ? null : offset + LIST_PAGE;
      if (this.index.scan === null) {
        this.index.matched = matchCoins(this.index.listed, this.universe());
      }
      await this.counted();
    }
  }

  /** Each coin that may have counted: its market cap by month, one request each. */
  private async lookAtMonths(
    key: string,
    span: [number, number],
    stopped: () => boolean,
  ): Promise<void> {
    const info = new Map(this.index.listed.map((coin) => [coin[0], coin]));
    const ranks = new MonthRanks();
    const groups = lookAtGroups(this.index.listed, this.index.matched);
    const total = groups.reduce((sum, group) => sum + group.length, 0);
    let looked = 0;
    for (const group of groups) {
      let streak = 0;
      for (const code of group) {
        looked++;
        let months = this.coarse.months[code];
        if (!months) {
          this.step = `Finding which coins counted, month by month: ${looked.toLocaleString('en-US')} of at most ${total.toLocaleString('en-US')} coins`;
          const points =
            (await this.call(key, stopped, () =>
              this.client.priced(key, code, span[0], span[1] - 1),
            )) ?? [];
          months = monthCaps(points);
          this.coarse.months[code] = months;
          await this.counted();
        }
        const coin = info.get(code);
        const counts = !coin || !isDerivative(coin[1], coin[4]);
        if (counts && ranks.add(months)) streak = 0;
        else if (++streak >= GIVE_UP_AFTER) break;
      }
    }
  }

  /** Every day of each chosen coin, 100 days a request, saved as it comes. */
  private async fetchDays(
    key: string,
    span: [number, number],
    chosen: readonly string[],
    stopped: () => boolean,
  ): Promise<void> {
    const left = chosen.filter((code) => !this.index.done.includes(code));
    for (const [i, code] of left.entries()) {
      this.step = `Downloading each coin's days: ${(chosen.length - left.length + i).toLocaleString('en-US')} of ${chosen.length.toLocaleString('en-US')} coins`;
      const path = this.coinPath(code) as string;
      const file = new JsonFile(path, parseCoinDays, { indent: 0 });
      let days: CoinDays = (await file.read().catch(() => null)) ?? {
        version: 1,
        code,
        start: span[0] / 1000,
        caps: [],
        prices: [],
        fetched: 0,
      };
      if (days.code !== code) days = { ...days, code, caps: [], prices: [], fetched: 0 };
      for (const [from, to] of coinWindows(span, this.coarse.months[code], days.fetched)) {
        const points =
          (await this.call(key, stopped, () => this.client.priced(key, code, from, to - 1))) ?? [];
        days = { ...addPoints(days, points), fetched: to };
        this.dailyFetched++;
        await file.write(days);
      }
      this.index.done.push(code);
      this.dailyFetched = 0;
      await this.counted();
    }
  }

  /** One more request done: saved every so often. */
  private async counted(): Promise<void> {
    if (++this.unsaved >= SAVE_EVERY) await this.save();
  }

  /**
   * A request at Live Coin Watch's pace: null for a coin it doesn't have; waits when asked to
   * slow down or out of requests for the day, and tries again after other failures.
   */
  private async call<T>(
    key: string,
    stopped: () => boolean,
    request: () => Promise<T>,
  ): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      if (stopped()) throw new Stopped();
      try {
        const result = await request();
        this.waiting = null;
        await this.sleep(this.gapMs);
        return result;
      } catch (error) {
        if (stopped()) throw new Stopped();
        if (error instanceof LiveCoinWatchError && error.kind === 'missing') {
          await this.sleep(this.gapMs);
          return null;
        }
        if (error instanceof LiveCoinWatchError && error.kind === 'rejected') {
          await this.save();
          throw new Error('Live Coin Watch rejected the key');
        }
        if (error instanceof LiveCoinWatchError && error.kind === 'limited') {
          await this.save();
          const left = await this.client.credits(key).catch(() => null);
          if (left !== null && left <= 0) {
            this.waiting = "Waiting for Live Coin Watch's requests to renew at 00:00 UTC";
            await this.sleep(dayOf(this.now()) + DAY_MS + 5 * 60_000 - this.now());
          } else {
            this.waiting = 'Live Coin Watch asked to slow down; going on in 30 s';
            await this.sleep(SLOW_DOWN_MS);
          }
          continue;
        }
        this.waiting = `${(error as Error).message}; trying again`;
        await this.sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] as number);
      }
    }
  }

  private async save(): Promise<void> {
    if (this.unsaved === 0) return;
    this.unsaved = 0;
    await Promise.all([this.indexFile.write(this.index), this.coarseFile.write(this.coarse)]).catch(
      (error: unknown) => {
        this.unsaved = 1;
        this.warn(`Couldn't save the older coins' download (${error})`);
      },
    );
  }
}

/** Reads one of ETH Zurich's files kept by the download. */
export function readDatasetFile(dir: string, name: string): Promise<string> {
  return readFile(join(dir, name), 'utf8');
}
