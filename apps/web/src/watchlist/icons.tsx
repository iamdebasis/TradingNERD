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
