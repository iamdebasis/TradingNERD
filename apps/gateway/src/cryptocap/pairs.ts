import type { CatalogEntry } from '@tradingnerd/core';

/** Where a coin's price comes from: one exchange's pair against a dollar. */
export interface PricePair {
  /** "BINANCE" */
  exchange: string;
  /** "XRPUSDT" */
  ticker: string;
  /** The dollar it's quoted in; Tether and USDC are turned into US dollars at their own price. */
  quote: PairQuote;
}

export type PairQuote = 'USD' | 'USDT' | 'USDC';

/**
 * Exchanges in the order their pairs are taken: Binance and Bybit serve 1,000 bars a request
 * and every minute, OKX 300, Coinbase 350; Kraken only its last 720 bars, so it comes last.
 */
export const PAIR_EXCHANGES: readonly string[] = ['BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'KRAKEN'];
const QUOTES: readonly PairQuote[] = ['USDT', 'USD', 'USDC'];
/** A pair must trade this much a day (US dollars) to be trusted for a coin's price. */
export const MIN_PAIR_VOLUME_USD = 100_000;

const rankOf = (entry: CatalogEntry) =>
  PAIR_EXCHANGES.indexOf(entry.exchange) * QUOTES.length + QUOTES.indexOf(entry.quote as PairQuote);

/**
 * Picks each coin's price pair from the exchanges' pair lists (the search catalog): the first
 * exchange in PAIR_EXCHANGES with a USDT, USD or USDC pair of the coin's symbol that trades
 * enough. A pair can be set aside when its price turns out to belong to another coin with the
 * same symbol.
 */
export class PairBook {
  private readonly entries: () => readonly CatalogEntry[];
  private indexed: readonly CatalogEntry[] | null = null;
  private bySymbol = new Map<string, CatalogEntry[]>();
  private readonly rejected = new Set<string>();

  constructor(entries: () => readonly CatalogEntry[]) {
    this.entries = entries;
  }

  /** The pair a coin's price comes from, or null when none of our exchanges trades it enough. */
  pairFor(symbol: string): PricePair | null {
    this.index();
    for (const entry of this.bySymbol.get(symbol.toUpperCase()) ?? []) {
      const id = `${entry.exchange}:${entry.ticker}`;
      if (this.rejected.has(id)) continue;
      return { exchange: entry.exchange, ticker: entry.ticker, quote: entry.quote as PairQuote };
    }
    return null;
  }

  /** Whether the exchanges' pair lists are in: until then no coin has a pair. */
  ready(): boolean {
    return this.entries().length > 0;
  }

  /** Stops using a pair whose price doesn't match the coin's (another coin's symbol). */
  reject(pair: PricePair): void {
    this.rejected.add(`${pair.exchange}:${pair.ticker}`);
  }

  private index(): void {
    const entries = this.entries();
    if (entries === this.indexed) return;
    const bySymbol = new Map<string, CatalogEntry[]>();
    for (const entry of entries) {
      if (!entry.live || entry.kind !== 'spot') continue;
      if (!PAIR_EXCHANGES.includes(entry.exchange)) continue;
      if (!QUOTES.includes(entry.quote as PairQuote) || entry.base === entry.quote) continue;
      if (entry.volumeUsd < MIN_PAIR_VOLUME_USD) continue;
      const list = bySymbol.get(entry.base) ?? [];
      list.push(entry);
      bySymbol.set(entry.base, list);
    }
    for (const list of bySymbol.values()) list.sort((a, b) => rankOf(a) - rankOf(b));
    this.bySymbol = bySymbol;
    this.indexed = entries;
  }
}
