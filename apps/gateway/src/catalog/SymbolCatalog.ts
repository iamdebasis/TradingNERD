import { join } from 'node:path';
import {
  type CatalogEntry,
  type ExchangeSummary,
  type SearchOptions,
  type SymbolSearchResponse,
  searchCatalog,
} from '@tradingnerd/core';
import { JsonFile } from '../storage/jsonFile.ts';
import { buildEntries, mergeNames } from './entries.ts';
import type { AssetNames } from './names.ts';
import type { CatalogPair, CatalogSnapshot, CatalogSource } from './types.ts';

/** How often each exchange's pair list is fetched again. */
export const CATALOG_REFRESH_MS = 12 * 3_600_000;
/** How soon a failed fetch is tried again. */
export const CATALOG_RETRY_MS = 5 * 60_000;

/** A pair on disk: ticker, base, quote, 24 h quote volume, last price. */
type StoredPair = [string, string, string, number, number];

interface StoredList {
  fetchedAt: number;
  pairs: StoredPair[];
  names: Record<string, string>;
}

interface StoredCatalog {
  version: 1;
  exchanges: Record<string, StoredList>;
}

const isStringMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === 'string');

const isStoredPair = (value: unknown): value is StoredPair =>
  Array.isArray(value) &&
  value.length === 5 &&
  typeof value[0] === 'string' &&
  typeof value[1] === 'string' &&
  typeof value[2] === 'string' &&
  typeof value[3] === 'number' &&
  typeof value[4] === 'number';

function parseStored(value: unknown): StoredCatalog | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, exchanges } = value as Record<string, unknown>;
  if (version !== 1 || typeof exchanges !== 'object' || exchanges === null) return null;
  const parsed: Record<string, StoredList> = {};
  for (const [id, list] of Object.entries(exchanges)) {
    if (typeof list !== 'object' || list === null) return null;
    const { fetchedAt, pairs, names } = list as Record<string, unknown>;
    if (typeof fetchedAt !== 'number' || !Array.isArray(pairs) || !isStringMap(names)) return null;
    if (!pairs.every(isStoredPair)) return null;
    parsed[id] = { fetchedAt, pairs, names };
  }
  return { version: 1, exchanges: parsed };
}

const toPair = ([ticker, base, quote, quoteVolume, last]: StoredPair): CatalogPair => ({
  ticker,
  base,
  quote,
  quoteVolume,
  last,
});

/** Listings from elsewhere that search alongside the pairs (US stocks and funds). */
export interface ExtraListings {
  entries(): readonly CatalogEntry[];
  exchanges(): ExchangeSummary[];
  /** Resolves once there's something to search, or after `timeoutMs`. */
  ready(timeoutMs: number): Promise<void>;
}

export interface SymbolCatalogOptions {
  sources: readonly CatalogSource[];
  /** US stocks and funds, searched with the pairs. */
  extra?: ExtraListings;
  /** Exchanges the gateway has live data from; the others are listed only. */
  live: ReadonlySet<string>;
  dataDir: string;
  /** Filled with every exchange's asset names, for symbol lookups. */
  names?: AssetNames;
  refreshMs?: number;
  retryMs?: number;
  now?: () => number;
  onWarning?: (message: string) => void;
}

/**
 * Every spot pair on the supported exchanges, for the symbol search. Each exchange's list
 * comes from its public API, is kept in data/catalog.json so search works straight after a
 * restart (offline too), and is fetched again twice a day. A failed fetch keeps the last list
 * and is tried again a few minutes later.
 */
export class SymbolCatalog {
  private readonly sources: readonly CatalogSource[];
  private readonly extra: ExtraListings | undefined;
  /** The pairs and the extra listings together, rebuilt when either changes. */
  private combined: {
    pairs: readonly CatalogEntry[];
    extra: readonly CatalogEntry[];
    all: readonly CatalogEntry[];
  } | null = null;
  private readonly live: ReadonlySet<string>;
  private readonly names: AssetNames | undefined;
  private readonly file: JsonFile<StoredCatalog>;
  private readonly refreshMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly lists = new Map<string, { fetchedAt: number; snapshot: CatalogSnapshot }>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private entries: readonly CatalogEntry[] = [];
  private started: Promise<void> | null = null;
  private firstRound: Promise<void> = Promise.resolve();
  private markFilled: () => void = () => {};
  private readonly filled = new Promise<void>((resolve) => {
    this.markFilled = resolve;
  });
  private closed = false;

  constructor(options: SymbolCatalogOptions) {
    this.sources = options.sources;
    this.extra = options.extra;
    this.live = options.live;
    this.names = options.names;
    this.file = new JsonFile(join(options.dataDir, 'catalog.json'), parseStored, { indent: 0 });
    this.refreshMs = options.refreshMs ?? CATALOG_REFRESH_MS;
    this.retryMs = options.retryMs ?? CATALOG_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Loads the saved lists, then keeps every exchange's fresh in the background. */
  start(): Promise<void> {
    this.started ??= this.load().then(() => {
      const due = this.sources.map((source) => {
        const list = this.lists.get(source.id);
        const wait = list ? list.fetchedAt + this.refreshMs - this.now() : 0;
        if (wait <= 0) return this.refresh(source);
        this.schedule(source, wait);
        return Promise.resolve();
      });
      this.firstRound = Promise.all(due).then(() => {});
    });
    return this.started;
  }

  /**
   * Resolves once there is something to search, every exchange has been asked once, or
   * `timeoutMs` has passed, whichever comes first.
   */
  async ready(timeoutMs: number): Promise<void> {
    await this.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.all([
      Promise.race([this.filled, this.firstRound, timeout]),
      this.extra?.ready(timeoutMs),
    ]);
    clearTimeout(timer);
  }

  search(options: SearchOptions): SymbolSearchResponse {
    return searchCatalog(this.allEntries(), options);
  }

  exchanges(): ExchangeSummary[] {
    return [
      ...this.sources.map((source) => ({
        id: source.id,
        name: source.name,
        live: this.live.has(source.id),
        market: 'crypto' as const,
      })),
      ...(this.extra?.exchanges() ?? []),
    ];
  }

  private allEntries(): readonly CatalogEntry[] {
    if (!this.extra) return this.entries;
    const extra = this.extra.entries();
    const combined = this.combined;
    if (combined && combined.pairs === this.entries && combined.extra === extra)
      return combined.all;
    const all = [...this.entries, ...extra];
    this.combined = { pairs: this.entries, extra, all };
    return all;
  }

  /** When each exchange's list was last fetched (epoch ms), for diagnostics and tests. */
  fetchedAt(exchange: string): number | null {
    return this.lists.get(exchange)?.fetchedAt ?? null;
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private async refresh(source: CatalogSource): Promise<void> {
    let snapshot: CatalogSnapshot;
    try {
      snapshot = await source.fetchCatalog();
    } catch (error) {
      if (this.closed) return;
      const detail = error instanceof Error ? error.message : String(error);
      const minutes = Math.round(this.retryMs / 60_000);
      this.warn(
        `Couldn't fetch ${source.name}'s pairs; trying again in ${minutes} min (${detail})`,
      );
      this.schedule(source, this.retryMs);
      return;
    }
    if (this.closed) return;
    this.lists.set(source.id, { fetchedAt: this.now(), snapshot });
    this.rebuild();
    this.schedule(source, this.refreshMs);
    await this.save().catch((error: unknown) => {
      this.warn(`Couldn't save the symbol catalog (${String(error)})`);
    });
  }

  private schedule(source: CatalogSource, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.refresh(source);
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private rebuild(): void {
    const lists = this.sources.flatMap((source) => {
      const list = this.lists.get(source.id);
      return list ? [{ id: source.id, snapshot: list.snapshot }] : [];
    });
    const names = mergeNames(lists.map(({ snapshot }) => snapshot.names));
    this.names?.update(names);
    this.entries = buildEntries(lists, this.live, names);
    if (this.entries.length > 0) this.markFilled();
  }

  private async load(): Promise<void> {
    let stored: StoredCatalog | null = null;
    try {
      stored = await this.file.read();
    } catch (error) {
      this.warn(`Couldn't read the saved symbol catalog (${String(error)})`);
    }
    if (!stored) return;
    for (const source of this.sources) {
      const saved = stored.exchanges[source.id];
      if (!saved) continue;
      this.lists.set(source.id, {
        fetchedAt: saved.fetchedAt,
        snapshot: { pairs: saved.pairs.map(toPair), names: saved.names },
      });
    }
    this.rebuild();
  }

  private save(): Promise<void> {
    const exchanges: Record<string, StoredList> = {};
    for (const [id, { fetchedAt, snapshot }] of this.lists) {
      exchanges[id] = {
        fetchedAt,
        pairs: snapshot.pairs.map((pair) => [
          pair.ticker,
          pair.base,
          pair.quote,
          Number(pair.quoteVolume.toPrecision(6)),
          pair.last,
        ]),
        names: snapshot.names,
      };
    }
    return this.file.write({ version: 1, exchanges });
  }
}
