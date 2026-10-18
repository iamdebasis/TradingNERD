import { type CSSProperties, useRef } from 'react';
import { ChartPane } from '../chart/ChartPane';
import type { ChartRoute } from '../chart/route';
import { useGatewayStatus } from '../data/GatewayContext';
import styles from './AppShell.module.css';
import { Splitter } from './Splitter';
import { useWatchlistWidth } from './useWatchlistWidth';

export function AppShell({ route }: { route: ChartRoute }) {
  const gatewayStatus = useGatewayStatus();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const watchlist = useWatchlistWidth(workspaceRef);

  // During a drag the splitter writes the width straight to this CSS variable once per frame,
  // with no React render; React takes over again when the drag commits.
  const previewWidth = (width: number) => {
    workspaceRef.current?.style.setProperty('--watchlist-width', `${width}px`);
  };

  return (
    <div className={styles.app} data-gateway-status={gatewayStatus}>
      <header className={styles.toolbar} />
      <div
        ref={workspaceRef}
        className={styles.workspace}
        style={{ '--watchlist-width': `${watchlist.width}px` } as CSSProperties}
      >
        <main className={`${styles.panel} ${styles.chart}`} aria-label="Chart">
          <ChartPane symbol={route.symbol} resolution={route.resolution} />
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
