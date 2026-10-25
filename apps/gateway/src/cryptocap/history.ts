import {
  type Bar,
  barOpenTime,
  formatResolution,
  type Resolution,
  resampleBars,
  resampleBase,
  resolutionDurationMs,
  UTC_CLOCK,
} from '@tradingnerd/core';
import { type ExchangeAdapter, MarketError } from '../market/types.ts';
import type { AnchorBook } from './anchors.ts';
import {
  BITCOIN,
  type CapBar,
  type CoinCapBar,
  compositeBars,
  divideBars,
  STABLE_COINS,
} from './indices.ts';
import type { PairBook, PricePair } from './pairs.ts';
import { COMPOSITES, type CompositeName, RATIO_OF, type RatioName } from './symbols.ts';
import type { CoinUniverse } from './universe.ts';

/** A CRYPTOCAP ticker with its coins found: what its bars are made of. */
export type CapSource =
  | { kind: 'composite'; name: CompositeName }
  | { kind: 'coin'; id: string }
  | { kind: 'ratio'; name: RatioName }
  | {
      kind: 'dominance';
      of: { kind: 'composite'; name: CompositeName } | { kind: 'coin'; id: string };
    };

/** History is computed and kept this many bars at a time. */
export const CHUNK_BARS = 1_000;
/** Coins ranked this high on some day of a chunk have their prices fetched for it. */
export const CANDIDATE_RANK = 140;
/** A chunk keeps the bars of this many of the largest coins (others are computed on request). */
const KEPT_COINS = 40;
/** Chunks and single coins' series kept in memory, the least recently used dropped first. */
const MAX_CHUNKS = 24;
const MAX_COIN_SERIES = 64;
/** A chunk reaching into the present, or one with prices missing, is computed again this soon. */
const RECOMPUTE_MS = 60_000;
/** Requests to one exchange at a time. */
const PER_EXCHANGE = 6;
/**
 * An exchange price this far from CoinGecko's belongs to another coin of the same symbol: such
 * coins are apart by multiples, while one coin's price rarely moves 30% between CoinGecko's
 * daily points.
 */
export const PRICE_TOLERANCE = 0.3;
/** Most requests one coin's bars may take for a chunk. */
const MAX_PAGES = 8;
/** History reaches back a year: the circulating supply CoinGecko's free plan gives. */
export const HISTORY_DAYS = 365;
const DAY_SEC = 86_400;
const DAY_MS = DAY_SEC * 1000;

/** One chunk's bars: every composite's, and the largest coins' market caps. */
interface Chunk {
  /** Bar open times (UTC s), ascending: every period from the start of history to now. */
  times: number[];
  composites: Map<CompositeName, CapBar[]>;
  /** Coin id → its market cap per time (null before it has one). */
  coins: Map<string, (CapBar | null)[]>;
  /** When it should be computed again (epoch ms); never for a chunk wholly in the past. */
  expires: number;
}

/** A coin's prices from its pair over a chunk. */
interface CoinPrices {
  pair: PricePair;
  /** Bar open (s) → bar, in the pair's quote. */
  bars: Map<number, Bar>;
}

/** At most `limit` tasks at a time; the rest wait their turn. */
class Limiter {
  private readonly limit: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((go) => this.waiting.push(go));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

export interface CapHistoryOptions {
  universe: CoinUniverse;
  anchors: AnchorBook;
  pairs: PairBook;
  /** The exchanges coins' prices come from, by id. */
  adapters: ReadonlyMap<string, ExchangeAdapter>;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/**
 * CRYPTOCAP's history: each coin's market cap is its pair's price in US dollars times its
 * circulating supply at the time (AnchorBook), the way TradingView defines it ("last price *
 * circulating supply"); coins none of our exchanges trades, and times before a pair's first
 * bar, take CoinGecko's own market cap. The composites add up the coins of each bar (see
 * compositeBars). History is computed 1,000 bars at a time, for every composite at once, and
 * kept in memory; it reaches back a year.
 */
export class CapHistory {
  private readonly universe: CoinUniverse;
  private readonly anchors: AnchorBook;
  private readonly pairs: PairBook;
  private readonly adapters: ReadonlyMap<string, ExchangeAdapter>;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly chunks = new Map<string, Chunk>();
  private readonly coinSeries = new Map<string, { bars: (CapBar | null)[]; expires: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly limiters = new Map<string, Limiter>();
  private readonly warned = new Set<string>();
  /** Bumped when more history has loaded, so older results are computed again. */
  private version = 0;

  constructor(options: CapHistoryOptions) {
    this.universe = options.universe;
    this.anchors = options.anchors;
    this.pairs = options.pairs;
    this.adapters = options.adapters;
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Forgets what was computed: more history arrived. */
  invalidate(): void {
    this.version++;
    this.chunks.clear();
    this.coinSeries.clear();
  }

  /** The first bar's open time (ms) at `resolution`: a year back. */
  firstBarMs(resolution: Resolution): number {
    const period = durationOf(resolution);
    return barOpenTime(resolution, this.now() - HISTORY_DAYS * DAY_MS) + period;
  }

  /** The bars of `source` opening in [startMs, endMs), ascending. */
  async bars(
    source: CapSource,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const period = durationOf(resolution);
    const span = CHUNK_BARS * period;
    const from = Math.max(startMs, this.firstBarMs(resolution));
    const to = Math.min(endMs, barOpenTime(resolution, this.now()) + period);
    if (from >= to) return [];
    const out: Bar[] = [];
    for (let index = Math.floor(from / span); index * span < to; index++) {
      const { times, values } = await this.chunkSeries(source, resolution, index);
      for (const [i, time] of times.entries()) {
        const value = values[i];
        if (value && time * 1000 >= from && time * 1000 < to) out.push(toBar(time, value));
      }
    }
    return out;
  }

  /** `source`'s values over one chunk, aligned with its times (null where it has none). */
  private async chunkSeries(
    source: CapSource,
    resolution: Resolution,
    index: number,
  ): Promise<{ times: number[]; values: (CapBar | null)[] }> {
    const wanted = coinOf(source);
    const chunk = await this.chunk(resolution, index, wanted);
    const series = async (of: CapSource): Promise<(CapBar | null)[]> => {
      switch (of.kind) {
        case 'composite':
          return chunk.composites.get(of.name) ?? [];
        case 'coin':
          return chunk.coins.get(of.id) ?? (await this.coinAlone(of.id, resolution, index, chunk));
        case 'ratio': {
          const [top, bitcoin] = await Promise.all([
            series({ kind: 'composite', name: RATIO_OF[of.name] }),
            series({ kind: 'coin', id: BITCOIN }),
          ]);
          return top.map((bar, i) => divided(bar, bitcoin[i], 1));
        }
        case 'dominance': {
          const [part, total] = await Promise.all([
            series(of.of),
            series({ kind: 'composite', name: 'TOTAL' }),
          ]);
          return part.map((bar, i) => divided(bar, total[i], 100));
        }
      }
    };
    return { times: chunk.times, values: await series(source) };
  }

  /** One chunk's bars, computed once and kept (in flight requests share the work). */
  private chunk(resolution: Resolution, index: number, wanted: string | null): Promise<Chunk> {
    const key = `${formatResolution(resolution)}|${index}|${this.version}`;
    const kept = this.chunks.get(key);
    if (kept && kept.expires > this.now()) {
      this.chunks.delete(key);
      this.chunks.set(key, kept); // most recently used
      return Promise.resolve(kept);
    }
    return this.once(`chunk|${key}`, async () => {
      const chunk = await this.compute(resolution, index, wanted);
      this.chunks.delete(key);
      this.chunks.set(key, chunk);
      for (const oldest of this.chunks.keys()) {
        if (this.chunks.size <= MAX_CHUNKS) break;
        this.chunks.delete(oldest);
      }
      return chunk;
    });
  }

  /** A coin the chunk didn't keep: its own prices over the chunk, fetched on their own. */
  private coinAlone(
    id: string,
    resolution: Resolution,
    index: number,
    chunk: Chunk,
  ): Promise<(CapBar | null)[]> {
    const key = `${id}|${formatResolution(resolution)}|${index}|${this.version}`;
    const kept = this.coinSeries.get(key);
    if (kept && kept.expires > this.now()) return Promise.resolve(kept.bars);
    return this.once(`coin|${key}`, async () => {
      const period = durationOf(resolution);
      const { prices, complete } = await this.fetchPrices([id], resolution, chunk.times, period);
      const caps = this.capsOf(id, chunk.times, period, prices.get(id), this.tetherOf(prices));
      const expires = complete && chunk.expires === Infinity ? Infinity : this.now() + RECOMPUTE_MS;
      this.coinSeries.set(key, { bars: caps, expires });
      for (const oldest of this.coinSeries.keys()) {
        if (this.coinSeries.size <= MAX_COIN_SERIES) break;
        this.coinSeries.delete(oldest);
      }
      return caps;
    });
  }

  private once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const promise = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async compute(
    resolution: Resolution,
    index: number,
    wanted: string | null,
  ): Promise<Chunk> {
    const period = durationOf(resolution);
    const span = CHUNK_BARS * period;
    const now = this.now();
    const first = Math.max(index * span, this.firstBarMs(resolution));
    const live = barOpenTime(resolution, now);
    const times: number[] = [];
    for (let open = first; open < (index + 1) * span && open <= live; open += period) {
      times.push(open / 1000);
    }
    const reachesNow = (index + 1) * span > live;
    const { candidates, stables } = this.candidates(times);
    const largest = this.largestCoins(KEPT_COINS);
    const keep = new Set([...largest, ...(wanted ? [wanted] : [])]);
    for (const id of keep) candidates.add(id);
    const fetched = await this.fetchPrices([...candidates], resolution, times, period);
    const { prices } = fetched;
    // Without the exchanges' pair lists every coin would be CoinGecko's daily points: fine for
    // now, but computed again once the lists are in.
    const complete = fetched.complete && this.pairs.ready();
    if (!prices.has(BITCOIN) && this.pairs.pairFor('BTC')) {
      throw new MarketError('upstream_error', "Bitcoin's prices couldn't be loaded; retrying");
    }

    const everyone = [...new Set([...candidates, ...stables])];
    const tether = this.tetherOf(prices);
    const caps = new Map(
      everyone.map((id) => [id, this.capsOf(id, times, period, prices.get(id), tether)] as const),
    );
    const composites = new Map<CompositeName, CapBar[]>(COMPOSITES.map((name) => [name, []]));
    for (const [i] of times.entries()) {
      const coins: CoinCapBar[] = [];
      for (const id of everyone) {
        const cap = caps.get(id)?.[i];
        if (cap) coins.push({ ...cap, id, stable: this.universe.isStable(id) });
      }
      const values = compositeBars(coins);
      for (const name of COMPOSITES) composites.get(name)?.push(withVolume(values[name]));
    }
    return {
      times,
      composites,
      coins: new Map([...keep].map((id) => [id, caps.get(id) ?? times.map(() => null)])),
      expires: reachesNow || !complete ? now + RECOMPUTE_MS : Number.POSITIVE_INFINITY,
    };
  }

  /**
   * The coins a chunk is made of: those ranked in the top 140 (eligible ones, by CoinGecko's
   * market caps) on any of its days or today, and the 100 largest stablecoins (for STABLE.C).
   */
  private candidates(times: readonly number[]): { candidates: Set<string>; stables: Set<string> } {
    const candidates = new Set<string>(this.largestCoins(CANDIDATE_RANK));
    const stables = new Set<string>();
    const first = times[0];
    const last = times.at(-1);
    if (first === undefined || last === undefined) return { candidates, stables };
    const eligible = this.universe.coins().filter((coin) => this.universe.isEligible(coin.id));
    for (let day = Math.floor(first / DAY_SEC) * DAY_SEC; day <= last; day += DAY_SEC) {
      const ranked = eligible
        .map((coin) => ({ id: coin.id, cap: this.anchors.estimatedCapAt(coin.id, day) }))
        .filter((coin): coin is { id: string; cap: number } => coin.cap !== null)
        .sort((a, b) => b.cap - a.cap);
      for (const coin of ranked.slice(0, CANDIDATE_RANK)) candidates.add(coin.id);
      const stable = ranked.filter((coin) => this.universe.isStable(coin.id));
      for (const coin of stable.slice(0, STABLE_COINS)) stables.add(coin.id);
    }
    return { candidates, stables };
  }

  /** The largest eligible coins now, by CoinGecko's market cap. */
  private largestCoins(count: number): string[] {
    return this.universe
      .coins()
      .filter((coin) => this.universe.isEligible(coin.id))
      .sort((a, b) => b.cap - a.cap)
      .slice(0, count)
      .map((coin) => coin.id);
  }

  /**
   * Each coin's pair's bars over the chunk's times, and Tether's (to turn USDT prices into US
   * dollars). A pair whose prices are far from CoinGecko's is set aside: it trades another coin
   * of the same symbol. `complete` is false when a fetch failed, so the chunk is tried again.
   */
  private async fetchPrices(
    ids: readonly string[],
    resolution: Resolution,
    times: readonly number[],
    period: number,
  ): Promise<{ prices: Map<string, CoinPrices>; complete: boolean }> {
    const prices = new Map<string, CoinPrices>();
    const first = times[0];
    const last = times.at(-1);
    if (first === undefined || last === undefined) return { prices, complete: true };
    const tether = this.universe.bySymbol('USDT')?.id;
    const wanted = new Set(ids);
    if (tether) wanted.add(tether);
    let complete = true;
    await Promise.all(
      [...wanted].map(async (id) => {
        const coin = this.universe.coin(id);
        const pair = coin ? this.pairs.pairFor(coin.symbol) : null;
        const adapter = pair ? this.adapters.get(pair.exchange) : undefined;
        if (!pair || !adapter) return;
        try {
          const bars = await this.limiter(pair.exchange).run(() =>
            fetchSeries(adapter, pair.ticker, resolution, first * 1000, last * 1000 + period),
          );
          if (bars.length > 0) {
            prices.set(id, { pair, bars: new Map(bars.map((bar) => [bar.time, bar])) });
          }
        } catch (error) {
          complete = false;
          this.warnOnce(`fetch|${pair.exchange}:${pair.ticker}`, () => {
            const detail = error instanceof Error ? error.message : String(error);
            return `Couldn't load ${pair.exchange}:${pair.ticker} for its market cap (${detail})`;
          });
        }
      }),
    );
    for (const [id, coin] of prices) {
      if (id !== tether && !this.pricesMatch(id, coin, prices.get(tether ?? ''))) {
        this.pairs.reject(coin.pair);
        prices.delete(id);
        this.warnOnce(`reject|${coin.pair.exchange}:${coin.pair.ticker}`, () => {
          return `${coin.pair.exchange}:${coin.pair.ticker} is priced unlike CoinGecko's ${id}; using CoinGecko's market cap`;
        });
      }
    }
    return { prices, complete };
  }

  /** Whether a pair's latest price is near CoinGecko's for the coin at that time. */
  private pricesMatch(id: string, coin: CoinPrices, tether: CoinPrices | undefined): boolean {
    const last = [...coin.bars.values()].at(-1);
    if (!last) return true;
    // While the coin's history loads, CoinGecko's latest price tells as well.
    const reference = this.anchors.priceAt(id, last.time) ?? this.universe.coin(id)?.price ?? null;
    if (reference === null) return true;
    const price = last.close * this.rate(coin.pair.quote, last.time, tether);
    return Math.abs(price / reference - 1) <= PRICE_TOLERANCE;
  }

  /** US dollars per unit of a pair's quote at `time`: Tether and USDC at their own price. */
  private rate(quote: PricePair['quote'], time: number, tether: CoinPrices | undefined): number {
    if (quote === 'USD') return 1;
    if (quote === 'USDT') {
      const id = this.universe.bySymbol('USDT')?.id;
      return tether?.bars.get(time)?.close ?? (id ? this.anchors.priceAt(id, time) : null) ?? 1;
    }
    const id = this.universe.bySymbol('USDC')?.id;
    return (id ? this.anchors.priceAt(id, time) : null) ?? 1;
  }

  /**
   * A coin's market cap per time: its pair's price in dollars times its supply then; a period
   * its pair didn't trade keeps the last price; before its pair's first bar (or with no pair),
   * CoinGecko's market cap between its daily points.
   */
  private capsOf(
    id: string,
    times: readonly number[],
    period: number,
    prices: CoinPrices | undefined,
    tether: CoinPrices | undefined,
  ): (CapBar | null)[] {
    const coin = this.universe.coin(id);
    const dailyVolume = coin?.volume ?? 0;
    let lastPrice: number | null = null;
    return times.map((time) => {
      const supply = this.anchors.supplyAt(id, time);
      if (prices && supply !== null) {
        const rate = this.rate(prices.pair.quote, time, tether);
        const bar = prices.bars.get(time);
        if (bar) {
          lastPrice = bar.close * rate;
          return {
            open: bar.open * rate * supply,
            high: bar.high * rate * supply,
            low: bar.low * rate * supply,
            close: bar.close * rate * supply,
            volume: bar.volume * bar.close * rate,
          };
        }
        if (lastPrice !== null) {
          const cap = lastPrice * supply;
          return { open: cap, high: cap, low: cap, close: cap, volume: 0 };
        }
      }
      const open = this.anchors.estimatedCapAt(id, time);
      if (open === null) return null;
      const close = this.anchors.estimatedCapAt(id, time + period / 1000) ?? open;
      return {
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: (dailyVolume * period) / DAY_MS,
      };
    });
  }

  /** Tether's own prices among those fetched, for turning USDT prices into US dollars. */
  private tetherOf(prices: ReadonlyMap<string, CoinPrices>): CoinPrices | undefined {
    const id = this.universe.bySymbol('USDT')?.id;
    return id ? prices.get(id) : undefined;
  }

  private limiter(exchange: string): Limiter {
    let limiter = this.limiters.get(exchange);
    if (!limiter) {
      limiter = new Limiter(PER_EXCHANGE);
      this.limiters.set(exchange, limiter);
    }
    return limiter;
  }

  private warnOnce(key: string, message: () => string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message());
  }
}

/** The coin a source needs kept in its chunk, if it's one coin's. */
function coinOf(source: CapSource): string | null {
  if (source.kind === 'coin') return source.id;
  if (source.kind === 'dominance' && source.of.kind === 'coin') return source.of.id;
  return null;
}

function durationOf(resolution: Resolution): number {
  const period = resolutionDurationMs(resolution);
  if (period === null) {
    throw new MarketError('unsupported_resolution', 'CRYPTOCAP is served in fixed intervals');
  }
  return period;
}

function divided(a: CapBar | null, b: CapBar | null | undefined, scale: number): CapBar | null {
  return a && b ? divideBars(a, b, scale) : null;
}

/** Every bar counts as traded, so a resampled interval keeps all of them (resampleBars). */
function withVolume(bar: CapBar): CapBar {
  return bar.volume > 0 ? bar : { ...bar, volume: 1 };
}

function toBar(time: number, value: CapBar): Bar {
  return { time, ...withVolume(value) };
}

/**
 * A pair's bars opening in [fromMs, toMs): page after page of the exchange's own interval, or
 * of the nearest one it has that the interval is made of (Coinbase has no 4 hours), folded.
 */
async function fetchSeries(
  adapter: ExchangeAdapter,
  ticker: string,
  resolution: Resolution,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  const native = adapter.nativeResolutions.some(
    (r) => r.unit === resolution.unit && r.count === resolution.count,
  )
    ? resolution
    : resampleBase(resolution, adapter.nativeResolutions, UTC_CLOCK);
  if (!native) return [];
  const step = resolutionDurationMs(native);
  if (step === null) return [];
  const bars: Bar[] = [];
  let cursor = fromMs;
  for (let page = 0; page < MAX_PAGES && cursor < toMs; page++) {
    const fetched = await adapter.fetchRange(ticker, native, cursor, toMs);
    const fresh = fetched.filter((bar) => bar.time * 1000 >= cursor && bar.time * 1000 < toMs);
    const last = fresh.at(-1);
    if (!last) break;
    bars.push(...fresh);
    cursor = last.time * 1000 + step;
  }
  return native === resolution ? bars : resampleBars(bars, resolution, UTC_CLOCK);
}
