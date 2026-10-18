import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { ChartPane } from '../chart/ChartPane';
import { IntervalPrompt, promptKey } from '../chart/IntervalPrompt';
import { type ChartRoute, withInterval } from '../chart/route';
import { useGatewayStatus } from '../data/GatewayContext';
import { isEditable } from '../lib/dom';
import { writeJson } from '../lib/storage';
import { Toolbar } from '../toolbar/Toolbar';
import styles from './AppShell.module.css';
import { Splitter } from './Splitter';
import { useWatchlistWidth } from './useWatchlistWidth';

/** Where the last interval is remembered, for a page opened without one in its URL. */
export const LAST_INTERVAL_KEY = 'tn.chart.interval';

export function AppShell({ route }: { route: ChartRoute }) {
  const gatewayStatus = useGatewayStatus();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const watchlist = useWatchlistWidth(workspaceRef);
  const [resolution, setResolution] = useState(route.resolution);
  const [prompt, setPrompt] = useState<string | null>(null);

  const changeInterval = useCallback((next: string) => {
    setResolution(next);
    writeJson(LAST_INTERVAL_KEY, next);
    window.history.replaceState(null, '', withInterval(window.location.search, next));
  }, []);

  // Typing a number on the chart opens the interval prompt, as on TradingView.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const initial = promptKey(event);
      if (initial === null) return;
      event.preventDefault();
      setPrompt(initial);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // During a drag the splitter writes the width straight to this CSS variable once per frame,
  // with no React render; React takes over again when the drag commits.
  const previewWidth = (width: number) => {
    workspaceRef.current?.style.setProperty('--watchlist-width', `${width}px`);
  };

  return (
    <div className={styles.app} data-gateway-status={gatewayStatus}>
      <Toolbar symbol={route.symbol} interval={resolution} onIntervalChange={changeInterval} />
      <div
        ref={workspaceRef}
        className={styles.workspace}
        style={{ '--watchlist-width': `${watchlist.width}px` } as CSSProperties}
      >
        <main className={`${styles.panel} ${styles.chart}`} aria-label="Chart">
          <ChartPane symbol={route.symbol} resolution={resolution} />
          {prompt !== null && (
            <IntervalPrompt
              initial={prompt}
              onSubmit={(next) => {
                setPrompt(null);
                if (next !== resolution) changeInterval(next);
              }}
              onClose={() => setPrompt(null)}
            />
          )}
        </main>
        <Splitter
          width={watchlist.width}
          min={watchlist.min}
          max={watchlist.max}
          onPreview={previewWidth}
          onCommit={watchlist.commit}
        />
        <aside className={`${styles.panel} ${styles.watchlist}`} aria-label="Watchlist" />
      </div>
    </div>
  );
}
