import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnchorBook } from './anchors.ts';
import {
  type DatasetCoin,
  ETH_ZURICH_CAPS,
  ETH_ZURICH_CLOSES,
  parseEthZurich,
} from './ethzurich.ts';
import {
  type CoinDays,
  isDerivative,
  isStablecoin,
  type OlderCoins,
  parseCoinDays,
} from './olderCoins.ts';

const DAY_SEC = 86_400;
/** The dataset's last day: Live Coin Watch's days are used from the day after. */
export const DATASET_END_SEC = Date.UTC(2018, 1, 7) / 1000;
/** The week both have, to match coins and their supplies across the change. */
const OVERLAP_FROM_SEC = Date.UTC(2018, 1, 1) / 1000;
/** Days a supply's median is taken over: one day's odd figure doesn't move it. */
const SMOOTH_DAYS = 7;
/** A dataset coin and a Live Coin Watch coin are one when their prices agree this closely. */
const SAME_PRICE = 0.03;
/** …and their market caps within this factor (stablecoins all cost a dollar). */
const SAME_CAP = 2;
/**
 * The dataset's stablecoins of 2013–2018 that Live Coin Watch doesn't carry on: STABLE.C and
 * the ES symbols leave them out.
 */
const DATASET_STABLES = new Set(['tether', 'nubits', 'bitusd', 'bitcny', 'dai', 'true-usd']);

/** One coin's older days, a value a day from `start`: NaN where there's none. */
export interface OlderEntity {
  /** CoinGecko's id when it's one of its coins today; else lcw:<code> or cmc:<slug>. */
  id: string;
  stable: boolean;
  /** Whether it counts in TradingView's market caps (tokens standing for others don't). */
  eligible: boolean;
  /** Its first day (UTC s). */
  start: number;
  caps: Float64Array;
  prices: Float64Array;
  /** Its supply, a week's median: for a price of an exchange's to be multiplied by. */
  supplies: Float64Array;
  /** Its older days end before this (UTC s): its own history's first day, or ours. */
  until: number;
}

/** A coin's days as one series: [day (UTC s), cap, price] where both are known. */
type Day = [number, number, number];
/** A served day: [day (UTC s), market cap, price, supply]. */
export type ServedDay = [number, number, number, number];

/** The median of the values around each one, `days` wide, the gaps left as they are. */
export function rollingMedian(values: readonly number[], days = SMOOTH_DAYS): number[] {
  const half = Math.floor(days / 2);
  return values.map((value, i) => {
    if (!Number.isFinite(value)) return value;
    const around = values
      .slice(Math.max(0, i - half), i + half + 1)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    return around[around.length >> 1] as number;
  });
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[sorted.length >> 1] as number) : Number.NaN;
};

/**
 * Each dataset coin's Live Coin Watch coin, by price over the week both have (1–7 February
 * 2018): within 3% on the median day, market caps within a factor of 2; one each, the closest
 * first. Names change (Binance Coin is BNB, RaiBlocks is Nano), prices don't.
 */
export function matchDataset(
  dataset: readonly DatasetCoin[],
  lcw: ReadonlyMap<string, readonly Day[]>,
): Map<string, string> {
  const overlap = (days: readonly Day[]) =>
    new Map(
      days
        .filter(([day]) => day >= OVERLAP_FROM_SEC && day <= DATASET_END_SEC)
        .map((d) => [d[0], d]),
    );
  const lcwOverlap = [...lcw].map(([code, days]) => [code, overlap(days)] as const);
  const pairs: { slug: string; code: string; score: number }[] = [];
  for (const coin of dataset) {
    const ours = overlap(coin.points);
    if (ours.size < 3) continue;
    for (const [code, theirs] of lcwOverlap) {
      const price: number[] = [];
      const cap: number[] = [];
      for (const [day, [, c, p]] of ours) {
        const other = theirs.get(day);
        if (!other) continue;
        price.push(Math.abs(Math.log(other[2] / p)));
        cap.push(Math.abs(Math.log(other[1] / c)));
      }
      if (price.length < 3) continue;
      const priceOff = median(price);
      const capOff = median(cap);
      if (priceOff > Math.log(1 + SAME_PRICE) || capOff > Math.log(SAME_CAP)) continue;
      pairs.push({ slug: coin.slug, code, score: priceOff + capOff / 10 });
    }
  }
  const matched = new Map<string, string>();
  const taken = new Set<string>();
  for (const { slug, code } of pairs.sort((a, b) => a.score - b.score)) {
    if (matched.has(slug) || taken.has(code)) continue;
    matched.set(slug, code);
    taken.add(code);
  }
  return matched;
}

/** A Live Coin Watch coin's file as days with both figures. */
function lcwDays(file: CoinDays): Day[] {
  const days: Day[] = [];
  for (const [i, cap] of file.caps.entries()) {
    const price = file.prices[i];
    if (cap && price) days.push([file.start + i * DAY_SEC, cap, price]);
  }
  return days;
}

/** Supplies smoothed: market cap ÷ price, the median over a week. */
function supplies(days: readonly Day[]): number[] {
  return rollingMedian(days.map(([, cap, price]) => cap / price));
}

/** One coin's older days, from either source or both. */
export interface EntityParts {
  dataset?: readonly Day[];
  lcw?: readonly Day[];
  /** CoinGecko's supply on its first own day, and that day (UTC s), to scale Live Coin Watch's to. */
  own?: { day: number; supply: number };
}

/**
 * A coin's days from its parts: the dataset's to 7 February 2018, Live Coin Watch's after. Each
 * day's market cap is the source's own, and its supply the week's median of the source's (for
 * an exchange's price to be multiplied by): one day's odd price can't make a week's supply
 * absurd that way, as it does in a few small coins of the dataset. Live Coin Watch's figures
 * are scaled to the dataset's supply over the week both have, and to CoinGecko's on the coin's
 * first own day, in a straight line between, so neither change shows a step.
 */
export function entityDays({ dataset = [], lcw = [], own }: EntityParts): ServedDay[] {
  const out: ServedDay[] = [];
  const datasetSupply = supplies(dataset);
  for (const [i, [day, cap, price]] of dataset.entries()) {
    out.push([day, cap, price, datasetSupply[i] as number]);
  }
  const lcwSupply = supplies(lcw);
  const lcwSupplyOn = new Map(lcw.map(([day], i) => [day, lcwSupply[i] as number]));
  const datasetSupplyOn = new Map(dataset.map(([day], i) => [day, datasetSupply[i] as number]));
  const startRatios = [...lcwSupplyOn]
    .filter(([day]) => day >= OVERLAP_FROM_SEC && day <= DATASET_END_SEC)
    .map(([day, supply]) => (datasetSupplyOn.get(day) ?? Number.NaN) / supply)
    .filter(Number.isFinite);
  const ownSupply = own ? lcwSupplyOn.get(own.day) : undefined;
  const endRatio = own && ownSupply ? own.supply / ownSupply : null;
  const startRatio = startRatios.length ? median(startRatios) : (endRatio ?? 1);
  const fromDay = DATASET_END_SEC + DAY_SEC;
  const toDay = own?.day ?? fromDay;
  for (const [i, [day, cap, price]] of lcw.entries()) {
    if (day <= DATASET_END_SEC && dataset.length > 0) continue;
    const share =
      toDay > fromDay ? Math.min(1, Math.max(0, (day - fromDay) / (toDay - fromDay))) : 1;
    const ratio = startRatio + ((endRatio ?? startRatio) - startRatio) * share;
    out.push([day, cap * ratio, price, (lcwSupply[i] as number) * ratio]);
  }
  return out;
}

/** Days into a value a day from the first, NaN where none. */
function packed(days: readonly ServedDay[]): {
  start: number;
  caps: Float64Array;
  prices: Float64Array;
  supplies: Float64Array;
} {
  const start = days[0]?.[0] ?? 0;
  const length = days.length ? ((days.at(-1) as ServedDay)[0] - start) / DAY_SEC + 1 : 0;
  const caps = new Float64Array(length).fill(Number.NaN);
  const prices = new Float64Array(length).fill(Number.NaN);
  const supplyList = new Float64Array(length).fill(Number.NaN);
  for (const [day, cap, price, supply] of days) {
    const i = (day - start) / DAY_SEC;
    caps[i] = cap;
    prices[i] = price;
    supplyList[i] = supply;
  }
  return { start, caps, prices, supplies: supplyList };
}

export interface OlderBookOptions {
  coins: OlderCoins;
  /** Our own coins' daily points, whose first days the older ones end at. */
  anchors: AnchorBook;
  /** Whether a CoinGecko coin counts, and whether it's a stablecoin, as the universe says. */
  isEligible: (id: string) => boolean;
  isStable: (id: string) => boolean;
  /** Our own first day (UTC s): coins that aren't CoinGecko's end there. */
  joinSec: () => number;
  onWarning?: (message: string) => void;
}

/**
 * Each coin's older days (M9f, docs/SPEC.md §5.14), from what OlderCoins downloaded: for every
 * CRYPTOCAP symbol before our own history, at a day and longer. CoinGecko's coins of today go
 * by their CoinGecko id and end where their own points begin; others (dead coins, coins no longer
 * among the largest) end at our first day.
 */
export class OlderBook {
  private readonly coins: OlderCoins;
  private readonly anchors: AnchorBook;
  private readonly isEligible: (id: string) => boolean;
  private readonly isStable: (id: string) => boolean;
  private readonly joinSec: () => number;
  private readonly warn: (message: string) => void;
  private byId = new Map<string, OlderEntity>();
  private loaded: Promise<void> | null = null;

  constructor(options: OlderBookOptions) {
    this.coins = options.coins;
    this.anchors = options.anchors;
    this.isEligible = options.isEligible;
    this.isStable = options.isStable;
    this.joinSec = options.joinSec;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Reads what's downloaded, once (`reload` to read it again). */
  load(): Promise<void> {
    this.loaded ??= this.build().catch((error: unknown) => {
      this.warn(`Couldn't read the older coins (${error})`);
    });
    return this.loaded;
  }

  reload(): Promise<void> {
    this.loaded = null;
    return this.load();
  }

  entities(): readonly OlderEntity[] {
    return [...this.byId.values()];
  }

  /** The first day any coin has (UTC s), or null. */
  firstSec(): number | null {
    let first: number | null = null;
    for (const entity of this.byId.values()) {
      if (entity.caps.length && (first === null || entity.start < first)) first = entity.start;
    }
    return first;
  }

  entity(id: string): OlderEntity | undefined {
    return this.byId.get(id);
  }

  /** A coin's market cap at `sec`, straight-line between its days; null outside them. */
  capAt(id: string, sec: number): number | null {
    return this.valueAt(id, sec, 'caps');
  }

  priceAt(id: string, sec: number): number | null {
    return this.valueAt(id, sec, 'prices');
  }

  supplyAt(id: string, sec: number): number | null {
    return this.valueAt(id, sec, 'supplies');
  }

  private valueAt(id: string, sec: number, field: 'caps' | 'prices' | 'supplies'): number | null {
    const entity = this.byId.get(id);
    if (!entity || sec >= entity.until || sec < entity.start) return null;
    const values = entity[field];
    const at = (sec - entity.start) / DAY_SEC;
    const i = Math.floor(at);
    const before = values[i];
    if (before === undefined || !Number.isFinite(before)) return null;
    const after = values[i + 1];
    if (at === i || after === undefined || !Number.isFinite(after)) return before;
    return before + (after - before) * (at - i);
  }

  private async build(): Promise<void> {
    const dir = this.coins.directory;
    const contents = await this.coins.contents();
    const info = new Map(contents.listed.map((coin) => [coin[0], coin]));
    const lcw = new Map<string, Day[]>();
    for (const code of contents.done) {
      const path = this.coins.coinPath(code);
      if (!path) continue;
      const file = await readFile(path, 'utf8').then(
        (text) => parseCoinDays(JSON.parse(text)),
        () => null,
      );
      if (file?.code === code) lcw.set(code, lcwDays(file));
    }
    const [capsCsv, closesCsv] = await Promise.all(
      [ETH_ZURICH_CAPS, ETH_ZURICH_CLOSES].map((name) =>
        readFile(join(dir, name), 'utf8').catch(() => null),
      ),
    );
    const dataset = capsCsv && closesCsv ? parseEthZurich(capsCsv, closesCsv) : [];
    const datasetOf = matchDataset(dataset, lcw);
    const lcwOfSlug = new Map([...datasetOf].map(([slug, code]) => [code, slug]));
    const datasetBySlug = new Map(dataset.map((coin) => [coin.slug, coin.points as Day[]]));
    const ours = this.joinSec();
    const byId = new Map<string, OlderEntity>();

    const add = (
      id: string,
      days: ServedDay[],
      until: number,
      stable: boolean,
      eligible: boolean,
    ) => {
      const served = days.filter(([day]) => day < until);
      if (!served.length) return;
      byId.set(id, { id, stable, eligible, until, ...packed(served) });
    };

    for (const [code, days] of lcw) {
      const cgId = contents.matched[code];
      const slug = lcwOfSlug.get(code);
      const parts: EntityParts = { lcw: days };
      if (slug) parts.dataset = datasetBySlug.get(slug) ?? [];
      const coin = info.get(code);
      if (cgId) {
        const first = this.anchors.firstSec(cgId);
        const day = first === null ? null : Math.floor(first / DAY_SEC) * DAY_SEC;
        const supply = first === null ? null : this.anchors.supplyAt(cgId, first);
        if (day !== null && supply) parts.own = { day, supply };
        add(cgId, entityDays(parts), first ?? ours, this.isStable(cgId), this.isEligible(cgId));
      } else {
        const stable = isStablecoin(coin?.[4] ?? []);
        const eligible = !isDerivative(coin?.[1] ?? code, coin?.[4] ?? []);
        add(`lcw:${code}`, entityDays(parts), ours, stable, eligible);
      }
    }
    for (const coin of dataset) {
      if (datasetOf.has(coin.slug)) continue;
      add(
        `cmc:${coin.slug}`,
        entityDays({ dataset: coin.points as Day[] }),
        ours,
        DATASET_STABLES.has(coin.slug),
        true,
      );
    }
    this.byId = byId;
  }
}
