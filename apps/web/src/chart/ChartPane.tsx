import { ChartController } from '@tradingnerd/chart';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { marketApi } from '../data/api';
import { useGateway } from '../data/GatewayContext';
import { darkTheme } from '../theme/tokens';
import styles from './ChartPane.module.css';
import { ChartSession, type LegendView } from './ChartSession';
import { toChartTheme } from './chartTheme';
import { Legend } from './Legend';

const chartTheme = toChartTheme(darkTheme);

/** TEMPORARY gesture calibration panel: dev builds only, opened with `?tune` in the URL. */
const TuningPanel = import.meta.env.DEV
  ? lazy(() => import('../dev/TuningPanel').then((module) => ({ default: module.TuningPanel })))
  : null;

declare global {
  interface Window {
    /** Dev-only handle for end-to-end tests and debugging. */
    __tradingNerd?: { chart: ChartController | null };
  }
}

export function ChartPane({ symbol, resolution }: { symbol: string; resolution: string }) {
  const gateway = useGateway();
  const container = useRef<HTMLDivElement>(null);
  const legend = useRef<LegendView>(null);
  // Dev only: the chart the tuning panel adjusts.
  const [tunedChart, setTunedChart] = useState<ChartController | null>(null);

  useEffect(() => {
    if (!container.current || !legend.current) return;
    let session: ChartSession | undefined;
    const chart = new ChartController(container.current, {
      theme: chartTheme,
      onHover: (info) => session?.hover(info),
      onNeedHistory: () => void session?.loadOlder(),
    });
    session = new ChartSession({
      chart,
      api: marketApi,
      feed: gateway,
      legend: legend.current,
      symbol,
      resolution,
    });
    void session.start();
    if (import.meta.env.DEV) {
      window.__tradingNerd = { chart };
      if (new URLSearchParams(window.location.search).has('tune')) setTunedChart(chart);
    }
    return () => {
      session?.dispose();
      if (import.meta.env.DEV) {
        window.__tradingNerd = { chart: null };
        setTunedChart(null);
      }
    };
  }, [gateway, symbol, resolution]);

  return (
    <div className={styles.pane}>
      <div ref={container} className={styles.chart} />
      <Legend ref={legend} />
      {TuningPanel && tunedChart && (
        <Suspense fallback={null}>
          <TuningPanel chart={tunedChart} />
        </Suspense>
      )}
    </div>
  );
}
