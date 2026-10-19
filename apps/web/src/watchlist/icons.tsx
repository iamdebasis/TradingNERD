/**
 * Watchlist header and section icons, traced from docs/reference/01-chart-layout.png at 2×:
 * 1 px strokes in currentColor.
 */

export function AddIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" aria-hidden>
      <path d="M7.5 0v15M0 7.5h15" />
    </svg>
  );
}

/** "Advanced view": a table with an arrow leaving its corner. */
export function AdvancedViewIcon() {
  return (
    <svg width="21" height="20" viewBox="0 0 21 20" fill="none" stroke="currentColor" aria-hidden>
      <path d="M1.5 10V1.5h18v17h-10V1.5M1.5 5.5h18M14.5 5.5v13M9.5 11.5h10" />
      <path d="M2 12.5h4.5V17M6.5 12.5l-5 5" />
    </svg>
  );
}

/** Three hollow dots. */
export function MoreIcon() {
  return (
    <svg width="21" height="9" viewBox="0 0 21 9" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="3.5" cy="4.5" r="2" />
      <circle cx="10.5" cy="4.5" r="2" />
      <circle cx="17.5" cy="4.5" r="2" />
    </svg>
  );
}

/** A section's caret: down while open, right when folded. */
export function SectionCaret({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="5"
      viewBox="0 0 9 5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={open ? undefined : { transform: 'rotate(-90deg)' }}
      aria-hidden
    >
      <path d="M.75.75 4.5 4.25 8.25.75" />
    </svg>
  );
}

/**
 * "Remove from watchlist" on a hovered row: a bin with a lid and handle, centered in its 22 px
 * button. Traced at 2× from docs/reference/05-watchlist-hover.png; it differs from it by 0.8
 * gray levels on average (tests/e2e/watchlist.spec.ts).
 */
export function RemoveIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" aria-hidden>
      <path d="M5 6.5h12M8.5 6v-.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6" />
      <path d="M6.5 7l.9 9.6a1 1 0 0 0 1 .9h5.2a1 1 0 0 0 1-.9L15.5 7" />
    </svg>
  );
}

/**
 * TradingView's row flag (docs/reference/06-watchlist-flags.png): a 12 × 13 pennant with a V
 * cut into its right side, in currentColor. Traced at 2× to match the reference pixel for pixel.
 */
export function FlagIcon() {
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" fill="currentColor" aria-hidden>
      <path d="M0 0h11.75L8.5 6.5 12 13H0z" />
    </svg>
  );
}

/**
 * "Add section" in a row's menu: a dashed line over a slot, traced at 2× from
 * docs/reference/07-watchlist-row-menu.png (28 px, as TradingView's menu icons).
 */
export function AddSectionIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" aria-hidden>
      <path d="M4 9.5h5M11 9.5h6M19 9.5h5" />
      <rect x="5.5" y="14.5" width="17" height="5" rx="1.25" />
    </svg>
  );
}

/** "Add symbol" in a row's menu: a 15 px plus, traced as AddSectionIcon. */
export function AddSymbolIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" aria-hidden>
      <path d="M14.5 6v15M7 13.5h15" />
    </svg>
  );
}
