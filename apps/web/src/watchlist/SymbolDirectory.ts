import { parseSymbolId, type SymbolId, type SymbolInfo } from '@tradingnerd/core';
import { ApiError, type MarketApi } from '../data/api';

export type SymbolLookup =
  | { state: 'ready'; info: SymbolInfo }
  /** The exchange doesn't list it (any more): shown in red, with no prices. */
  | { state: 'unavailable'; message: string };

/**
 * Symbol details for the watchlist (price precision, base asset), each looked up once. A symbol
 * the exchange doesn't list stays unavailable; a lookup that merely failed is tried again next
 * time it's asked for.
 */
export class SymbolDirectory {
  private readonly api: Pick<MarketApi, 'resolveSymbol'>;
  private readonly lookups = new Map<SymbolId, Promise<SymbolLookup>>();

  constructor(api: Pick<MarketApi, 'resolveSymbol'>) {
    this.api = api;
  }

  lookup(symbol: SymbolId): Promise<SymbolLookup> {
    const cached = this.lookups.get(symbol);
    if (cached) return cached;
    // A list from TradingView can hold symbols of shapes we don't chart (spreads, indices with
    // other characters): unavailable, without asking.
    if (!parseSymbolId(symbol)) {
      const unavailable: SymbolLookup = {
        state: 'unavailable',
        message: `${symbol} isn't available here`,
      };
      this.lookups.set(symbol, Promise.resolve(unavailable));
      return Promise.resolve(unavailable);
    }
    const lookup = this.api.resolveSymbol(symbol).then(
      (info): SymbolLookup => ({ state: 'ready', info }),
      (error: unknown): SymbolLookup => {
        if (error instanceof ApiError && error.code === 'unknown_symbol') {
          return { state: 'unavailable', message: error.message };
        }
        this.lookups.delete(symbol); // transient: ask again later
        throw error;
      },
    );
    this.lookups.set(symbol, lookup);
    return lookup;
  }
}
