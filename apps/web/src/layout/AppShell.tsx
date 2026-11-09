import type { OlderCapsStatus, SymbolInfo } from '@tradingnerd/core';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertsHost } from '../alerts/AlertsHost';
import { AlertsPanel } from '../alerts/AlertsPanel';
import { alertSources } from '../alerts/alertSources';
import { alertStore, useAlerts } from '../alerts/alertStore';
import { CreateAlertDialog } from '../alerts/CreateAlertDialog';
import { ChartPane } from '../chart/ChartPane';
import { ChartSettingsDialog } from '../chart/ChartSettingsDialog';
import { IntervalPrompt, promptKey } from '../chart/IntervalPrompt';
import { type ChartRoute, withInterval, withSymbol } from '../chart/route';
import { olderCapsApi } from '../data/api';
import { useGateway, useGatewayStatus } from '../data/GatewayContext';
import { IndicatorsDialog } from '../indicators/IndicatorsDialog';
import { indicatorStore } from '../indicators/indicatorStore';
import { isEditable } from '../lib/dom';
import { readJson, writeJson } from '../lib/storage';
import { useLogos } from '../logos/LogoContext';
import { LogoDialog } from '../logos/LogoDialog';
import { OlderCapsDialog } from '../olderCaps/OlderCapsDialog';
import { librariesStore } from '../pine/librariesStore';
import { logsStore, useLogs } from '../pine/logsStore';
import { PineEditor } from '../pine/PineEditor';
import { PineLogs } from '../pine/PineLogs';
import { pineStore, usePine } from '../pine/pineStore';
import { SymbolSearchDialog } from '../search/SymbolSearchDialog';
import { searchKey } from '../search/searchPrefs';
import { useStockKeys } from '../stocks/stockKeys';
import { StrategyTester } from '../strategy/StrategyTester';
import { strategyStore, useStrategyTester } from '../strategy/strategyStore';
import { Toolbar } from '../toolbar/Toolbar';
import { Watchlist } from '../watchlist/Watchlist';
import styles from './AppShell.module.css';
import { type RightPanel, RightToolbar } from './RightToolbar';
import { Splitter } from './Splitter';
import { usePanelHeight, usePanelWidth } from './usePanelWidth';
import { useWatchlistWidth } from './useWatchlistWidth';
import { PINE_DEFAULT_WIDTH, PINE_MIN_WIDTH } from './watchlistWidth';

/** Where the last interval and symbol are remembered, for a page opened without them. */
export const LAST_INTERVAL_KEY = 'tn.chart.interval';
export const LAST_SYMBOL_KEY = 'tn.chart.symbol';
/** Whether the watchlist panel is open (the right toolbar's Watchlist button). */
export const WATCHLIST_OPEN_KEY = 'tn.layout.watchlistOpen';
/** Whether the alert manager is open (the right toolbar's Alerts button): it takes the watchlist's place. */
export const ALERTS_OPEN_KEY = 'tn.layout.alertsOpen';
const PINE_WIDTH_KEY = 'tn.layout.pineWidth';
const PINE_HEIGHT_KEY = 'tn.layout.pineHeight';
const LOGS_WIDTH_KEY = 'tn.layout.logsWidth';
const TESTER_HEIGHT_KEY = 'tn.layout.testerHeight';

export function AppShell({ route }: { route: ChartRoute }) {
  const gateway = useGateway();
  const gatewayStatus = useGatewayStatus();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const watchlist = useWatchlistWidth(workspaceRef);
  const pineWidth = usePanelWidth(workspaceRef, PINE_WIDTH_KEY, PINE_DEFAULT_WIDTH, PINE_MIN_WIDTH);
  const pine = usePine();
  const logs = useLogs();
  const columnRef = useRef<HTMLDivElement>(null);
  // The Pine Editor below the chart (Move script to bottom): its height, as chosen (provisional).
  const pineHeight = usePanelHeight(columnRef, PINE_HEIGHT_KEY, 320, 160);
  const logsWidth = usePanelWidth(workspaceRef, LOGS_WIDTH_KEY, 420, 280);
  const tester = useStrategyTester();
  // The Strategy Tester below the chart (provisional height); one panel at a time down there.
  const testerHeight = usePanelHeight(columnRef, TESTER_HEIGHT_KEY, 300, 140);
  const bottomPanel: 'tester' | 'pine' | null = tester.open
    ? 'tester'
    : pine.open && pine.dock === 'bottom'
      ? 'pine'
      : null;
  const bottomHeight = bottomPanel === 'tester' ? testerHeight : pineHeight;
  const [watchlistOpen, setWatchlistOpen] = useState(() => readJson(WATCHLIST_OPEN_KEY) !== false);
  const [alertsOpen, setAlertsOpen] = useState(() => readJson(ALERTS_OPEN_KEY) === true);
  const alerts = useAlerts();
  const pineRight = pine.open && pine.dock === 'right';
  const pineBottom = pine.open && pine.dock === 'bottom';
  // One panel at a time on the right: Pine Logs, else the Pine Editor docked there, else the
  // alert manager, else the watchlist.
  const rightPanel: RightPanel | 'logs' | null = logs.open
    ? 'logs'
    : pineRight
      ? 'pine'
      : alertsOpen
        ? 'alerts'
        : watchlistOpen
          ? 'watchlist'
          : null;
  const panelWidth =
    rightPanel === 'pine' ? pineWidth : rightPanel === 'logs' ? logsWidth : watchlist;
  // The toolbar lights the watchlist when it shows, and Pine wherever the editor is.
  const lit: RightPanel[] = [
    ...(rightPanel === 'watchlist' ? (['watchlist'] as const) : []),
    ...(rightPanel === 'alerts' ? (['alerts'] as const) : []),
    ...(pine.open ? (['pine'] as const) : []),
    ...(tester.open ? (['tester'] as const) : []),
  ];
  const [resolution, setResolution] = useState(route.resolution);
  const [symbol, setSymbol] = useState(route.symbol);
  const [prompt, setPrompt] = useState<string | null>(null);
  /** Symbol search, with what was typed to open it. */
  const [searching, setSearching] = useState<string | null>(null);
  const logos = useLogos();
  const [logoDialog, setLogoDialog] = useState<'first-launch' | 'menu' | null>(null);
  const [olderCapsOpen, setOlderCapsOpen] = useState(false);
  /** Older market caps' download: whether Live Coin Watch's data is in, for the credit. */
  const [olderCaps, setOlderCaps] = useState<OlderCapsStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  /** The chart's symbol as resolved, for Chart settings' fields. */
  const [chartInfo, setChartInfo] = useState<SymbolInfo | null>(null);
  const firstLaunchShown = useRef(false);

  // Coin logos need a CoinGecko key: ask once, at first launch, unless it was skipped before.
  useEffect(() => {
    const status = logos.status;
    if (!status || firstLaunchShown.current) return;
    firstLaunchShown.current = true;
    if (!status.key && !status.promptDismissed) setLogoDialog('first-launch');
  }, [logos.status]);

  // The Pine libraries scripts import: at hand before any script compiles (SPEC §5.17).
  useEffect(() => {
    void librariesStore.load();
  }, []);

  useEffect(() => {
    let alive = true;
    olderCapsApi.status().then(
      (loaded) => {
        if (alive) setOlderCaps(loaded);
      },
      () => {
        // Without it, only CoinGecko is credited.
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const stockKeys = useStockKeys();
  const watchlistMenu = useMemo(
    () => [
      { label: 'Coin logos (CoinGecko)…', onSelect: () => setLogoDialog('menu') },
      { label: 'US stock data (Alpaca)…', onSelect: stockKeys.prompt },
      { label: 'Older market caps (Live Coin Watch)…', onSelect: () => setOlderCapsOpen(true) },
    ],
    [stockKeys.prompt],
  );

  const changeInterval = useCallback((next: string) => {
    setResolution(next);
    writeJson(LAST_INTERVAL_KEY, next);
    window.history.replaceState(null, '', withInterval(window.location.search, next));
  }, []);

  const changeSymbol = useCallback((next: string) => {
    setSymbol(next);
    writeJson(LAST_SYMBOL_KEY, next);
    window.history.replaceState(null, '', withSymbol(window.location.search, next));
  }, []);

  // Typing on the chart opens TradingView's prompts: a number the interval prompt, a letter
  // symbol search, and / the Indicators dialog (Pine docs, First steps).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setIndicatorsOpen(true);
        return;
      }
      // TradingView's Create alert: Alt+A (the key's place, as Alt changes the letter on a Mac).
      if (event.altKey && event.code === 'KeyA' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        alertStore.openDialog();
        return;
      }
      const digits = promptKey(event);
      const letter = searchKey(event);
      if (digits === null && letter === null) return;
      event.preventDefault();
      if (digits !== null) setPrompt(digits);
      else setSearching(letter);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // During a drag the splitter writes the width straight to this CSS variable once per frame,
  // with no React render; React takes over again when the drag commits.
  const previewWidth = (width: number) => {
    workspaceRef.current?.style.setProperty('--panel-width', `${width}px`);
  };
  const previewHeight = (height: number) => {
    columnRef.current?.style.setProperty('--bottom-height', `${height}px`);
  };

  const showWatchlist = (open: boolean) => {
    setWatchlistOpen(open);
    writeJson(WATCHLIST_OPEN_KEY, open);
  };
  const showAlerts = (open: boolean) => {
    setAlertsOpen(open);
    writeJson(ALERTS_OPEN_KEY, open);
  };
  const togglePanel = (panel: RightPanel) => {
    if (panel === 'alerts') {
      if (rightPanel === 'alerts') showAlerts(false);
      else {
        // The alert manager takes the right from Pine Logs and from the editor docked there.
        logsStore.close();
        if (pineRight) pineStore.setOpen(false);
        showAlerts(true);
      }
    } else if (panel === 'tester') {
      strategyStore.setOpen(!tester.open);
    } else if (panel === 'pine') {
      // The editor docked behind Pine Logs comes forward; otherwise Pine opens or closes it.
      if (pineRight && logs.open) logsStore.close();
      else pineStore.setOpen(!pine.open);
    } else if (rightPanel === 'watchlist') {
      showWatchlist(false);
    } else {
      // The watchlist takes the right from Pine Logs, the editor docked there and the alerts.
      logsStore.close();
      if (pineRight) pineStore.setOpen(false);
      showAlerts(false);
      showWatchlist(true);
    }
  };

  /**
   * A Pine Logs entry's Source code: its script in the editor at its line. Below the chart the
   * editor shows beside the logs (as Figure 350); on the right it takes their place.
   */
  const showSource = (id: string, line: number) => {
    const indicator = indicatorStore.get().list.find((item) => item.id === id);
    if (!indicator) return;
    pineStore.showLine(indicator, line);
    if (pineStore.get().dock === 'right') logsStore.close();
  };

  return (
    <div className={styles.app} data-gateway-status={gatewayStatus}>
      <Toolbar
        symbol={symbol}
        interval={resolution}
        onIntervalChange={changeInterval}
        onSymbolSearch={() => setSearching('')}
        onSettings={() => setSettingsOpen(true)}
        onIndicators={() => setIndicatorsOpen(true)}
        onAddIndicator={(kind) => indicatorStore.add(kind)}
        onAlert={() => alertStore.openDialog()}
      />
      <AlertsHost />
      {alerts.dialog && (
        <CreateAlertDialog
          key={alerts.dialog.editing ?? 'new'}
          symbol={symbol}
          interval={resolution}
          sources={alertSources(indicatorStore.get().list, librariesStore.compileOptions())}
          editing={alerts.dialog.editing ? (alertStore.find(alerts.dialog.editing) ?? null) : null}
          onClose={() => alertStore.closeDialog()}
        />
      )}
      {indicatorsOpen && (
        <IndicatorsDialog
          onAdd={(kind) => indicatorStore.add(kind)}
          onClose={() => setIndicatorsOpen(false)}
        />
      )}
      {settingsOpen && (
        <ChartSettingsDialog
          hasSessions={
            chartInfo?.id.toUpperCase() === symbol.toUpperCase() && chartInfo.schedule !== undefined
          }
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {searching !== null && (
        <SymbolSearchDialog
          mode="search"
          initialQuery={searching}
          onChoose={changeSymbol}
          onClose={() => setSearching(null)}
        />
      )}
      <div className={styles.main}>
        <div
          ref={workspaceRef}
          className={styles.workspace}
          style={{ '--panel-width': `${panelWidth.width}px` } as CSSProperties}
        >
          <div
            ref={columnRef}
            className={styles.column}
            style={{ '--bottom-height': `${bottomHeight.width}px` } as CSSProperties}
          >
            <main className={`${styles.panel} ${styles.chart}`} aria-label="Chart">
              <ChartPane symbol={symbol} resolution={resolution} onInfo={setChartInfo} />
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
            {bottomPanel === 'tester' && (
              <>
                <Splitter
                  axis="y"
                  label="Resize Strategy Tester"
                  width={testerHeight.width}
                  min={testerHeight.min}
                  max={testerHeight.max}
                  onPreview={previewHeight}
                  onCommit={testerHeight.commit}
                />
                <section
                  className={`${styles.panel} ${styles.bottom}`}
                  aria-label="Strategy Tester panel"
                >
                  <StrategyTester onClose={() => strategyStore.setOpen(false)} />
                </section>
              </>
            )}
            {pineBottom && bottomPanel === 'pine' && (
              <>
                <Splitter
                  axis="y"
                  label="Resize Pine Editor"
                  width={pineHeight.width}
                  min={pineHeight.min}
                  max={pineHeight.max}
                  onPreview={previewHeight}
                  onCommit={pineHeight.commit}
                />
                <section
                  className={`${styles.panel} ${styles.bottom}`}
                  aria-label="Pine Editor panel"
                >
                  <PineEditor onClose={() => pineStore.setOpen(false)} />
                </section>
              </>
            )}
          </div>
          {rightPanel && (
            <Splitter
              key={rightPanel}
              width={panelWidth.width}
              min={panelWidth.min}
              max={panelWidth.max}
              onPreview={previewWidth}
              onCommit={panelWidth.commit}
            />
          )}
          {logoDialog && (
            <LogoDialog
              firstLaunch={logoDialog === 'first-launch'}
              onClose={() => setLogoDialog(null)}
            />
          )}
          {olderCapsOpen && (
            <OlderCapsDialog onStatus={setOlderCaps} onClose={() => setOlderCapsOpen(false)} />
          )}
          {rightPanel === 'pine' && (
            <aside className={`${styles.panel} ${styles.side}`} aria-label="Pine Editor panel">
              <PineEditor onClose={() => pineStore.setOpen(false)} />
            </aside>
          )}
          {rightPanel === 'alerts' && (
            <aside className={`${styles.panel} ${styles.side}`} aria-label="Alerts panel">
              <AlertsPanel
                errors={alerts.errors}
                onCreate={() => alertStore.openDialog()}
                onClose={() => showAlerts(false)}
              />
            </aside>
          )}
          {rightPanel === 'logs' && (
            <aside className={`${styles.panel} ${styles.side}`} aria-label="Pine Logs panel">
              <PineLogs onClose={() => logsStore.close()} onSource={showSource} />
            </aside>
          )}
          <aside
            className={`${styles.panel} ${styles.side}`}
            aria-label="Watchlist"
            hidden={rightPanel !== 'watchlist'}
          >
            <Watchlist
              symbol={symbol}
              onChoose={changeSymbol}
              quotes={gateway}
              moreItems={watchlistMenu}
              moreNote={
                olderCaps?.from
                  ? 'Data provided by CoinGecko and Live Coin Watch'
                  : 'Data provided by CoinGecko'
              }
            />
          </aside>
        </div>
        <RightToolbar open={lit} onToggle={togglePanel} />
      </div>
    </div>
  );
}
