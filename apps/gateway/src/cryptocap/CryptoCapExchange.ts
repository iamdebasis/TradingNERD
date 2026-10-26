import {
  type Bar,
  barOpenTime,
  type CatalogEntry,
  type ExchangeSummary,
  parseResolution,
  type Resolution,
  resolutionDurationMs,
  type SymbolInfo,
  UTC_ZONE,
} from '@tradingnerd/core';
import type { CoinGeckoClient } from '../logos/coingecko.ts';
import type { CoinGeckoUsage } from '../logos/usage.ts';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type Unsubscribe,
} from '../market/types.ts';
import type { SecretStore } from '../storage/secrets.ts';
import { AnchorBook } from './anchors.ts';
import { CapHistory, type CapSource, CHUNK_BARS } from './history.ts';
import { BITCOIN, type CoinCapBar, compositeBars } from './indices.ts';
import { LiveCaps } from './live.ts';
import { LiveCoinWatchClient } from './livecoinwatch.ts';
import { OlderCaps, type OlderSeries } from './older.ts';
import { OlderBook } from './olderBook.ts';
import { OlderCoins } from './olderCoins.ts';
import { PairBook } from './pairs.ts';
import {
  type CapTicker,
  COMPOSITES,
  CRYPTOCAP,
  CRYPTOCAP_BASE,
  capDescription,
  capTickerText,
  parseCapTicker,
  RATIO_OF,
  RATIOS,
} from './symbols.ts';
import { CoinUniverse } from './universe.ts';

/**
 * The intervals CRYPTOCAP is computed in: the fixed ones every exchange of ours serves. The
 * gateway builds the others from these (3 minutes from 1, a week from days).
 */
export const CRYPTOCAP_RESOLUTIONS = ['1', '5', '15', '30', '60', '240', '1D'] as const;

const D1 = parseResolution('1D') as Resolution;
const DAY_MS = 86_400_000;

export interface CryptoCapOptions {
  client: CoinGeckoClient;
  secrets: SecretStore;
  usage: CoinGeckoUsage;
  dataDir: string;
  /** The exchanges coins' prices come from. */
  adapters: readonly ExchangeAdapter[];
  /** Every exchange's pairs (the search catalog's), to pick each coin's price pair from. */
  pairs: () => readonly CatalogEntry[];
  /** Resolves once the pair lists are in, or have been waited for long enough. */
  waitForPairs?: () => Promise<void>;
  now?: () => number;
  /** Waits between CoinGecko history calls; tests pass one that doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How often live values are worked out again (ms). */
  tickMs?: number;
  /** Live Coin Watch, for older market caps: where it is (tests point it elsewhere). */
  livecoinwatch?: { url?: string | undefined; fetch?: typeof fetch };
  /** Where older market caps start downloading from (tests start later). */
  olderOriginMs?: number;
  /**
   * Each coin's older days in the charts, in place of Live Coin Watch's whole market (M9f): off
   * until they're checked against TradingView (CRYPTOCAP_OLDER_COINS=1 for that check).
   */
  olderCoinsInCharts?: boolean;
  onWarning?: (message: string) => void;
}

/** Decimals that show a dominance or ratio to four significant digits: 60.73, 6.876, 0.1323. */
export function decimalsFor(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 2;
  return Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(value))));
}

/**
 * TradingView's CRYPTOCAP: market caps of coins and of the crypto market (TOTAL, TOTAL2, TOTAL3,
 * OTHERS…), their dominance (BTC.D) and ratios (OTHERSBTC), computed here as TradingView
 * computes its own (docs/SPEC.md §4.11): coins' prices from our exchanges, their supply and
 * the coin list from CoinGecko. An exchange to the market service, and a listing to search.
 */
export class CryptoCapExchange implements ExchangeAdapter {
  readonly id = CRYPTOCAP;
  readonly name = CRYPTOCAP;
  readonly maxBarsPerRequest = CHUNK_BARS;
  readonly gapless = true;
  // No `historyFromListing`: its history begins where our data does, not where the index
  // does, so a week or month that opens before our first day is left out.
  readonly nativeResolutions: readonly Resolution[] = CRYPTOCAP_RESOLUTIONS.map(
    (text) => parseResolution(text) as Resolution,
  );

  private readonly universe: CoinUniverse;
  private readonly anchors: AnchorBook;
  private readonly history: CapHistory;
  private readonly live: LiveCaps;
  /** TOTAL, TOTAL2, TOTAL3 and BTC.D before our own history, from Live Coin Watch. */
  readonly older: OlderCaps;
  /** Each coin's older days (M9f): downloaded; in the charts only with `olderCoinsInCharts`. */
  readonly olderCoins: OlderCoins;
  private readonly olderBook: OlderBook | null;
  private readonly now: () => number;
  private readonly waitForPairs: () => Promise<void>;
  /** Tickers resolved so far → what they're made of, for subscribing without waiting. */
  private readonly sources = new Map<string, CapSource>();
  private listed: { at: number; entries: CatalogEntry[] } | null = null;

  constructor(options: CryptoCapOptions) {
    const warn = options.onWarning ?? (() => {});
    this.now = options.now ?? Date.now;
    this.waitForPairs = options.waitForPairs ?? (async () => {});
    this.anchors = new AnchorBook(options.dataDir, warn);
    this.universe = new CoinUniverse({
      client: options.client,
      secrets: options.secrets,
      usage: options.usage,
      anchors: this.anchors,
      dataDir: options.dataDir,
      now: this.now,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      onWarning: warn,
    });
    const livecoinwatch = new LiveCoinWatchClient({
      ...(options.livecoinwatch?.url ? { url: options.livecoinwatch.url } : {}),
      ...(options.livecoinwatch?.fetch ? { fetch: options.livecoinwatch.fetch } : {}),
    });
    // Our own history's first day: where older days end, whether or not they're in the charts.
    const ourFirstDay = () => this.history.firstBarMs(D1, false);
    this.olderCoins = new OlderCoins({
      secrets: options.secrets,
      dataDir: options.dataDir,
      joinMs: ourFirstDay,
      universe: () => this.universe.coins(),
      client: livecoinwatch,
      ...(options.sleep ? { sleep: options.sleep, gapMs: 0 } : {}),
      now: this.now,
      onWarning: warn,
    });
    this.olderBook = options.olderCoinsInCharts
      ? new OlderBook({
          coins: this.olderCoins,
          anchors: this.anchors,
          isEligible: (id) => this.universe.isEligible(id),
          isStable: (id) => this.universe.isStable(id),
          // Coins that aren't CoinGecko's end where our own coins' points begin.
          joinSec: () => {
            const first = this.anchors.firstSec(BITCOIN);
            return first === null ? ourFirstDay() / 1000 : Math.floor(first / 86_400) * 86_400;
          },
          onWarning: warn,
        })
      : null;
    const pairs = new PairBook(options.pairs);
    const adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
    this.history = new CapHistory({
      universe: this.universe,
      anchors: this.anchors,
      ...(this.olderBook ? { older: this.olderBook } : {}),
      pairs,
      adapters,
      now: this.now,
      onWarning: warn,
    });
    this.live = new LiveCaps({
      universe: this.universe,
      anchors: this.anchors,
      pairs,
      adapters,
      history: this.history,
      now: this.now,
      ...(options.tickMs ? { tickMs: options.tickMs } : {}),
      onWarning: warn,
    });
    this.older = new OlderCaps({
      secrets: options.secrets,
      dataDir: options.dataDir,
      joinMs: ourFirstDay,
      ours: (series, joinMs) => this.oursOn(series, joinMs),
      client: livecoinwatch,
      ...(options.olderOriginMs !== undefined ? { originMs: options.olderOriginMs } : {}),
      ...(options.sleep ? { sleep: options.sleep, gapMs: 0 } : {}),
      now: this.now,
      onWarning: warn,
    });
    // History that finishes loading replaces the estimates made while it loaded.
    this.universe.onHistory(() => this.history.invalidate());
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const parsed = parseCapTicker(ticker);
    if (!parsed) throw new MarketError('unknown_symbol', `CRYPTOCAP has no ${ticker}`);
    // Prices come from the exchanges' pairs: their lists are in before any history is built.
    await Promise.all([this.universe.ready(), this.waitForPairs()]);
    const source = this.sourceOf(parsed);
    const text = capTickerText(parsed);
    this.sources.set(text, source);
    const cap = parsed.kind === 'composite' || parsed.kind === 'coin';
    const decimals = cap ? 0 : decimalsFor(this.valueNow(source) ?? 0);
    const coin = parsed.kind === 'coin' ? parsed : parsed.kind === 'dominance' ? parsed.of : null;
    return {
      id: `${CRYPTOCAP}:${text}`,
      exchange: CRYPTOCAP,
      exchangeName: CRYPTOCAP,
      ticker: text,
      base: coin?.kind === 'coin' ? coin.symbol : CRYPTOCAP_BASE,
      quote: parsed.kind === 'dominance' ? '%' : 'USD',
      description: capDescription(parsed),
      type: 'index',
      tickSize: 10 ** -decimals,
      pricePrecision: decimals,
      format: cap ? 'volume' : 'price',
      resolutions: [...CRYPTOCAP_RESOLUTIONS],
      timezone: UTC_ZONE,
      delayMs: 0,
      hasBook: true,
    };
  }

  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const source = await this.source(ticker);
    const period = periodOf(resolution);
    const end = endTimeMs ?? barOpenTime(resolution, this.now()) + period;
    const bars = await this.barsOf(source, resolution, end - limit * period, end);
    return bars.slice(-limit);
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const source = await this.source(ticker);
    const bars = await this.barsOf(source, resolution, startMs, endMs);
    return bars.slice(0, this.maxBarsPerRequest);
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    return this.whenResolved(ticker, (source) =>
      this.live.subscribeCandles(ticker, source, resolution, onUpdate),
    );
  }

  /** An index has no trades: its bars move with the coins' prices. */
  subscribeTrades(): Unsubscribe {
    return () => {};
  }

  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    return this.whenResolved(ticker, (source) => this.live.subscribeBook(ticker, source, onBook));
  }

  isFeedUp(): boolean {
    return this.live.isUp();
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    return this.live.onState(listener);
  }

  /** Resolves once the coins' history being fetched has arrived (tests and diagnostics). */
  historyIdle(): Promise<void> {
    return this.universe.historyIdle();
  }

  /**
   * The saved coins and history, so the first lookup needn't wait for the disk; then the older
   * market caps' and coins' downloads carry on, if there's a key and something left to fetch.
   */
  async prepare(): Promise<void> {
    await this.universe.load();
    void this.older.start();
    void this.olderCoins.start();
  }

  async close(): Promise<void> {
    this.live.close();
    this.universe.close();
    await Promise.all([this.older.close(), this.olderCoins.close()]);
    await this.anchors.flush();
  }

  // ---- as a listing for symbol search ----

  /** Every CRYPTOCAP symbol, for search: the composites, the ratios, and each coin's. */
  entries(): readonly CatalogEntry[] {
    const at = this.universe.fetchedAt() ?? 0;
    if (this.listed?.at === at) return this.listed.entries;
    const entry = (parsed: CapTicker, base: string): CatalogEntry => ({
      exchange: CRYPTOCAP,
      ticker: capTickerText(parsed),
      base,
      quote: parsed.kind === 'dominance' ? '%' : 'USD',
      description: capDescription(parsed),
      volumeUsd: 0,
      live: true,
      kind: 'index',
    });
    const entries: CatalogEntry[] = [];
    for (const name of COMPOSITES) {
      entries.push(entry({ kind: 'composite', name }, CRYPTOCAP_BASE));
      if (name !== 'TOTAL') {
        entries.push(entry({ kind: 'dominance', of: { kind: 'composite', name } }, CRYPTOCAP_BASE));
      }
    }
    for (const name of RATIOS) entries.push(entry({ kind: 'ratio', name }, CRYPTOCAP_BASE));
    const seen = new Set<string>();
    for (const coin of this.coinsByCap()) {
      const parsed = parseCapTicker(coin.symbol);
      if (parsed?.kind !== 'coin' || seen.has(coin.symbol)) continue;
      seen.add(coin.symbol);
      entries.push(
        entry(parsed, coin.symbol),
        entry({ kind: 'dominance', of: parsed }, coin.symbol),
      );
    }
    this.listed = { at, entries };
    return entries;
  }

  exchanges(): ExchangeSummary[] {
    return [{ id: CRYPTOCAP, name: CRYPTOCAP, live: true, market: 'crypto' }];
  }

  /** Resolves once the saved coins are read, or after `timeoutMs`. */
  async ready(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.universe.load(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  // ----

  private coinsByCap() {
    return this.universe
      .coins()
      .filter((coin) => this.universe.isEligible(coin.id))
      .sort((a, b) => b.cap - a.cap);
  }

  /** What a parsed ticker is made of; a coin must be one TradingView counts. */
  private sourceOf(parsed: CapTicker): CapSource {
    const coinSource = (symbol: string): CapSource => {
      const coin = this.universe.bySymbol(symbol);
      if (!coin) throw new MarketError('unknown_symbol', `CRYPTOCAP has no ${symbol}`);
      return { kind: 'coin', id: coin.id };
    };
    switch (parsed.kind) {
      case 'composite':
        return parsed;
      case 'ratio':
        return parsed;
      case 'coin':
        return coinSource(parsed.symbol);
      case 'dominance': {
        const of = parsed.of.kind === 'coin' ? coinSource(parsed.of.symbol) : parsed.of;
        return { kind: 'dominance', of: of as Extract<CapSource, { kind: 'composite' | 'coin' }> };
      }
    }
  }

  private async source(ticker: string): Promise<CapSource> {
    const known = this.sources.get(ticker);
    if (known) {
      this.universe.touch();
      return known;
    }
    await this.resolveSymbol(ticker);
    return this.sources.get(ticker) as CapSource;
  }

  /** Subscribes once the ticker is resolved (the market service resolves before it subscribes). */
  private whenResolved(ticker: string, subscribe: (source: CapSource) => Unsubscribe): Unsubscribe {
    const known = this.sources.get(ticker);
    if (known) return subscribe(known);
    let stop: Unsubscribe | null = null;
    let cancelled = false;
    this.source(ticker).then(
      (source) => {
        if (!cancelled) stop = subscribe(source);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }

  /**
   * `source`'s bars opening in [startMs, endMs): ours, and for the daily bars of TOTAL, TOTAL2,
   * TOTAL3 and BTC.D before ours begin, Live Coin Watch's (OlderCaps).
   */
  private async barsOf(
    source: CapSource,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const ours = await this.history.bars(source, resolution, startMs, endMs);
    // Each coin's older days give every symbol its older bars: Live Coin Watch's whole market isn't
    // added then.
    if (this.olderBook) return ours;
    const series = olderSeriesOf(source);
    if (!series || resolution.unit !== 'day' || resolution.count !== 1) return ours;
    const join = this.history.firstBarMs(resolution, false);
    if (startMs >= join) return ours;
    const older = await this.older.bars(series, startMs, Math.min(endMs, join));
    return [...older, ...ours];
  }

  /** Our own close of an older series on the join day, for the older bars to blend toward. */
  private async oursOn(series: OlderSeries, joinMs: number): Promise<number | null> {
    const source: CapSource =
      series === 'BTC.D'
        ? { kind: 'dominance', of: { kind: 'coin', id: BITCOIN } }
        : { kind: 'composite', name: series };
    const [bar] = await this.history.bars(source, D1, joinMs, joinMs + DAY_MS);
    return bar && bar.time * 1000 === joinMs ? bar.close : null;
  }

  /** A ticker's value from CoinGecko's latest market caps: for its decimals. */
  private valueNow(source: CapSource): number | null {
    const coins: CoinCapBar[] = this.coinsByCap().map((coin) => ({
      id: coin.id,
      open: coin.cap,
      high: coin.cap,
      low: coin.cap,
      close: coin.cap,
      volume: 0,
      stable: this.universe.isStable(coin.id),
    }));
    const composites = compositeBars(coins);
    const capOf = (id: string) => this.universe.coin(id)?.cap ?? null;
    const valueFor = (of: CapSource): number | null => {
      switch (of.kind) {
        case 'composite':
          return composites[of.name].close;
        case 'coin':
          return capOf(of.id);
        case 'ratio': {
          const bitcoin = capOf(BITCOIN);
          return bitcoin ? composites[RATIO_OF[of.name]].close / bitcoin : null;
        }
        case 'dominance': {
          const part = valueFor(of.of);
          return part === null ? null : (part / composites.TOTAL.close) * 100;
        }
      }
    };
    return valueFor(source);
  }
}

/** The older series a source has, if any: TOTAL, TOTAL2, TOTAL3 and Bitcoin's dominance. */
function olderSeriesOf(source: CapSource): OlderSeries | null {
  if (source.kind === 'composite') {
    return source.name === 'TOTAL' || source.name === 'TOTAL2' || source.name === 'TOTAL3'
      ? source.name
      : null;
  }
  if (source.kind === 'dominance' && source.of.kind === 'coin' && source.of.id === BITCOIN) {
    return 'BTC.D';
  }
  return null;
}

function periodOf(resolution: Resolution): number {
  const period = resolutionDurationMs(resolution);
  if (period === null) {
    throw new MarketError('unsupported_resolution', 'CRYPTOCAP is served in fixed intervals');
  }
  return period;
}
