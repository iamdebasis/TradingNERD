import { join } from 'node:path';
import {
  type CatalogEntry,
  type ExchangeSummary,
  isSymbolKind,
  type SymbolKind,
} from '@tradingnerd/core';
import { JsonFile } from '../storage/jsonFile.ts';
import { parseNasdaqListed, parseOtherListed, US_EXCHANGES, type UsListing } from './listings.ts';

/** Nasdaq's directory files, refreshed through each trading day. */
export const DIRECTORY_URLS = {
  nasdaq: 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
  other: 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
};
/** How often the directory is fetched again. */
export const LISTINGS_REFRESH_MS = 24 * 3_600_000;
/** How soon a failed fetch is tried again. */
export const LISTINGS_RETRY_MS = 10 * 60_000;

/** A listing on disk: exchange, venue, ticker, root, data symbol ("" if none), name, kind. */
type StoredListing = [string, string, string, string, string, string, SymbolKind];

interface StoredListings {
  version: 1;
  fetchedAt: number;
  listings: StoredListing[];
  /** The last session's traded value per ticker, in dollars, for ranking. */
  volumes: Record<string, number>;
  /** The last session's close per ticker, for the price precision. */
  prices: Record<string, number>;
  /** The symbols Alpaca has data for; null until checked with a key. */
  available: string[] | null;
}

function parseStored(value: unknown): StoredListings | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.fetchedAt !== 'number' || !Array.isArray(v.listings)) {
    return null;
  }
  const listings: StoredListing[] = [];
  for (const item of v.listings) {
    if (!Array.isArray(item) || item.length !== 7) return null;
    if (!item.slice(0, 6).every((part) => typeof part === 'string') || !isSymbolKind(item[6])) {
      return null;
    }
    listings.push(item as StoredListing);
  }
  if (typeof v.volumes !== 'object' || v.volumes === null || Array.isArray(v.volumes)) return null;
  const numbers = (value: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (typeof value !== 'object' || value === null) return out;
    for (const [ticker, number] of Object.entries(value)) {
      if (typeof number === 'number' && Number.isFinite(number)) out[ticker] = number;
    }
    return out;
  };
  const available =
    Array.isArray(v.available) && v.available.every((s) => typeof s === 'string')
      ? (v.available as string[])
      : null;
  return {
    version: 1,
    fetchedAt: v.fetchedAt,
    listings,
    volumes: numbers(v.volumes),
    prices: numbers(v.prices),
    available,
  };
}

/**
 * The symbols Alpaca may know a preferred, warrant, unit or right by: the directory's own
 * forms differ from every vendor's, so the asset list decides which one is real.
 */
export function dataSymbolCandidates(listing: UsListing): string[] {
  const { root, ticker, kind } = listing;
  const suffix = ticker.slice(ticker.indexOf('/') + 1);
  switch (kind) {
    case 'preferred': {
      const series = suffix.replace(/^P/, '');
      return [
        `${root}.PR${series}`,
        `${root}p${series}`,
        `${root}-${series}`,
        `${root}.P${series}`,
      ];
    }
    case 'warrant':
      return [`${root}.WS`, `${root}.W`, `${root}WS`, `${root}W`];
    case 'unit':
      return [`${root}.U`, `${root}.UN`, `${root}U`];
    case 'right':
      return [`${root}.RT`, `${root}.R`, `${root}R`];
    default:
      return [];
  }
}

export interface UsListingsOptions {
  dataDir: string;
  fetch?: typeof fetch;
  urls?: { nasdaq: string; other: string };
  refreshMs?: number;
  retryMs?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/**
 * Every US-listed stock and fund, for the symbol search and symbol lookups: Nasdaq's
 * directory, kept in data/us-listings.json so search works straight after a restart (offline
 * too) and fetched again daily, with each listing's last session's traded value for ranking
 * and, once a key is set, whether Alpaca has data for it.
 */
export class UsListings {
  private readonly file: JsonFile<StoredListings>;
  private readonly fetchFn: typeof fetch;
  private readonly urls: { nasdaq: string; other: string };
  private readonly refreshMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private listings: UsListing[] = [];
  private byId = new Map<string, UsListing>();
  private fetchedAt = 0;
  private volumes: Record<string, number> = {};
  private prices: Record<string, number> = {};
  private available: ReadonlySet<string> | null = null;
  private cachedEntries: readonly CatalogEntry[] | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started: Promise<void> | null = null;
  private closed = false;
  private markFilled: () => void = () => {};
  private readonly filled = new Promise<void>((resolve) => {
    this.markFilled = resolve;
  });

  constructor(options: UsListingsOptions) {
    this.file = new JsonFile(join(options.dataDir, 'us-listings.json'), parseStored, { indent: 0 });
    this.fetchFn = options.fetch ?? fetch;
    this.urls = options.urls ?? DIRECTORY_URLS;
    this.refreshMs = options.refreshMs ?? LISTINGS_REFRESH_MS;
    this.retryMs = options.retryMs ?? LISTINGS_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Loads the saved listings, then keeps them fresh in the background. */
  start(): Promise<void> {
    this.started ??= this.load().then(() => {
      const wait = this.fetchedAt + this.refreshMs - this.now();
      if (this.listings.length === 0 || wait <= 0) void this.refresh();
      else this.schedule(wait);
    });
    return this.started;
  }

  /** Resolves once there are listings to search, or after `timeoutMs`. */
  async ready(timeoutMs: number): Promise<void> {
    await this.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([this.filled, timeout]);
    clearTimeout(timer);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  /** The listing behind "NASDAQ:AAPL", if there is one. */
  get(exchange: string, ticker: string): UsListing | undefined {
    return this.byId.get(`${exchange}:${ticker}`);
  }

  all(): readonly UsListing[] {
    return this.listings;
  }

  /** The search catalog's view: the most traded first among equal matches. */
  entries(): readonly CatalogEntry[] {
    this.cachedEntries ??= this.listings.map((listing) => {
      const entry: CatalogEntry = {
        exchange: listing.exchange,
        ticker: listing.ticker,
        base: listing.root,
        quote: 'USD',
        description: listing.name,
        volumeUsd: this.volumes[listing.ticker] ?? 0,
        live: this.hasData(listing),
        kind: listing.kind,
        exchangeName: listing.venue,
      };
      return entry;
    });
    return this.cachedEntries;
  }

  exchanges(): ExchangeSummary[] {
    const used = new Set(this.listings.map((listing) => listing.exchange));
    return US_EXCHANGES.filter((exchange) => used.has(exchange.id)).map((exchange) => ({
      ...exchange,
      live: true,
      market: 'stocks' as const,
    }));
  }

  /** Whether Alpaca serves the listing's data, as far as is known. */
  hasData(listing: UsListing): boolean {
    if (!listing.dataSymbol) return false;
    return this.available === null || this.available.has(listing.dataSymbol);
  }

  /** The last session's close, if known. */
  price(ticker: string): number | null {
    return this.prices[ticker] ?? null;
  }

  /** Each listing's last session's traded value (dollars) and close, by ticker. */
  async setVolumes(
    volumes: Readonly<Record<string, number>>,
    prices: Readonly<Record<string, number>> = {},
  ): Promise<void> {
    this.volumes = { ...volumes };
    this.prices = { ...this.prices, ...prices };
    this.cachedEntries = null;
    await this.save();
  }

  /**
   * Alpaca's symbol list: it decides which listings have data, and how preferreds, warrants,
   * units and rights are known there.
   */
  async setAvailable(symbols: Iterable<string>): Promise<void> {
    this.available = new Set(symbols);
    this.applyAvailable();
    await this.save();
  }

  private applyAvailable(): void {
    const available = this.available;
    if (!available) return;
    for (const listing of this.listings) {
      if (listing.dataSymbol && available.has(listing.dataSymbol)) continue;
      const found = dataSymbolCandidates(listing).find((symbol) => available.has(symbol));
      if (found) listing.dataSymbol = found;
    }
    this.cachedEntries = null;
  }

  private async refresh(): Promise<void> {
    let listings: UsListing[];
    try {
      const [nasdaq, other] = await Promise.all([
        this.download(this.urls.nasdaq),
        this.download(this.urls.other),
      ]);
      listings = [
        ...parseNasdaqListed(nasdaq),
        ...parseOtherListed(other, (code) =>
          this.warn(
            `US listings: exchange code "${code}" isn't known yet; its listings are left out`,
          ),
        ),
      ];
    } catch (error) {
      if (this.closed) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.warn(
        `Couldn't fetch the US listings; trying again in ${Math.round(this.retryMs / 60_000)} min (${detail})`,
      );
      this.schedule(this.retryMs);
      return;
    }
    if (this.closed) return;
    this.use(listings, this.now());
    this.applyAvailable();
    this.schedule(this.refreshMs);
    await this.save();
  }

  private async download(url: string): Promise<string> {
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return response.text();
  }

  private use(listings: UsListing[], fetchedAt: number): void {
    this.listings = listings;
    this.byId = new Map(
      listings.map((listing) => [`${listing.exchange}:${listing.ticker}`, listing]),
    );
    this.fetchedAt = fetchedAt;
    this.cachedEntries = null;
    if (listings.length > 0) this.markFilled();
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delayMs);
    this.timer.unref?.();
  }

  private async load(): Promise<void> {
    let stored: StoredListings | null = null;
    try {
      stored = await this.file.read();
    } catch (error) {
      this.warn(`Couldn't read the saved US listings (${String(error)})`);
    }
    if (!stored) return;
    this.volumes = stored.volumes;
    this.prices = stored.prices;
    this.available = stored.available ? new Set(stored.available) : null;
    this.use(
      stored.listings.map(([exchange, venue, ticker, root, dataSymbol, name, kind]) => ({
        exchange,
        venue,
        ticker,
        root,
        dataSymbol: dataSymbol || null,
        name,
        kind,
      })),
      stored.fetchedAt,
    );
  }

  private async save(): Promise<void> {
    try {
      await this.file.write({
        version: 1,
        fetchedAt: this.fetchedAt,
        listings: this.listings.map((l) => [
          l.exchange,
          l.venue,
          l.ticker,
          l.root,
          l.dataSymbol ?? '',
          l.name,
          l.kind,
        ]),
        volumes: this.volumes,
        prices: this.prices,
        available: this.available ? [...this.available] : null,
      });
    } catch (error) {
      this.warn(`Couldn't save the US listings (${String(error)})`);
    }
  }
}
