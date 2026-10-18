import { darkTheme } from '../theme/tokens';

/** Watchlist width in the reference screenshot (docs/reference/01-chart-layout.png). */
export const WATCHLIST_DEFAULT_WIDTH = 315;

export const WATCHLIST_LIMITS = {
  /** Narrowest watchlist that still fits Symbol / Last / Chg / Chg%. */
  min: 240,
  /** The chart never gets narrower than this while the watchlist grows. */
  chartMin: 320,
  /** The splitter is the gutter between chart and watchlist. */
  splitter: darkTheme.size.gutter,
} as const;

/** Widest the watchlist may be inside a workspace whose content box is `available` px wide. */
export function watchlistMaxWidth(available: number): number {
  const { min, chartMin, splitter } = WATCHLIST_LIMITS;
  return Math.max(min, Math.floor(available - splitter - chartMin));
}

/** Clamps a width to [min, max] and rounds to whole CSS pixels. */
export function clampWidth(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}
