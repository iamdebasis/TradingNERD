import type { Watchlist } from '@tradingnerd/core';
import { watchlistApi } from '../data/api';
import { type DocumentApi, useSavedDocument } from '../lib/useSavedDocument';

/** Wait before asking the gateway for the list again after a failure. */
export const WATCHLIST_RETRY_MS = 3_000;

export type WatchlistApi = DocumentApi<Watchlist>;

/** The watchlist, loaded from the gateway and saved back after every edit (useSavedDocument). */
export function useWatchlist(api: WatchlistApi = watchlistApi) {
  const { doc, edit } = useSavedDocument(api, WATCHLIST_RETRY_MS);
  return { list: doc, edit };
}
