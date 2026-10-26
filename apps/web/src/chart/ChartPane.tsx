import { ChartController } from '@tradingnerd/chart';
import type { SymbolInfo } from '@tradingnerd/core';
import { indicatorDefinition, type SymbolContext } from '@tradingnerd/indicators';
import { useEffect, useMemo, useRef, useState } from 'react';
import { marketApi } from '../data/api';
import { useGateway } from '../data/GatewayContext';
import { gestureSettings } from '../gestures/gestureSettings';
import {
  LegendValues,
  type PaneBox,
  PaneLegends,
  PriceLegendRows,
  type RowActions,
} from '../indicators/IndicatorLegend';
import { IndicatorSettingsDialog } from '../indicators/IndicatorSettingsDialog';
import { indicatorStore, useIndicators } from '../indicators/indicatorStore';
import { hasRealVolume, volumeUnit } from '../indicators/symbolVolume';
import { useStockKeys } from '../stocks/stockKeys';
import { darkTheme } from '../theme/tokens';
import styles from './ChartPane.module.css';
import { ChartSession, type LegendView } from './ChartSession';
import { chartSettings, useChartSettings } from './chartSettings';
import { toChartTheme } from './chartTheme';
import { Legend } from './Legend';

const chartTheme = toChartTheme(darkTheme);

declare global {
  interface Window {
    /** Dev-only handle for end-to-end tests and debugging. */
    __tradingNerd?: { chart: ChartController | null };
  }
}

/** Until the symbol resolves, Volume's title names no coin. */
const NO_SYMBOL: SymbolContext = { base: '', hasVolume: true };

/**
 * The chart panel. One chart lives as long as the pane; each symbol or interval gets its own
 * session on it, so switching interval swaps the data without rebuilding the chart. Its
 * indicators come from the indicator store and survive both.
 */
export function ChartPane({
  symbol,
  resolution,
  onInfo,
}: {
  symbol: string;
  resolution: string;
  /** The chart's symbol, once resolved (Chart settings shows its fields). */
  onInfo?: (info: SymbolInfo) => void;
}) {
  const gateway = useGateway();
  const container = useRef<HTMLDivElement>(null);
  const legend = useRef<LegendView>(null);
  const session = useRef<ChartSession | null>(null);
  const [chart, setChart] = useState<ChartController | null>(null);
  // A saved Alpaca key starts the session over, so a stock waiting for it loads.
  const { version: stockKeyVersion, prompt: promptStockKey } = useStockKeys();
  // A new session or time zone loads the chart again; new background colors don't.
  const settings = useChartSettings();
  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;
  const indicators = useIndicators();
  const [values] = useState(() => new LegendValues());
  const [panes, setPanes] = useState<readonly PaneBox[]>([]);
  const [symbolContext, setSymbolContext] = useState<SymbolContext>(NO_SYMBOL);
  /** The indicator whose settings are open. */
  const [editing, setEditing] = useState<string | null>(null);

  // The session talks to the legend; the indicators' rows follow the same bar.
  const legendView = useMemo(
    (): LegendView => ({
      setInstrument: (info, res) => legend.current?.setInstrument(info, res),
      showBar: (bar, previous, index) => {
        legend.current?.showBar(bar, previous, index);
        values.show(index);
      },
      setBook: (bid, ask) => legend.current?.setBook(bid, ask),
      setStatus: (status, message) => legend.current?.setStatus(status, message),
      setMarketStatus: (status) => legend.current?.setMarketStatus(status),
    }),
    [values],
  );

  useEffect(() => {
    if (!container.current) return;
    const created = new ChartController(container.current, {
      theme: chartTheme,
      onHover: (info) => session.current?.hover(info),
      onNeedHistory: () => void session.current?.loadOlder(),
      onGesture: (setting) => gestureSettings.gestured(setting),
      onPaneHeights: (heights) => indicatorStore.setPaneHeights(heights),
      onLayout: () => setPanes(created.paneLayout()),
    });
    values.chart = created;
    // The user's gesture settings (the top bar's Gestures popup), now and as they change.
    created.setGestureTuning(gestureSettings.get());
    const stopSettings = gestureSettings.subscribe(() =>
      created.setGestureTuning(gestureSettings.get()),
    );
    setChart(created);
    if (import.meta.env.DEV) window.__tradingNerd = { chart: created };
    return () => {
      stopSettings();
      values.chart = null;
      created.destroy();
      setChart(null);
      if (import.meta.env.DEV) window.__tradingNerd = { chart: null };
    };
  }, [values]);

  // The indicators on the chart follow the store: added, changed, hidden and removed.
  useEffect(() => {
    chart?.setIndicators(indicators.list);
    values.refresh();
  }, [chart, indicators.list, values]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key, session or time zone restarts the session
  useEffect(() => {
    if (!chart) return;
    const current = new ChartSession({
      chart,
      api: marketApi,
      feed: gateway,
      legend: legendView,
      symbol,
      resolution,
      settings: chartSettings.get(),
      onInfo: (info) => {
        values.hasVolume = hasRealVolume(info);
        setSymbolContext({ base: volumeUnit(info), hasVolume: hasRealVolume(info) });
        onInfoRef.current?.(info);
      },
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
  }, [
    chart,
    gateway,
    symbol,
    resolution,
    stockKeyVersion,
    promptStockKey,
    settings.session,
    settings.timezone,
  ]);

  useEffect(() => {
    session.current?.setBackgrounds(settings.preMarketBackground, settings.postMarketBackground);
  }, [settings.preMarketBackground, settings.postMarketBackground]);

  const actions = useMemo(
    (): RowActions => ({
      onHide: (id, hidden) => indicatorStore.setHidden(id, hidden),
      onSettings: (id) => setEditing(id),
      onRemove: (id) => indicatorStore.remove(id),
    }),
    [],
  );
  // Volume sits in the price pane: its row joins the legend's; the others' panes have their own.
  const inPricePane = indicators.list.filter(
    (item) => indicatorDefinition(item.kind).placement !== 'pane',
  );

  return (
    <div className={styles.pane}>
      <div ref={container} className={styles.chart} />
      <Legend ref={legend}>
        <PriceLegendRows
          indicators={inPricePane}
          folded={indicators.folded}
          onFold={(folded) => indicatorStore.setFolded(folded)}
          symbol={symbolContext}
          values={values}
          actions={actions}
        />
      </Legend>
      <PaneLegends
        panes={panes}
        indicators={indicators.list}
        symbol={symbolContext}
        values={values}
        actions={actions}
      />
      {editing !== null && (
        <IndicatorSettingsDialog id={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}
