import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';
import { readNumber, writeNumber } from '../lib/storage';
import {
  clampWidth,
  WATCHLIST_DEFAULT_WIDTH,
  WATCHLIST_LIMITS,
  watchlistMaxWidth,
} from './watchlistWidth';

const STORAGE_KEY = 'tn.layout.watchlistWidth';

/**
 * The watchlist width the user chose, squeezed to fit the current window. The preference
 * itself is kept, so the panel returns to it when the window grows again.
 */
export function useWatchlistWidth(workspaceRef: RefObject<HTMLElement | null>) {
  const [preferred, setPreferred] = useState(
    () => readNumber(STORAGE_KEY) ?? WATCHLIST_DEFAULT_WIDTH,
  );
  const [available, setAvailable] = useState<number | null>(null);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [workspaceRef]);

  const max = available === null ? Number.POSITIVE_INFINITY : watchlistMaxWidth(available);

  const commit = useCallback((width: number) => {
    setPreferred(width);
    writeNumber(STORAGE_KEY, width);
  }, []);

  return {
    width: clampWidth(preferred, WATCHLIST_LIMITS.min, max),
    min: WATCHLIST_LIMITS.min,
    max,
    commit,
  };
}
