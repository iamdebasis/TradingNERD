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

/**
 * The chart panel. One chart lives as long as the pane; each symbol or interval gets its own
 * session on it, so switching interval swaps the data without rebuilding the chart.
 */
export function ChartPane({ symbol, resolution }: { symbol: string; resolution: string }) {
  const gateway = useGateway();
  const container = useRef<HTMLDivElement>(null);
  const legend = useRef<LegendView>(null);
  const session = useRef<ChartSession | null>(null);
  const [chart, setChart] = useState<ChartController | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const created = new ChartController(container.current, {
      theme: chartTheme,
      onHover: (info) => session.current?.hover(info),
      onNeedHistory: () => void session.current?.loadOlder(),
    });
    setChart(created);
    if (import.meta.env.DEV) window.__tradingNerd = { chart: created };
    return () => {
      created.destroy();
      setChart(null);
      if (import.meta.env.DEV) window.__tradingNerd = { chart: null };
    };
  }, []);

  useEffect(() => {
    if (!chart || !legend.current) return;
    const current = new ChartSession({
      chart,
      api: marketApi,
      feed: gateway,
      legend: legend.current,
      symbol,
      resolution,
    });
    session.current = current;
    void current.start();
    return () => {
      current.dispose();
      if (session.current === current) session.current = null;
    };
  }, [chart, gateway, symbol, resolution]);

  const tuning = import.meta.env.DEV && new URLSearchParams(window.location.search).has('tune');

  return (
    <div className={styles.pane}>
      <div ref={container} className={styles.chart} />
      <Legend ref={legend} />
      {TuningPanel && tuning && chart && (
        <Suspense fallback={null}>
          <TuningPanel chart={chart} />
        </Suspense>
      )}
    </div>
  );
}
