import {
  type Formula,
  MAX_FORMULA_LENGTH,
  parseSymbolId,
  replaceSymbols,
  type SymbolId,
} from '@tradingnerd/core';
import { useEffect, useState } from 'react';
import type { SearchApi } from '../data/api';

/** A formula typed in the search: its symbols' exchanges being found, all found, or not. */
export type TypedFormula =
  | { state: 'finding'; formula: Formula }
  | { state: 'ready'; formula: Formula }
  | { state: 'missing'; formula: Formula; message: string };

/**
 * The exchange of each symbol typed without one, as the search finds it: the first match with
 * that very ticker, else the first match, on its first listing (the one a click picks). Each
 * ticker is looked up once; a search that failed is tried again.
 */
export class SymbolFinder {
  private readonly api: Pick<SearchApi, 'search'>;
  private readonly found = new Map<string, Promise<SymbolId | null>>();

  constructor(api: Pick<SearchApi, 'search'>) {
    this.api = api;
  }

  find(ticker: string): Promise<SymbolId | null> {
    const cached = this.found.get(ticker);
    if (cached) return cached;
    const lookup = this.api
      .search({ query: ticker, exchange: null, category: null, offset: 0 })
      .then(
        (page) => {
          const match = page.matches.find((item) => item.ticker === ticker) ?? page.matches[0];
          const listing = match?.listings[0];
          return listing?.live ? listing.id : null;
        },
        (error: unknown) => {
          this.found.delete(ticker);
          throw error;
        },
      );
    this.found.set(ticker, lookup);
    return lookup;
  }

  /** `typed` with every symbol's exchange, or why it can't have them. */
  async complete(typed: Formula): Promise<TypedFormula> {
    const bare = typed.symbols.filter((symbol) => !parseSymbolId(symbol));
    let ids: (SymbolId | null)[];
    try {
      ids = await Promise.all(bare.map((ticker) => this.find(ticker)));
    } catch {
      return { state: 'missing', formula: typed, message: 'Symbol search failed' };
    }
    const missing = bare.filter((_, i) => ids[i] === null);
    if (missing.length > 0) {
      return { state: 'missing', formula: typed, message: `No symbol ${missing.join(', ')} here` };
    }
    const found = new Map(bare.map((ticker, i) => [ticker, ids[i] as SymbolId]));
    const formula = replaceSymbols(typed, (symbol) => found.get(symbol) ?? symbol);
    if (formula.text.length > MAX_FORMULA_LENGTH) {
      return {
        state: 'missing',
        formula,
        message: `A formula is at most ${MAX_FORMULA_LENGTH} characters`,
      };
    }
    return { state: 'ready', formula };
  }
}

/**
 * The formula typed, as SymbolFinder completes it (null when none is typed), and the finder, for
 * Enter to complete the formula as it's typed now. Like the search's results, the last answer
 * stays until the next arrives.
 */
export function useTypedFormula(
  api: Pick<SearchApi, 'search'>,
  typed: Formula | null,
): { formula: TypedFormula | null; finder: SymbolFinder } {
  const [finder] = useState(() => new SymbolFinder(api));
  const [result, setResult] = useState<TypedFormula | null>(null);
  const text = typed?.text ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the formula's text is what counts
  useEffect(() => {
    if (!typed) {
      setResult(null);
      return;
    }
    let current = true;
    setResult((last) => last ?? { state: 'finding', formula: typed });
    void finder.complete(typed).then((next) => {
      if (current) setResult(next);
    });
    return () => {
      current = false;
    };
  }, [finder, text]);

  return { formula: typed ? result : null, finder };
}
