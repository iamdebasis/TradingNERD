import { symbolName } from '@tradingnerd/core';
import type { IndicatorKind } from '@tradingnerd/indicators';
import { useRef, useState } from 'react';
import { GesturesPopup } from '../gestures/GesturesPopup';
import { isChanged, useGestureSettings } from '../gestures/gestureSettings';
import { IndicatorsButton } from '../indicators/IndicatorsButton';
import { AddIntervalDialog } from './AddIntervalDialog';
import { IntervalMenu } from './IntervalMenu';
import { CandlesIcon, ChevronDownIcon, GesturesIcon, SettingsIcon } from './icons';
import {
  addCustom,
  menuSections,
  removeCustom,
  toggleFavorite,
  toggleSection,
  toolbarButtons,
} from './intervalPrefs';
import styles from './Toolbar.module.css';
import { useIntervalPrefs } from './useIntervalPrefs';

export interface ToolbarProps {
  /** "BINANCE:XRPUSDT" */
  symbol: string;
  /** The chart's interval, TradingView notation. */
  interval: string;
  onIntervalChange(interval: string): void;
  /** The symbol pill was pressed: open symbol search. */
  onSymbolSearch(): void;
  /** The settings button was pressed: open Chart settings. */
  onSettings(): void;
  /** The Indicators button was pressed: open the Indicators dialog. */
  onIndicators(): void;
  /** A favorite indicator was picked from the ⌄ beside it. */
  onAddIndicator(kind: IndicatorKind): void;
}

/**
 * TradingView's top bar, v1 slice: the symbol pill, the favorite intervals and the interval
 * menu (docs/reference/02-toolbar.png and 03-interval-menu.png), the Indicators button and its
 * favorites ⌄ (01-chart-layout.png), then our own Gestures button, and at the right
 * TradingView's Settings button, which opens Chart settings.
 */
export function Toolbar({
  symbol,
  interval,
  onIntervalChange,
  onSymbolSearch,
  onSettings,
  onIndicators,
  onAddIndicator,
}: ToolbarProps) {
  const [prefs, setPrefs] = useIntervalPrefs();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [gesturesOpen, setGesturesOpen] = useState(false);
  const arrow = useRef<HTMLButtonElement>(null);
  const gesturesButton = useRef<HTMLButtonElement>(null);
  const gesturesChanged = isChanged(useGestureSettings());
  const ticker = symbolName(symbol);

  const choose = (next: string) => {
    setMenuOpen(false);
    if (next !== interval) onIntervalChange(next);
  };

  return (
    <header className={styles.toolbar}>
      <button
        type="button"
        className={styles.pill}
        aria-label={`Symbol search: ${ticker}`}
        onClick={onSymbolSearch}
      >
        <span className={styles.ticker}>{ticker}</span>
        <span className={styles.pillIcon}>
          <CandlesIcon />
        </span>
      </button>
      <span className={styles.separator} />
      <fieldset className={styles.intervals} aria-label="Intervals">
        {toolbarButtons(prefs, interval).map((button) => (
          <button
            key={button.interval}
            type="button"
            className={styles.interval}
            aria-pressed={button.active}
            onClick={() => choose(button.interval)}
          >
            {button.label}
          </button>
        ))}
        <button
          ref={arrow}
          type="button"
          className={styles.arrow}
          aria-label="Interval menu"
          aria-expanded={menuOpen}
          data-open={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <ChevronDownIcon />
        </button>
      </fieldset>
      <span className={styles.separator} />
      <IndicatorsButton onOpen={onIndicators} onAdd={onAddIndicator} />
      <span className={styles.separator} />
      <button
        ref={gesturesButton}
        type="button"
        className={styles.tool}
        aria-expanded={gesturesOpen}
        data-open={gesturesOpen}
        data-changed={gesturesChanged || undefined}
        title={
          gesturesChanged ? 'Gesture settings (changed from the defaults)' : 'Gesture settings'
        }
        onClick={() => setGesturesOpen(!gesturesOpen)}
      >
        <GesturesIcon />
        Gestures
      </button>
      {gesturesOpen && (
        <GesturesPopup anchor={gesturesButton} onClose={() => setGesturesOpen(false)} />
      )}
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Settings"
        title="Settings"
        onClick={onSettings}
      >
        <SettingsIcon />
      </button>
      {menuOpen && (
        <IntervalMenu
          anchor={arrow}
          sections={menuSections(prefs)}
          current={interval}
          onSelect={choose}
          onToggleFavorite={(item) => setPrefs((current) => toggleFavorite(current, item))}
          onToggleSection={(section) => setPrefs((current) => toggleSection(current, section))}
          onRemove={(item) => setPrefs((current) => removeCustom(current, item))}
          onAddCustom={() => {
            setMenuOpen(false);
            setAdding(true);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}
      {adding && (
        <AddIntervalDialog
          onAdd={(added) => {
            setAdding(false);
            setPrefs((current) => addCustom(current, added));
            if (added !== interval) onIntervalChange(added);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </header>
  );
}
