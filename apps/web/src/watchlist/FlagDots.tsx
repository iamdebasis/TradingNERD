import { FLAG_COLORS, type FlagColor } from '@tradingnerd/core';
import type { CSSProperties } from 'react';
import styles from './FlagDots.module.css';
import { FLAG_NAMES, flagStyle } from './flags';

/**
 * TradingView's seven flag colors as 16 px dots (docs/reference/06-watchlist-flags.png and
 * 07-watchlist-row-menu.png): the symbol's own color is a ring, and picking it takes the flag
 * off. The bubble spaces them 8 px apart, the row menu 12.
 */
export function FlagDots({
  current,
  gap,
  onPick,
}: {
  current: FlagColor | null;
  gap: number;
  onPick(color: FlagColor): void;
}) {
  return (
    <div className={styles.dots} style={{ gap } as CSSProperties}>
      {FLAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={styles.dot}
          style={flagStyle(color)}
          aria-label={
            color === current ? `${FLAG_NAMES[color]} (remove the flag)` : FLAG_NAMES[color]
          }
          aria-pressed={color === current}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}
