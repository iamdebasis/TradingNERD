import type { OlderCapsStatus, SymbolInfo } from '@tradingnerd/core';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { PineEditor } from '../pine/PineEditor';
import { pineStore, usePine } from '../pine/pineStore';
import { SymbolSearchDialog } from '../search/SymbolSearchDialog';
import { searchKey } from '../search/searchPrefs';
import { useStockKeys } from '../stocks/stockKeys';
import { Toolbar } from '../toolbar/Toolbar';
import { Watchlist } from '../watchlist/Watchlist';
import styles from './AppShell.module.css';
import { type RightPanel, RightToolbar } from './RightToolbar';
import { Splitter } from './Splitter';
import { usePanelWidth } from './usePanelWidth';
import { useWatchlistWidth } from './useWatchlistWidth';
import { PINE_DEFAULT_WIDTH, PINE_MIN_WIDTH } from './watchlistWidth';

/** Where the last interval and symbol are remembered, for a page opened without them. */
export const LAST_INTERVAL_KEY = 'tn.chart.interval';
export const LAST_SYMBOL_KEY = 'tn.chart.symbol';
/** Whether the watchlist panel is open (the right toolbar's Watchlist button). */
export const WATCHLIST_OPEN_KEY = 'tn.layout.watchlistOpen';
const PINE_WIDTH_KEY = 'tn.layout.pineWidth';

export function AppShell({ route }: { route: ChartRoute }) {
  const gateway = useGateway();
  const gatewayStatus = useGatewayStatus();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const watchlist = useWatchlistWidth(workspaceRef);
  const pineWidth = usePanelWidth(workspaceRef, PINE_WIDTH_KEY, PINE_DEFAULT_WIDTH, PINE_MIN_WIDTH);
  const pine = usePine();
  const [watchlistOpen, setWatchlistOpen] = useState(() => readJson(WATCHLIST_OPEN_KEY) !== false);
  // One panel at a time on the right: the Pine Editor over the watchlist while it's open.
  const rightPanel: RightPanel | null = pine.open ? 'pine' : watchlistOpen ? 'watchlist' : null;
  const panelWidth = rightPanel === 'pine' ? pineWidth : watchlist;
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

  const showWatchlist = (open: boolean) => {
    setWatchlistOpen(open);
    writeJson(WATCHLIST_OPEN_KEY, open);
  };
  const togglePanel = (panel: RightPanel) => {
    if (panel === 'pine') {
      pineStore.setOpen(!pine.open);
    } else if (pine.open) {
      pineStore.setOpen(false);
      showWatchlist(true);
    } else {
      showWatchlist(!watchlistOpen);
    }
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
      />
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
        <RightToolbar open={rightPanel} onToggle={togglePanel} />
      </div>
    </div>
  );
}
