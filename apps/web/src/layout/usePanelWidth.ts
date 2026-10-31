import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';
import { readNumber, writeNumber } from '../lib/storage';
import { clampWidth, panelMaxWidth } from './watchlistWidth';

/**
 * A right-hand panel's width as the user chose it, kept under `key` and squeezed to fit the
 * window now; the choice itself is kept, so the panel returns to it when the window grows.
 */
export function usePanelWidth(
  workspaceRef: RefObject<HTMLElement | null>,
  key: string,
  defaultWidth: number,
  min: number,
) {
  const [preferred, setPreferred] = useState(() => readNumber(key) ?? defaultWidth);
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

  const max = available === null ? Number.POSITIVE_INFINITY : panelMaxWidth(available, min);

  const commit = useCallback(
    (width: number) => {
      setPreferred(width);
      writeNumber(key, width);
    },
    [key],
  );

  return { width: clampWidth(preferred, min, max), min, max, commit };
}
