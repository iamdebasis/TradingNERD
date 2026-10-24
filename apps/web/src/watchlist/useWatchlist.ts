import type { Watchlist } from '@tradingnerd/core';
import { useMemo } from 'react';
import { type WatchlistsApi, watchlistsApi } from '../data/api';
import { type DocumentApi, useSavedDocument } from '../lib/useSavedDocument';

/** Wait before asking the gateway for the list again after a failure. */
export const WATCHLIST_RETRY_MS = 3_000;

export type WatchlistApi = DocumentApi<Watchlist>;

/** One list's sections, loaded from and saved to that list. */
export function listDocument(api: WatchlistsApi, id: string): WatchlistApi {
  return {
    load: async (signal) => ({ sections: (await api.get(id, signal)).sections }),
    save: async (list) => ({ sections: (await api.save(id, list)).sections }),
  };
}

/**
 * The open watchlist, loaded from the gateway and saved back after every edit
 * (useSavedDocument); null until there is one, and again while another list loads.
 */
export function useWatchlist(listId: string | null, api: WatchlistsApi = watchlistsApi) {
  const document = useMemo(() => (listId ? listDocument(api, listId) : null), [api, listId]);
  const { doc, edit } = useSavedDocument(document, WATCHLIST_RETRY_MS);
  return { list: doc, edit };
}
