import type { SymbolId } from './market.ts';

/** One exchange's listing of a pair. */
export interface SymbolListing {
  /** "KRAKEN:XBTUSD" */
  id: SymbolId;
  /** "KRAKEN" */
  exchange: string;
  /** Whether the gateway has live data from this exchange yet; the others are listed only. */
  live: boolean;
}

/** One search result: a pair, with every exchange that lists it under that ticker. */
export interface SymbolMatch {
  /** "XRPUSDT" */
  ticker: string;
  /** Asset codes, the same on every exchange ("XBT" is "BTC"), for logos. */
  base: string;
  quote: string;
  /** "XRP / TetherUS" */
  description: string;
  type: 'spot';
  /** The listing a click picks first: exchanges with live data, then the most traded. */
  listings: SymbolListing[];
}

/** Body of GET /api/symbols/search. */
export interface SymbolSearchResponse {
  matches: SymbolMatch[];
  /** More matches follow this page. */
  hasMore: boolean;
}

/** An exchange the symbol catalog covers. */
export interface ExchangeSummary {
  /** "BINANCE" */
  id: string;
  /** "Binance" */
  name: string;
  /** Whether the gateway has live data from it yet. */
  live: boolean;
}

/** Body of GET /api/exchanges. */
export interface ExchangeList {
  exchanges: ExchangeSummary[];
}

/** One listing as the gateway searches it. */
export interface CatalogEntry {
  exchange: string;
  ticker: string;
  base: string;
  quote: string;
  description: string;
  /** 24 h traded value in US dollars, for ranking; 0 when unknown. */
  volumeUsd: number;
  live: boolean;
}

export interface SearchOptions {
  /** What was typed: "XRP", "xrp/usdt" or "BINANCE:XRP". */
  query: string;
  /** Only this exchange's listings. */
  exchange?: string | null;
  offset?: number;
  limit?: number;
}

/** Matches per page of search results. */
export const SEARCH_PAGE_SIZE = 50;
/** Longest query the gateway accepts. */
export const MAX_QUERY_LENGTH = 64;

// How well a listing matches, best first (docs/SPEC.md §5.4).
const EXACT = 0;
const PREFIX = 1;
const BASE = 2;
const DESCRIPTION = 3;
const CONTAINS = 4;

/** Upper case without the separators people type between assets: "xrp/usdt" → "XRPUSDT". */
export function compactQuery(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The words of a query or description, upper case: "Lido DAO / TetherUS" → LIDO, DAO, TETHERUS. */
function wordsOf(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word !== '');
}

/** "BINANCE:XRP" → BINANCE and "XRP", when the part before the colon is a known exchange. */
export function splitExchangePrefix(
  query: string,
  exchanges: ReadonlySet<string>,
): { exchange: string | null; text: string } {
  const colon = query.indexOf(':');
  if (colon > 0) {
    const prefix = query.slice(0, colon).trim().toUpperCase();
    if (exchanges.has(prefix)) return { exchange: prefix, text: query.slice(colon + 1) };
  }
  return { exchange: null, text: query };
}

function tierOf(entry: CatalogEntry, compact: string, words: readonly string[]): number | null {
  if (compact === '') return EXACT; // nothing typed: everything, most traded first
  if (entry.ticker === compact) return EXACT;
  if (entry.ticker.startsWith(compact)) return PREFIX;
  if (entry.base === compact) return BASE;
  const description = wordsOf(entry.description);
  if (words.every((word) => description.some((part) => part.startsWith(word)))) {
    return DESCRIPTION;
  }
  if (entry.ticker.includes(compact)) return CONTAINS;
  return null;
}

/** Live exchanges first, then the most traded. */
function compareListings(a: CatalogEntry, b: CatalogEntry): number {
  if (a.live !== b.live) return a.live ? -1 : 1;
  return b.volumeUsd - a.volumeUsd || a.exchange.localeCompare(b.exchange);
}

/**
 * Searches the catalog the way docs/SPEC.md §5.4 ranks it: exact ticker, then ticker prefix,
 * then base asset, then description, then anywhere in the ticker; ties go to the most traded.
 * Listings sharing a ticker become one match, so a pair is one row however many exchanges
 * list it.
 */
export function searchCatalog(
  entries: readonly CatalogEntry[],
  options: SearchOptions,
): SymbolSearchResponse {
  const exchanges = new Set(entries.map((entry) => entry.exchange));
  const split = splitExchangePrefix(options.query, exchanges);
  const exchange = options.exchange ?? split.exchange;
  const compact = compactQuery(split.text);
  const words = wordsOf(split.text);

  const groups = new Map<string, { tier: number; volume: number; entries: CatalogEntry[] }>();
  for (const entry of entries) {
    if (exchange && entry.exchange !== exchange) continue;
    const tier = tierOf(entry, compact, words);
    if (tier === null) continue;
    const group = groups.get(entry.ticker);
    if (group) {
      group.tier = Math.min(group.tier, tier);
      group.volume += entry.volumeUsd;
      group.entries.push(entry);
    } else {
      groups.set(entry.ticker, { tier, volume: entry.volumeUsd, entries: [entry] });
    }
  }

  const ranked = [...groups.entries()].sort(
    ([tickerA, a], [tickerB, b]) =>
      a.tier - b.tier ||
      b.volume - a.volume ||
      tickerA.length - tickerB.length ||
      tickerA.localeCompare(tickerB),
  );
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? SEARCH_PAGE_SIZE);
  const page = ranked.slice(offset, offset + limit);
  return {
    matches: page.map(([ticker, group]) => {
      const listings = [...group.entries].sort(compareListings);
      const first = listings[0] as CatalogEntry;
      return {
        ticker,
        base: first.base,
        quote: first.quote,
        description: first.description,
        type: 'spot',
        listings: listings.map((entry) => ({
          id: `${entry.exchange}:${entry.ticker}`,
          exchange: entry.exchange,
          live: entry.live,
        })),
      };
    }),
    hasMore: offset + limit < ranked.length,
  };
}

/** [start, end) character ranges, for highlighting what matched. */
export type MatchRange = readonly [number, number];

/** Where a typed query shows in a ticker: the prefix, or wherever it appears. */
export function tickerMatch(ticker: string, query: string): MatchRange[] {
  const compact = compactQuery(splitExchangeColon(query));
  if (compact === '') return [];
  const at = ticker.toUpperCase().indexOf(compact);
  return at < 0 ? [] : [[at, at + compact.length]];
}

/** Where a typed query's words start words of a description ("XRP" in "XRP / TetherUS"). */
export function descriptionMatches(description: string, query: string): MatchRange[] {
  const words = wordsOf(splitExchangeColon(query));
  if (words.length === 0) return [];
  const ranges: MatchRange[] = [];
  const pattern = /[A-Za-z0-9]+/g;
  for (let found = pattern.exec(description); found; found = pattern.exec(description)) {
    const part = found[0].toUpperCase();
    const longest = Math.max(
      0,
      ...words.filter((word) => part.startsWith(word)).map((w) => w.length),
    );
    if (longest > 0) ranges.push([found.index, found.index + longest]);
  }
  return ranges;
}

/** The query without an "EXCHANGE:" prefix, for highlighting. */
function splitExchangeColon(query: string): string {
  const colon = query.indexOf(':');
  return colon >= 0 ? query.slice(colon + 1) : query;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseListing(value: unknown): SymbolListing | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, exchange, live } = value as Record<string, unknown>;
  return isString(id) && isString(exchange) && typeof live === 'boolean'
    ? { id, exchange, live }
    : null;
}

function parseMatch(value: unknown): SymbolMatch | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isString(v.ticker) || !isString(v.base) || !isString(v.quote)) return null;
  if (typeof v.description !== 'string' || v.type !== 'spot') return null;
  if (!Array.isArray(v.listings) || v.listings.length === 0) return null;
  const listings = v.listings.map(parseListing);
  if (listings.some((listing) => listing === null)) return null;
  return {
    ticker: v.ticker,
    base: v.base,
    quote: v.quote,
    description: v.description,
    type: 'spot',
    listings: listings as SymbolListing[],
  };
}

/** Validates GET /api/symbols/search output. */
export function parseSymbolSearchResponse(value: unknown): SymbolSearchResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const { matches, hasMore } = value as Record<string, unknown>;
  if (!Array.isArray(matches) || typeof hasMore !== 'boolean') return null;
  const parsed = matches.map(parseMatch);
  if (parsed.some((match) => match === null)) return null;
  return { matches: parsed as SymbolMatch[], hasMore };
}

/** Validates GET /api/exchanges output. */
export function parseExchangeList(value: unknown): ExchangeList | null {
  if (typeof value !== 'object' || value === null) return null;
  const { exchanges } = value as Record<string, unknown>;
  if (!Array.isArray(exchanges)) return null;
  const parsed: ExchangeSummary[] = [];
  for (const item of exchanges) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, name, live } = item as Record<string, unknown>;
    if (!isString(id) || !isString(name) || typeof live !== 'boolean') return null;
    parsed.push({ id, name, live });
  }
  return { exchanges: parsed };
}
