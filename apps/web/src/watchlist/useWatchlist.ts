import type { Watchlist } from '@tradingnerd/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { watchlistApi } from '../data/api';

/** Wait before asking the gateway for the list again after a failure. */
export const WATCHLIST_RETRY_MS = 3_000;

export interface WatchlistApi {
  load(signal?: AbortSignal): Promise<Watchlist>;
  save(list: Watchlist): Promise<Watchlist>;
}

/**
 * The watchlist, loaded from the gateway and saved back after every edit, one save at a time,
 * the latest winning. Nothing is saved before the list has loaded, so a gateway that is briefly
 * unreachable can never overwrite the stored list with an empty or default one.
 */
export function useWatchlist(api: WatchlistApi = watchlistApi) {
  const [list, setList] = useState<Watchlist | null>(null);
  const current = useRef<Watchlist | null>(null);
  const pending = useRef<Watchlist | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.load(abort.signal).then(
        (loaded) => {
          current.current = loaded;
          setList(loaded);
        },
        () => {
          if (!abort.signal.aborted) timer = setTimeout(load, WATCHLIST_RETRY_MS);
        },
      );
    };
    load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api]);

  const flush = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        // On failure the list stays as edited here; the next edit saves it all again.
        await api.save(next).catch(() => {});
      }
    } finally {
      saving.current = false;
    }
  }, [api]);

  const edit = useCallback(
    (change: (list: Watchlist) => Watchlist) => {
      const before = current.current;
      if (!before) return;
      const next = change(before);
      if (next === before) return;
      current.current = next;
      setList(next);
      pending.current = next;
      void flush();
    },
    [flush],
  );

  return { list, edit };
}
