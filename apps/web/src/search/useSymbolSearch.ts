import type { ExchangeSummary, SymbolMatch } from '@tradingnerd/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type SearchApi } from '../data/api';

export interface SymbolSearch {
  /** The query these matches answer: until new results arrive, the previous query's. */
  query: string;
  matches: SymbolMatch[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** Fetches the next page, if there is one and none is on its way. */
  loadMore(): void;
}

interface Results {
  query: string;
  exchange: string | null;
  matches: SymbolMatch[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

const describe = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Symbol search failed';

/**
 * Search results for what's typed, from the gateway. Each keystroke cancels the request before
 * it, and the last results stay on screen until new ones arrive, so the list never flashes
 * empty while typing.
 */
export function useSymbolSearch(
  api: SearchApi,
  query: string,
  exchange: string | null,
): SymbolSearch {
  const [results, setResults] = useState<Results>({
    query: '',
    exchange: null,
    matches: [],
    hasMore: false,
    loading: true,
    error: null,
  });
  const nextPage = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    nextPage.current?.abort();
    nextPage.current = null;
    setResults((current) => ({ ...current, loading: true }));
    api.search({ query, exchange, offset: 0 }, abort.signal).then(
      (page) =>
        setResults({
          query,
          exchange,
          matches: page.matches,
          hasMore: page.hasMore,
          loading: false,
          error: null,
        }),
      (error: unknown) => {
        if (!abort.signal.aborted) {
          setResults((current) => ({ ...current, loading: false, error: describe(error) }));
        }
      },
    );
    return () => abort.abort();
  }, [api, query, exchange]);

  const loadMore = useCallback(() => {
    if (nextPage.current || !results.hasMore || results.loading) return;
    const abort = new AbortController();
    nextPage.current = abort;
    const { query: answered, exchange: source, matches } = results;
    api.search({ query: answered, exchange: source, offset: matches.length }, abort.signal).then(
      (page) => {
        if (nextPage.current !== abort) return;
        nextPage.current = null;
        setResults((current) => {
          if (current.query !== answered || current.exchange !== source) return current;
          const seen = new Set(current.matches.map((match) => match.ticker));
          return {
            ...current,
            matches: [...current.matches, ...page.matches.filter((m) => !seen.has(m.ticker))],
            hasMore: page.hasMore,
          };
        });
      },
      () => {
        if (nextPage.current === abort) nextPage.current = null;
      },
    );
  }, [api, results]);

  return {
    query: results.query,
    matches: results.matches,
    hasMore: results.hasMore,
    loading: results.loading,
    error: results.error,
    loadMore,
  };
}

/** The exchanges the catalog covers, for names, logos and the source filter. */
export function useExchanges(api: SearchApi): ExchangeSummary[] {
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    api.exchanges(abort.signal).then(setExchanges, () => {
      // Without the list, rows show exchange codes and the filter lists none.
    });
    return () => abort.abort();
  }, [api]);
  return exchanges;
}
