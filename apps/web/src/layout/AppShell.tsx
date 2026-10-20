import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartPane } from '../chart/ChartPane';
import { IntervalPrompt, promptKey } from '../chart/IntervalPrompt';
import { type ChartRoute, withInterval, withSymbol } from '../chart/route';
import { useGateway, useGatewayStatus } from '../data/GatewayContext';
import { isEditable } from '../lib/dom';
import { writeJson } from '../lib/storage';
import { useLogos } from '../logos/LogoContext';
import { LogoDialog } from '../logos/LogoDialog';
import { SymbolSearchDialog } from '../search/SymbolSearchDialog';
import { searchKey } from '../search/searchPrefs';
import { useStockKeys } from '../stocks/stockKeys';
import { Toolbar } from '../toolbar/Toolbar';
import { Watchlist } from '../watchlist/Watchlist';
import styles from './AppShell.module.css';
import { Splitter } from './Splitter';
import { useWatchlistWidth } from './useWatchlistWidth';

/** Where the last interval and symbol are remembered, for a page opened without them. */
export const LAST_INTERVAL_KEY = 'tn.chart.interval';
export const LAST_SYMBOL_KEY = 'tn.chart.symbol';

export function AppShell({ route }: { route: ChartRoute }) {
  const gateway = useGateway();
  const gatewayStatus = useGatewayStatus();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const watchlist = useWatchlistWidth(workspaceRef);
  const [resolution, setResolution] = useState(route.resolution);
  const [symbol, setSymbol] = useState(route.symbol);
  const [prompt, setPrompt] = useState<string | null>(null);
  /** Symbol search, with what was typed to open it. */
  const [searching, setSearching] = useState<string | null>(null);
  const logos = useLogos();
  const [logoDialog, setLogoDialog] = useState<'first-launch' | 'menu' | null>(null);
  const firstLaunchShown = useRef(false);

  // Coin logos need a CoinGecko key: ask once, at first launch, unless it was skipped before.
  useEffect(() => {
    const status = logos.status;
    if (!status || firstLaunchShown.current) return;
    firstLaunchShown.current = true;
    if (!status.key && !status.promptDismissed) setLogoDialog('first-launch');
  }, [logos.status]);

  const stockKeys = useStockKeys();
  const watchlistMenu = useMemo(
    () => [
      { label: 'Coin logos (CoinGecko)…', onSelect: () => setLogoDialog('menu') },
      { label: 'US stock data (Alpaca)…', onSelect: stockKeys.prompt },
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
  // symbol search.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
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
    workspaceRef.current?.style.setProperty('--watchlist-width', `${width}px`);
  };

  return (
    <div className={styles.app} data-gateway-status={gatewayStatus}>
      <Toolbar
        symbol={symbol}
        interval={resolution}
        onIntervalChange={changeInterval}
        onSymbolSearch={() => setSearching('')}
      />
      {searching !== null && (
        <SymbolSearchDialog
          mode="search"
          initialQuery={searching}
          onChoose={changeSymbol}
          onClose={() => setSearching(null)}
        />
      )}
      <div
        ref={workspaceRef}
        className={styles.workspace}
        style={{ '--watchlist-width': `${watchlist.width}px` } as CSSProperties}
      >
        <main className={`${styles.panel} ${styles.chart}`} aria-label="Chart">
          <ChartPane symbol={symbol} resolution={resolution} />
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
        {logoDialog && (
          <LogoDialog
            firstLaunch={logoDialog === 'first-launch'}
            onClose={() => setLogoDialog(null)}
          />
        )}
        <aside className={`${styles.panel} ${styles.watchlist}`} aria-label="Watchlist">
          <Watchlist
            symbol={symbol}
            onChoose={changeSymbol}
            quotes={gateway}
            moreItems={watchlistMenu}
            moreNote="Data provided by CoinGecko"
          />
        </aside>
      </div>
    </div>
  );
}
