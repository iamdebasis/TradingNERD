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
  return panelMaxWidth(available, WATCHLIST_LIMITS.min);
}

/** Widest a right-hand panel at least `min` wide may be, leaving the chart its minimum. */
export function panelMaxWidth(available: number, min: number): number {
  const { chartMin, splitter } = WATCHLIST_LIMITS;
  return Math.max(min, Math.floor(available - splitter - chartMin));
}

/**
 * The Pine Editor's width: about half a 1,425 px window, as in the user's screenshot of 27
 * October 2026 (provisional, docs/SPEC.md §11), and no narrower than its header needs.
 */
export const PINE_DEFAULT_WIDTH = 680;
export const PINE_MIN_WIDTH = 420;

/** Clamps a width to [min, max] and rounds to whole CSS pixels. */
export function clampWidth(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}
