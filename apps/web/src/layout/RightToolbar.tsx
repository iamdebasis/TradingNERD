import { ListIcon, PineIcon } from '../pine/icons';
import styles from './RightToolbar.module.css';

/** The panels the right toolbar opens. */
export type RightPanel = 'watchlist' | 'pine';

/**
 * TradingView's right toolbar (its "widget bar"): a button per panel, the open one lit; a click
 * on the lit one closes its panel. We have the Watchlist and the Pine Editor (docs/SPEC.md §5.16;
 * TradingView puts Pine there since August 2025). Its look is provisional until measured (§11).
 */
export function RightToolbar({
  open,
  onToggle,
}: {
  open: RightPanel | null;
  onToggle(panel: RightPanel): void;
}) {
  return (
    <nav className={styles.toolbar} aria-label="Panels">
      <button
        type="button"
        className={styles.button}
        aria-label="Watchlist"
        title="Watchlist"
        aria-pressed={open === 'watchlist'}
        onClick={() => onToggle('watchlist')}
      >
        <ListIcon />
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Pine Editor"
        title="Pine Editor"
        aria-pressed={open === 'pine'}
        onClick={() => onToggle('pine')}
      >
        <PineIcon />
      </button>
    </nav>
  );
}
