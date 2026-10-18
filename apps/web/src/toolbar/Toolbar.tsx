import { useRef, useState } from 'react';
import { AddIntervalDialog } from './AddIntervalDialog';
import { IntervalMenu } from './IntervalMenu';
import { CandlesIcon, ChevronDownIcon } from './icons';
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
}

/**
 * TradingView's top bar, v1 slice: the symbol pill, the favorite intervals and the interval
 * menu (docs/reference/02-toolbar.png and 03-interval-menu.png).
 */
export function Toolbar({ symbol, interval, onIntervalChange }: ToolbarProps) {
  const [prefs, setPrefs] = useIntervalPrefs();
  const [menuOpen, setMenuOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const arrow = useRef<HTMLButtonElement>(null);
  const ticker = symbol.slice(symbol.indexOf(':') + 1);

  const choose = (next: string) => {
    setMenuOpen(false);
    if (next !== interval) onIntervalChange(next);
  };

  return (
    <header className={styles.toolbar}>
      {/* Symbol search arrives in M4; until then the pill only shows the symbol. */}
      <div className={styles.pill}>
        <span className={styles.ticker}>{ticker}</span>
        <span className={styles.pillIcon}>
          <CandlesIcon />
        </span>
      </div>
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
