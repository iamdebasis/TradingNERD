import { ChartController } from '@tradingnerd/chart';
import type { SymbolInfo } from '@tradingnerd/core';
import type { SymbolContext } from '@tradingnerd/indicators';
import { useEffect, useMemo, useRef, useState } from 'react';
import { marketApi, searchApi } from '../data/api';
import { useGateway } from '../data/GatewayContext';
import { gestureSettings } from '../gestures/gestureSettings';
import { definitionOf } from '../indicators/definitions';
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
import { librariesStore, useLibraries } from '../pine/librariesStore';
import { logsStore } from '../pine/logsStore';
import { pineStore } from '../pine/pineStore';
import { useStockKeys } from '../stocks/stockKeys';
import { strategyStore } from '../strategy/strategyStore';
import { darkTheme } from '../theme/tokens';
import styles from './ChartPane.module.css';
import { ChartSession, type LegendView } from './ChartSession';
import { chartSettings, useChartSettings } from './chartSettings';
import { toChartTheme } from './chartTheme';
import { Legend } from './Legend';
import { RequestLoader } from './requestLoader';

const chartTheme = toChartTheme(darkTheme);

declare global {
  interface Window {
    /** Dev-only handle for end-to-end tests and debugging. */
    __tradingNerd?: {
      chart: ChartController | null;
      /** The Pine Editor's code: replaced as one edit, as a paste replaces it. */
      code?: { set(text: string): void };
    };
  }
}

/** Until the symbol resolves, Volume's title names no coin. */
const NO_SYMBOL: SymbolContext = { base: '', hasVolume: true };

/** Live updates of scripts' requested data run their live bar at most this often, ms. */
const REQUEST_LIVE_MS = 250;

/**
 * A ticker a script requests without its exchange ("AAPL"), as TradingView picks one: the
 * search's first listing of that exact ticker; null when there's none.
 */
async function findSymbol(ticker: string, signal: AbortSignal): Promise<string | null> {
  const { matches } = await searchApi.search({ query: ticker, exchange: null, offset: 0 }, signal);
  const exact = matches.find((match) => match.ticker.toUpperCase() === ticker.toUpperCase());
  return exact?.listings[0]?.id ?? null;
}

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
  const libraries = useLibraries();
  const [values] = useState(() => new LegendValues());
  const [panes, setPanes] = useState<readonly PaneBox[]>([]);
  const [symbolContext, setSymbolContext] = useState<SymbolContext>(NO_SYMBOL);
  /** The indicator whose settings are open. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Why each script on the chart draws nothing, for its legend row. */
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  /** The scripts waiting for their requests' data, for their legend rows. */
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  /** Brings the scripts' requests, errors and logs up to date (set once the loader is). */
  const sync = useRef<() => void>(() => {});
  const resolutionRef = useRef(resolution);
  resolutionRef.current = resolution;
  /** A Pine Logs entry's bar, brought into view: its time over it for a moment. */
  const [barTip, setBarTip] = useState<{ x: number; label: string } | null>(null);

  // The session talks to the legend; the indicators' rows follow the same bar.
  const legendView = useMemo(
    (): LegendView => ({
      setInstrument: (info, res) => legend.current?.setInstrument(info, res),
      showBar: (bar, previous, index) => {
        legend.current?.showBar(bar, previous, index);
        values.show(index);
        // A script can stop on a live bar: its row says so. Its logs may have grown too, and
        // its requests may ask for more.
        const now = values.chart?.indicatorErrors();
        if (now) setErrors((before) => (sameErrors(before, now) ? before : now));
        if (values.chart) {
          logsStore.setScripts(values.chart.scriptLogs());
          strategyStore.setStrategies(values.chart.scriptStrategies());
        }
        sync.current();
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
    if (import.meta.env.DEV) window.__tradingNerd = { ...window.__tradingNerd, chart: created };
    return () => {
      stopSettings();
      values.chart = null;
      created.destroy();
      setChart(null);
      if (import.meta.env.DEV) window.__tradingNerd = { ...window.__tradingNerd, chart: null };
    };
  }, [values]);

  // Scripts' requests (docs/SPEC.md §6.18): the data they ask for loads from the gateway as the
  // chart's own; they run again when it's in, and their live bar when it moves.
  useEffect(() => {
    if (!chart) return;
    let frame = 0;
    let timer = 0;
    let pending: 'history' | 'live' | null = null;
    let lastLive = 0;
    const refresh = () => {
      frame = 0;
      const kind = pending;
      pending = null;
      if (!kind) return;
      if (kind === 'live') lastLive = Date.now();
      chart.requestsChanged(kind);
      values.refresh();
      // A context that doesn't exist stops its script only now: its row says so.
      const now = chart.indicatorErrors();
      setErrors((before) => (sameErrors(before, now) ? before : now));
      logsStore.setScripts(chart.scriptLogs());
      strategyStore.setStrategies(chart.scriptStrategies());
      sync.current();
    };
    const schedule = (kind: 'history' | 'live') => {
      pending = kind === 'history' || pending === 'history' ? 'history' : 'live';
      if (frame || timer) return;
      const wait = pending === 'live' ? REQUEST_LIVE_MS - (Date.now() - lastLive) : 0;
      if (wait > 0) {
        timer = window.setTimeout(() => {
          timer = 0;
          frame = requestAnimationFrame(refresh);
        }, wait);
      } else frame = requestAnimationFrame(refresh);
    };
    const loader = new RequestLoader({
      api: marketApi,
      feed: gateway,
      background: chartTheme.background,
      onHistory: () => schedule('history'),
      onLive: () => schedule('live'),
      find: findSymbol,
    });
    chart.setRequestFeed(loader);
    sync.current = () => {
      const { missing, used } = chart.scriptRequests();
      loader.want(missing, used, {
        firstBarTime: chart.firstBarTime(),
        timeframe: resolutionRef.current,
      });
      const now = chart.waitingIndicators();
      setWaiting((before) => (sameSet(before, now) ? before : now));
    };
    sync.current();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      sync.current = () => {};
      loader.dispose();
    };
  }, [chart, gateway, values]);

  // The indicators on the chart follow the store: added, changed, hidden and removed.
  useEffect(() => {
    chart?.setIndicators(indicators.list);
    values.refresh();
    if (!chart) return;
    setErrors(chart.indicatorErrors());
    logsStore.setScripts(chart.scriptLogs());
    strategyStore.setStrategies(chart.scriptStrategies());
    sync.current();
  }, [chart, indicators.list, values]);

  // A Pine Logs entry's Scroll to bar: the bar comes into view, then its time shows over it for a
  // moment, written as the crosshair writes it (Pine docs, Debugging; 2 s is provisional, §11).
  useEffect(() => {
    if (!chart) return;
    let timer = 0;
    let frame = 0;
    const stop = logsStore.onScrollToBar(({ bar }) => {
      const label = chart.scrollToBar(bar);
      if (label === null) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const x = chart.barX(bar);
        setBarTip(x === null ? null : { x, label });
        clearTimeout(timer);
        timer = window.setTimeout(() => setBarTip(null), 2000);
      });
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [chart]);

  // Scripts that import compile again when a library is added or removed (SPEC §5.17).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the libraries' revision is the change
  useEffect(() => {
    if (!chart) return;
    chart.setLibraries(librariesStore.compileOptions());
    values.refresh();
    setErrors(chart.indicatorErrors());
    logsStore.setScripts(chart.scriptLogs());
    strategyStore.setStrategies(chart.scriptStrategies());
    sync.current();
  }, [chart, libraries.revision, values]);

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
        values.priceDecimals = info.pricePrecision;
        setSymbolContext({ base: volumeUnit(info), hasVolume: hasRealVolume(info) });
        logsStore.setZone(info.timezone);
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
      onSource: (id) => {
        const indicator = indicatorStore.get().list.find((item) => item.id === id);
        if (indicator) pineStore.openIndicator(indicator);
      },
    }),
    [],
  );
  // Volume and overlays sit in the price pane: their rows join the legend's; the others' panes
  // have their own.
  const inPricePane = indicators.list.filter((item) => definitionOf(item).placement !== 'pane');

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
          errors={errors}
          waiting={waiting}
        />
      </Legend>
      <PaneLegends
        panes={panes}
        indicators={indicators.list}
        symbol={symbolContext}
        values={values}
        actions={actions}
        errors={errors}
        waiting={waiting}
      />
      {editing !== null && (
        <IndicatorSettingsDialog id={editing} onClose={() => setEditing(null)} />
      )}
      {barTip && (
        <div className={styles.barTip} style={{ left: barTip.x }} role="tooltip">
          {/* The date over the time, as Figure 351 shows them. */}
          {barTip.label.replace(/ (\d{1,2}:\d{2}(?::\d{2})?)$/, '\n$1')}
        </div>
      )}
    </div>
  );
}

const sameErrors = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  a.size === b.size && [...a].every(([id, message]) => b.get(id) === message);

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));
