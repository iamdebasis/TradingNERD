import {
  isComplete,
  parseFormula,
  parseSymbolId,
  type SymbolId,
  type SymbolInfo,
} from '@tradingnerd/core';
import { ApiError, type MarketApi } from '../data/api';

export type SymbolLookup =
  | { state: 'ready'; info: SymbolInfo }
  /**
   * The exchange doesn't list it (any more), or a formula holds a symbol we don't have: shown
   * in red, with no prices; `suggestion` is what the gateway offers instead, if anything.
   */
  | { state: 'unavailable'; message: string; suggestion?: SymbolId };

/**
 * Symbol details for the watchlist (price precision, base asset), each looked up once. A symbol
 * the exchange doesn't list stays unavailable; a lookup that merely failed is tried again next
 * time it's asked for.
 */
export class SymbolDirectory {
  private readonly api: Pick<MarketApi, 'resolveSymbol'>;
  private readonly lookups = new Map<SymbolId, Promise<SymbolLookup>>();
  /** The lookups that have come back, for a row's menu to read at once. */
  private readonly settled = new Map<SymbolId, SymbolLookup>();

  constructor(api: Pick<MarketApi, 'resolveSymbol'>) {
    this.api = api;
  }

  /** What's known of `symbol` so far: its lookup once it has come back. */
  known(symbol: SymbolId): SymbolLookup | undefined {
    return this.settled.get(symbol);
  }

  lookup(symbol: SymbolId): Promise<SymbolLookup> {
    const cached = this.lookups.get(symbol);
    if (cached) return cached;
    // A list from TradingView can hold symbols of shapes we don't chart (indices with other
    // characters): unavailable, without asking. Formulas are the gateway's to judge, once each
    // of their symbols has its exchange.
    const formula = parseSymbolId(symbol) ? null : parseFormula(symbol);
    if (!parseSymbolId(symbol) && !(formula && isComplete(formula))) {
      const unavailable: SymbolLookup = {
        state: 'unavailable',
        message: formula
          ? `Each symbol of ${symbol} needs its exchange, like BINANCE:XRPUSDT`
          : `${symbol} isn't available here`,
      };
      this.settled.set(symbol, unavailable);
      this.lookups.set(symbol, Promise.resolve(unavailable));
      return Promise.resolve(unavailable);
    }
    const lookup = this.api.resolveSymbol(symbol).then(
      (info): SymbolLookup => ({ state: 'ready', info }),
      (error: unknown): SymbolLookup => {
        if (error instanceof ApiError && error.code === 'unknown_symbol') {
          return error.suggestion
            ? { state: 'unavailable', message: error.message, suggestion: error.suggestion }
            : { state: 'unavailable', message: error.message };
        }
        this.lookups.delete(symbol); // transient: ask again later
        throw error;
      },
    );
    this.lookups.set(symbol, lookup);
    void lookup.then(
      (known) => this.settled.set(symbol, known),
      () => {},
    );
    return lookup;
  }
}
