import { ChartController } from '@tradingnerd/chart';
import { useEffect, useRef, useState } from 'react';
import { marketApi } from '../data/api';
import { useGateway } from '../data/GatewayContext';
import { gestureSettings } from '../gestures/gestureSettings';
import { useStockKeys } from '../stocks/stockKeys';
import { darkTheme } from '../theme/tokens';
import styles from './ChartPane.module.css';
import { ChartSession, type LegendView } from './ChartSession';
import { toChartTheme } from './chartTheme';
import { Legend } from './Legend';

const chartTheme = toChartTheme(darkTheme);

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
  // A saved Alpaca key starts the session over, so a stock waiting for it loads.
  const { version: stockKeyVersion, prompt: promptStockKey } = useStockKeys();

  useEffect(() => {
    if (!container.current) return;
    const created = new ChartController(container.current, {
      theme: chartTheme,
      onHover: (info) => session.current?.hover(info),
      onNeedHistory: () => void session.current?.loadOlder(),
      onGesture: (setting) => gestureSettings.gestured(setting),
    });
    // The user's gesture settings (the top bar's Gestures popup), now and as they change.
    created.setGestureTuning(gestureSettings.get());
    const stopSettings = gestureSettings.subscribe(() =>
      created.setGestureTuning(gestureSettings.get()),
    );
    setChart(created);
    if (import.meta.env.DEV) window.__tradingNerd = { chart: created };
    return () => {
      stopSettings();
      created.destroy();
      setChart(null);
      if (import.meta.env.DEV) window.__tradingNerd = { chart: null };
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key restarts the session
  useEffect(() => {
    if (!chart || !legend.current) return;
    const current = new ChartSession({
      chart,
      api: marketApi,
      feed: gateway,
      legend: legend.current,
      symbol,
      resolution,
      onError: (code) => {
        if (code === 'needs_key') promptStockKey();
      },
    });
    session.current = current;
    void current.start();
    return () => {
      current.dispose();
      if (session.current === current) session.current = null;
    };
  }, [chart, gateway, symbol, resolution, stockKeyVersion, promptStockKey]);

  return (
    <div className={styles.pane}>
      <div ref={container} className={styles.chart} />
      <Legend ref={legend} />
    </div>
  );
}
