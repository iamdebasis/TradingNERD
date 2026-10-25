import { join } from 'node:path';
import {
  type CoinGeckoClient,
  CoinGeckoError,
  type CoinGeckoKey,
  type MarketCoin,
} from '../logos/coingecko.ts';
import type { CoinGeckoUsage } from '../logos/usage.ts';
import { MarketError } from '../market/types.ts';
import { JsonFile } from '../storage/jsonFile.ts';
import type { SecretStore } from '../storage/secrets.ts';
import type { AnchorBook } from './anchors.ts';
import { STABLE_COINS } from './indices.ts';

/**
 * Coins CoinGecko ranks but TradingView's Crypto Coins Screener doesn't list, so they're left
 * out of every CRYPTOCAP symbol: tokenized funds, loans and stocks, and coins it has no market
 * for. Found by comparing CoinGecko's top 250 with TradingView's own ranking on 2026-10-24
 * (docs/SPEC.md §4.11); provisional, to keep in step with TradingView's list.
 */
export const EXCLUDED_COINS: ReadonlySet<string> = new Set([
  'figure-heloc',
  'usds',
  'whitebit',
  'rain',
  'bitway',
  'hashnote-usyc',
  'ondo-us-dollar-yield',
  'blackrock-usd-institutional-digital-liquidity-fund',
  'falcon-finance',
  'spiko-amundi-overnight-swap-fund-eur',
  'htx-dao',
  'bfusd',
  'usdgo',
  'open-usd',
  'superstate-short-duration-us-government-securities-fund-ustb',
  'gho',
  'akedo',
  'pearl-2',
  'beldex',
  'janus-henderson-anemoy-aaa-clo-fund',
  'usual-usd',
  'eutbl',
  'ylds',
  'a7a5',
  'grass',
  'hash-2',
  'quack-ai',
  'derive',
  're-protocol-reusd',
  'sofiusd',
  'kinesis-gold',
]);

/** How often the coins' prices, caps and supply are fetched while CRYPTOCAP is in use. */
export const REFRESH_MS = 15 * 60_000;
/** …and once the month's CoinGecko calls run low. */
export const SLOW_REFRESH_MS = 60 * 60_000;
/** After this long without a CRYPTOCAP symbol in use, the refreshes stop. */
export const IDLE_MS = 30 * 60_000;
/** Which coins are stablecoins is asked for once a day. */
const STABLES_MS = 24 * 3_600_000;
/**
 * The coins whose year of history is fetched: every counted one of the 250 largest (a coin
 * that ranks low today may have been in TOTAL's top 125 a year ago), and STABLE.C's.
 */
export const HISTORY_COINS = 250;
/** Days of history CoinGecko's free plan gives. */
export const HISTORY_DAYS = 365;
/** Gap between history calls, well inside the free plan's 100 calls a minute. */
const HISTORY_PACE_MS = 1_200;
/** After a refused or failed call, wait this long. */
const BACKOFF_MS = 60_000;

interface Stored {
  version: 1;
  /** When the coins were fetched (epoch ms). */
  at: number;
  coins: MarketCoin[];
  /** CoinGecko's stablecoins, and when they were fetched. */
  stables: string[];
  stablesAt: number;
}

const isCoin = (value: unknown): value is MarketCoin => {
  if (typeof value !== 'object' || value === null) return false;
  const coin = value as Record<string, unknown>;
  return (
    typeof coin.id === 'string' &&
    typeof coin.symbol === 'string' &&
    typeof coin.name === 'string' &&
    (coin.rank === null || typeof coin.rank === 'number') &&
    ['price', 'cap', 'supply', 'volume'].every((key) => typeof coin[key] === 'number')
  );
};

function parseStored(value: unknown): Stored | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, at, coins, stables, stablesAt } = value as Record<string, unknown>;
  if (version !== 1 || typeof at !== 'number' || typeof stablesAt !== 'number') return null;
  if (!Array.isArray(coins) || !coins.every(isCoin)) return null;
  if (!Array.isArray(stables) || !stables.every((id) => typeof id === 'string')) return null;
  return { version: 1, at, coins, stables, stablesAt };
}

export interface CoinUniverseOptions {
  client: CoinGeckoClient;
  secrets: SecretStore;
  usage: CoinGeckoUsage;
  anchors: AnchorBook;
  dataDir: string;
  now?: () => number;
  /** For waiting between history calls; tests pass one that doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
  onWarning?: (message: string) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The coins CRYPTOCAP's market caps are made of: CoinGecko's 250 largest and its largest
 * stablecoins, with prices, market caps and circulating supply, fetched every 15 minutes while
 * a CRYPTOCAP symbol is in use (data/cryptocap/coins.json keeps the last). Also loads each
 * large coin's year of history once, a call a coin, into the AnchorBook.
 */
export class CoinUniverse {
  private readonly client: CoinGeckoClient;
  private readonly secrets: SecretStore;
  private readonly usage: CoinGeckoUsage;
  private readonly anchors: AnchorBook;
  private readonly file: JsonFile<Stored>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly warn: (message: string) => void;
  private stored: Stored | null = null;
  private byId = new Map<string, MarketCoin>();
  private stables: ReadonlySet<string> = new Set();
  private loaded: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private lastUse = Number.NEGATIVE_INFINITY;
  private failedAt = Number.NEGATIVE_INFINITY;
  /** Why the last fetch failed, for a first lookup that has nothing to fall back on. */
  private lastError: unknown = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backfilling: Promise<void> | null = null;
  /** When missing history was last looked for outside a refresh (epoch ms). */
  private backfillCheckedAt = Number.NEGATIVE_INFINITY;
  private readonly historyListeners = new Set<() => void>();
  private closed = false;

  constructor(options: CoinUniverseOptions) {
    this.client = options.client;
    this.secrets = options.secrets;
    this.usage = options.usage;
    this.anchors = options.anchors;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? wait;
    this.warn = options.onWarning ?? (() => {});
    this.file = new JsonFile(join(options.dataDir, 'cryptocap', 'coins.json'), parseStored, {
      indent: 0,
    });
  }

  /** The saved coins, if any, and their history. */
  load(): Promise<void> {
    this.loaded ??= Promise.all([
      this.file.read().then(
        (stored) => {
          if (stored && !this.stored) this.use(stored);
        },
        (error: unknown) => this.warn(`Couldn't read the saved coins (${error})`),
      ),
      this.anchors.load(),
      this.usage.load(),
    ]).then(() => {});
    return this.loaded;
  }

  /**
   * Resolves once there are coins to build market caps from: the saved ones, or a fetch. Fails
   * when there are none and CoinGecko can't be asked (no key, or unreachable).
   */
  async ready(): Promise<void> {
    await this.load();
    this.touch();
    if (this.stored) return;
    await this.refresh();
    if (this.stored) return;
    if (this.lastError instanceof MarketError) throw this.lastError;
    throw new MarketError('upstream_error', 'Market caps could not be loaded from CoinGecko');
  }

  /**
   * Marks CRYPTOCAP as in use: the coins are fetched again once 15 minutes old (an hour once
   * the month's calls run low), and keep being fetched until it's idle for 30 minutes.
   */
  touch(): void {
    this.lastUse = this.now();
    this.resumeBackfill();
    if (this.closed || this.refreshing || this.timer !== undefined) return;
    if (this.stale()) void this.refresh().catch(() => {});
    else this.schedule();
  }

  coins(): readonly MarketCoin[] {
    return this.stored?.coins ?? [];
  }

  coin(id: string): MarketCoin | undefined {
    return this.byId.get(id);
  }

  /** When the coins were fetched (epoch ms), or null. */
  fetchedAt(): number | null {
    return this.stored?.at ?? null;
  }

  isStable(id: string): boolean {
    return this.stables.has(id);
  }

  /** Whether a coin counts in TradingView's market caps: one CoinGecko ranks, not excluded. */
  isEligible(id: string): boolean {
    const coin = this.byId.get(id);
    return !!coin && coin.rank !== null && !EXCLUDED_COINS.has(id);
  }

  /**
   * The coin a CRYPTOCAP ticker names, by symbol: the largest eligible one with it ("XRP" is
   * ripple, not a smaller coin sharing the symbol).
   */
  bySymbol(symbol: string): MarketCoin | undefined {
    const wanted = symbol.toUpperCase();
    return this.coins().find((coin) => coin.symbol === wanted && this.isEligible(coin.id));
  }

  /** Calls `listener` whenever more history has loaded. */
  onHistory(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  /** Resolves once the history being loaded has arrived (tests and diagnostics). */
  async historyIdle(): Promise<void> {
    await this.backfilling;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private stale(): boolean {
    const at = this.stored?.at ?? Number.NEGATIVE_INFINITY;
    const level = this.usage.level();
    if (level === 'stop' && this.stored) return false;
    const every = level === 'ok' ? REFRESH_MS : SLOW_REFRESH_MS;
    return this.now() - at >= every && this.now() - this.failedAt >= BACKOFF_MS;
  }

  private schedule(): void {
    if (this.closed || this.timer !== undefined) return;
    if (this.now() - this.lastUse >= IDLE_MS) return;
    const at = this.stored?.at ?? this.now();
    const every = this.usage.level() === 'ok' ? REFRESH_MS : SLOW_REFRESH_MS;
    const delay = Math.max(BACKOFF_MS, at + every - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.now() - this.lastUse < IDLE_MS) this.touch();
    }, delay);
    this.timer.unref?.();
  }

  private refresh(): Promise<void> {
    this.refreshing ??= this.fetchCoins()
      .then(() => {
        this.lastError = null;
      })
      .catch((error: unknown) => {
        this.failedAt = this.now();
        this.lastError = error;
        this.warn(`Couldn't fetch coins from CoinGecko (${messageOf(error)})`);
      })
      .finally(() => {
        this.refreshing = null;
        this.schedule();
      });
    return this.refreshing;
  }

  private async key(): Promise<CoinGeckoKey> {
    const stored = await this.secrets.coingecko();
    if (!stored) {
      throw new MarketError(
        'upstream_error',
        "Market caps need a CoinGecko key: add it in the watchlist's ⋯ menu, Coin logos (CoinGecko)…",
      );
    }
    if (stored.plan) return { key: stored.key, plan: stored.plan };
    const plan = await this.client.check(stored.key);
    if (stored.source === 'env') this.secrets.setEnvPlan(plan);
    return { key: stored.key, plan };
  }

  private async fetchCoins(): Promise<void> {
    const key = await this.key();
    const at = this.now();
    const top = await this.client.markets(key, { page: 1 });
    let stables = this.stored?.stables ?? [];
    let stablesAt = this.stored?.stablesAt ?? 0;
    let stableCoins: readonly MarketCoin[] = [];
    if (at - stablesAt >= STABLES_MS || stables.length === 0) {
      stableCoins = await this.client.markets(key, { page: 1, category: 'stablecoins' });
      stables = stableCoins.map((coin) => coin.id);
      stablesAt = at;
    } else {
      // Between the daily looks, the stablecoins outside the top 250 keep their last values.
      const kept = new Set(top.map((coin) => coin.id));
      stableCoins = (this.stored?.coins ?? []).filter(
        (coin) => stables.includes(coin.id) && !kept.has(coin.id),
      );
    }
    const ids = new Set(top.map((coin) => coin.id));
    const coins = [...top, ...stableCoins.filter((coin) => !ids.has(coin.id))];
    this.use({ version: 1, at, coins, stables, stablesAt });
    this.anchors.record(coins, at);
    await this.file.write({ version: 1, at, coins, stables, stablesAt });
    this.backfill(key);
  }

  private use(stored: Stored): void {
    this.stored = stored;
    this.byId = new Map(stored.coins.map((coin) => [coin.id, coin]));
    this.stables = new Set(stored.stables);
  }

  /**
   * The coins market caps are built from whose year of history hasn't been fetched yet: the
   * eligible ones of the 250 largest and the 100 largest eligible stablecoins, largest first.
   */
  private wantedHistory(): string[] {
    const eligible = this.coins()
      .filter((coin) => this.isEligible(coin.id))
      .sort((a, b) => b.cap - a.cap);
    const wanted = [
      ...eligible.slice(0, HISTORY_COINS),
      ...eligible.filter((coin) => this.stables.has(coin.id)).slice(0, STABLE_COINS),
    ];
    return [...new Set(wanted.map((coin) => coin.id))].filter((id) => !this.anchors.hasHistory(id));
  }

  /**
   * Carries on with history a restart cut short, once a minute at most while in use, rather
   * than at the next refresh up to 15 minutes later.
   */
  private resumeBackfill(): void {
    if (this.closed || this.backfilling || this.refreshing || !this.stored) return;
    if (this.now() - this.backfillCheckedAt < BACKOFF_MS) return;
    this.backfillCheckedAt = this.now();
    if (this.wantedHistory().length === 0) return;
    this.key().then(
      (key) => this.backfill(key),
      () => {}, // no key: nothing to fetch with
    );
  }

  /** Fetches the missing years of history in the background, one call at a time. */
  private backfill(key: CoinGeckoKey): void {
    if (this.backfilling || this.closed) return;
    const ids = this.wantedHistory();
    if (ids.length === 0) return;
    this.backfilling = (async () => {
      let loaded = 0;
      for (const id of ids) {
        if (this.closed || this.usage.level() === 'stop') break;
        try {
          const chart = await this.client.marketChart(key, id, HISTORY_DAYS);
          this.anchors.setHistory(id, chart, this.now());
          loaded++;
          // A round of 20 coins at a time reaches the charts, the largest first.
          if (loaded % 20 === 0) this.notifyHistory();
        } catch (error) {
          this.warn(`Couldn't fetch ${id}'s market cap history (${messageOf(error)})`);
          if (error instanceof CoinGeckoError && error.problem !== 'unreachable') {
            await this.sleep(BACKOFF_MS);
          }
        }
        await this.sleep(HISTORY_PACE_MS);
      }
      if (loaded % 20 !== 0) this.notifyHistory();
    })().finally(() => {
      this.backfilling = null;
    });
  }

  private notifyHistory(): void {
    for (const listener of [...this.historyListeners]) listener();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
