import type { RefObject } from 'react';
import { usePanelWidth } from './usePanelWidth';
import { WATCHLIST_DEFAULT_WIDTH, WATCHLIST_LIMITS } from './watchlistWidth';

const STORAGE_KEY = 'tn.layout.watchlistWidth';

/**
 * The watchlist width the user chose, squeezed to fit the current window. The preference
 * itself is kept, so the panel returns to it when the window grows again.
 */
export function useWatchlistWidth(workspaceRef: RefObject<HTMLElement | null>) {
  return usePanelWidth(workspaceRef, STORAGE_KEY, WATCHLIST_DEFAULT_WIDTH, WATCHLIST_LIMITS.min);
}
