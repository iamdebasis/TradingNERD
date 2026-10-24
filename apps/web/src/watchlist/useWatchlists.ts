import type { WatchlistSummary, WatchlistsIndex } from '@tradingnerd/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type NewWatchlist, type WatchlistsApi, watchlistsApi } from '../data/api';
import { WATCHLIST_RETRY_MS } from './useWatchlist';

/**
 * The user's watchlists (TradingView's several lists): the list of lists and which one is open,
 * loaded from the gateway (retried until it answers), and the changes TradingView's list menu
 * makes. Each change is the gateway's to make; the list of lists follows its answer.
 */
export function useWatchlists(api: WatchlistsApi = watchlistsApi) {
  const [index, setIndex] = useState<WatchlistsIndex | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.index(abort.signal).then(setIndex, () => {
        if (!abort.signal.aborted) timer = setTimeout(load, WATCHLIST_RETRY_MS);
      });
    };
    load();
    return () => {
      alive.current = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [api]);

  const accept = useCallback((next: WatchlistsIndex) => {
    if (alive.current) setIndex(next);
    return next;
  }, []);

  /** The list of lists again (the open one's count changes as it's edited). */
  const refresh = useCallback(() => api.index().then(accept), [api, accept]);

  const open = useCallback((id: string) => api.activate(id).then(accept), [api, accept]);

  const create = useCallback(
    async (list: NewWatchlist): Promise<WatchlistSummary> => {
      const created = await api.create(list);
      await refresh();
      return created;
    },
    [api, refresh],
  );

  const update = useCallback(
    async (id: string, change: { name?: string; favorite?: boolean }) => {
      const updated = await api.update(id, change);
      if (alive.current) {
        setIndex((current) =>
          current
            ? {
                ...current,
                lists: current.lists.map((list) => (list.id === id ? updated : list)),
              }
            : current,
        );
      }
      return updated;
    },
    [api],
  );

  const remove = useCallback((id: string) => api.remove(id).then(accept), [api, accept]);

  return { index, refresh, open, create, update, remove };
}

export type WatchlistsControl = ReturnType<typeof useWatchlists>;
