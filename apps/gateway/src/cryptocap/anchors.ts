import { join } from 'node:path';
import type { MarketChart, MarketCoin } from '../logos/coingecko.ts';
import { JsonFile } from '../storage/jsonFile.ts';

const DAY_SEC = 86_400;
/** Changes wait this long before they're written, so a round of updates is one write. */
const SAVE_DELAY_MS = 10_000;

/** One coin at one moment: [time (UTC s), market cap, price], both in US dollars. */
export type Anchor = [number, number, number];

interface Stored {
  version: 1;
  /** Coin id → its points, ascending by time. */
  coins: Record<string, Anchor[]>;
  /** Coin id → when its year of history last came from CoinGecko (epoch ms). */
  history: Record<string, number>;
}

const isAnchor = (value: unknown): value is Anchor =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((part) => typeof part === 'number' && Number.isFinite(part)) &&
  (value[1] as number) > 0 &&
  (value[2] as number) > 0;

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, coins, history } = value as Record<string, unknown>;
  if (version !== 1 || typeof coins !== 'object' || coins === null) return null;
  if (typeof history !== 'object' || history === null) return null;
  const parsed: Stored = { version: 1, coins: {}, history: {} };
  for (const [id, points] of Object.entries(coins)) {
    if (!Array.isArray(points) || !points.every(isAnchor)) return null;
    parsed.coins[id] = points;
  }
  for (const [id, at] of Object.entries(history)) {
    if (typeof at === 'number' && Number.isFinite(at)) parsed.history[id] = at;
  }
  return parsed;
}

/** Eight significant digits: plenty for market caps, and a third of the file. */
const compact = (value: number) => Number(value.toPrecision(8));

/** Index of the last point at or before `sec`, or -1. */
function lastAtOrBefore(points: readonly Anchor[], sec: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid] as Anchor)[0] <= sec) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** `pick(point)` at `sec`, straight-line between the points either side. */
function interpolate(
  points: readonly Anchor[],
  sec: number,
  pick: (point: Anchor) => number,
): number | null {
  const at = lastAtOrBefore(points, sec);
  const before = points[at];
  const after = points[at + 1];
  if (!before) return null;
  if (!after || before[0] === sec) return pick(before);
  const share = (sec - before[0]) / (after[0] - before[0]);
  return pick(before) + (pick(after) - pick(before)) * share;
}

const supplyOf = (point: Anchor) => point[1] / point[2];

/**
 * Each coin's market cap and price, a point a day: CoinGecko's history, fetched once per coin
 * (a year on its free plan), then each day's latest snapshot, every one kept, so the history
 * grows a day each day (about 6 MB a year). Market caps are built from exchange prices times the
 * circulating supply these points give for that moment (market cap ÷ price), and coins no
 * exchange of ours trades are taken from the points themselves. Kept in
 * data/cryptocap/anchors.json.
 */
export class AnchorBook {
  private readonly file: JsonFile<Stored>;
  private readonly warn: (message: string) => void;
  private points = new Map<string, Anchor[]>();
  private history = new Map<string, number>();
  private loaded: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dataDir: string, onWarning: (message: string) => void = () => {}) {
    this.file = new JsonFile(join(dataDir, 'cryptocap', 'anchors.json'), parseStored, {
      indent: 0,
      onInvalid: (to) => onWarning(`The saved market cap history was unreadable; moved to ${to}`),
    });
    this.warn = onWarning;
  }

  load(): Promise<void> {
    this.loaded ??= this.file.read().then(
      (stored) => {
        if (!stored) return;
        for (const [id, points] of Object.entries(stored.coins)) {
          if (!this.points.has(id)) this.points.set(id, points);
        }
        for (const [id, at] of Object.entries(stored.history)) {
          if (!this.history.has(id)) this.history.set(id, at);
        }
      },
      (error: unknown) => this.warn(`Couldn't read the saved market cap history (${error})`),
    );
    return this.loaded;
  }

  /** Whether a coin's year of history has come from CoinGecko. */
  hasHistory(id: string): boolean {
    return this.history.has(id);
  }

  /**
   * CoinGecko's history (`chart`) for a coin, in place of its points over the same span; the
   * days kept from before it and the snapshots since stay, so fetching again never shortens it.
   */
  setHistory(id: string, chart: MarketChart, fetchedAt: number): void {
    const prices = new Map(chart.prices.map(([ms, price]) => [Math.floor(ms / 1000), price]));
    const fetched: Anchor[] = [];
    for (const [ms, cap] of chart.caps) {
      const sec = Math.floor(ms / 1000);
      const price = prices.get(sec);
      if (price !== undefined) fetched.push([sec, compact(cap), compact(price)]);
    }
    const first = fetched[0]?.[0] ?? Number.POSITIVE_INFINITY;
    const last = fetched.at(-1)?.[0] ?? Number.NEGATIVE_INFINITY;
    const kept = this.points.get(id) ?? [];
    const older = kept.filter(([sec]) => sec < first);
    const newer = kept.filter(([sec]) => sec > last);
    this.points.set(id, [...older, ...fetched, ...newer]);
    this.history.set(id, fetchedAt);
    this.scheduleSave();
  }

  /**
   * A snapshot's values as each coin's point for the day: the day's last snapshot replaces
   * an earlier one of the same UTC day, so there's one point a day.
   */
  record(coins: readonly MarketCoin[], atMs: number): void {
    const sec = Math.floor(atMs / 1000);
    const day = Math.floor(sec / DAY_SEC);
    for (const coin of coins) {
      const points = this.points.get(coin.id) ?? [];
      const last = points.at(-1);
      if (last && last[0] > sec) continue;
      const point: Anchor = [sec, compact(coin.cap), compact(coin.price)];
      if (last && Math.floor(last[0] / DAY_SEC) === day && !(last[0] % DAY_SEC === 0)) {
        points[points.length - 1] = point;
      } else {
        points.push(point);
      }
      this.points.set(coin.id, points);
    }
    this.scheduleSave();
  }

  /**
   * A coin's circulating supply at `sec`, straight-line between its points; before its first
   * point, the first one's (the best guess while its history is still loading). Null for a
   * coin without points.
   */
  supplyAt(id: string, sec: number): number | null {
    const points = this.points.get(id);
    if (!points?.length) return null;
    return interpolate(points, sec, supplyOf) ?? supplyOf(points[0] as Anchor);
  }

  /** When a coin's first kept point is (UTC s): how far back its supply is known. */
  firstSec(id: string): number | null {
    return this.points.get(id)?.[0]?.[0] ?? null;
  }

  /** A coin's market cap at `sec`, straight-line between its points; null before the first. */
  capAt(id: string, sec: number): number | null {
    const points = this.points.get(id);
    return points ? interpolate(points, sec, (point) => point[1]) : null;
  }

  /**
   * A coin's market cap at `sec` as best known: between its points as `capAt`, and before its
   * first one, while its history hasn't been fetched yet, that first point's (an estimate for
   * the minutes it takes to load). Once its history is in, a time before it means the coin
   * didn't exist yet: null.
   */
  estimatedCapAt(id: string, sec: number): number | null {
    const cap = this.capAt(id, sec);
    if (cap !== null || this.history.has(id)) return cap;
    return this.points.get(id)?.[0]?.[1] ?? null;
  }

  /** A coin's price at `sec`, straight-line between its points; null before the first. */
  priceAt(id: string, sec: number): number | null {
    const points = this.points.get(id);
    return points ? interpolate(points, sec, (point) => point[2]) : null;
  }

  /** Writes pending changes now (on shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    await this.load();
    const stored: Stored = {
      version: 1,
      coins: Object.fromEntries(this.points),
      history: Object.fromEntries(this.history),
    };
    await this.file.write(stored).catch((error: unknown) => {
      this.warn(`Couldn't save the market cap history (${error})`);
    });
  }
}
