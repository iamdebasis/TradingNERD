/**
 * The indicators' icons. The toolbar's Indicators icon and the legend's crossed-out eye are
 * traced from docs/reference/01-chart-layout.png at 2×; the rest are ours, provisional until
 * measured from TradingView's screenshots (docs/SPEC.md §11). Strokes in currentColor.
 */

/**
 * "Indicators": four bars rising to the right under a zigzag, 17 × 18 px. Drawn in device
 * pixels of a 2× screen (a 36 × 38 grid), as traced: 1 px walls the bars share.
 */
export function IndicatorsIcon() {
  return (
    <svg
      width="18"
      height="19"
      viewBox="0 0 36 38"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 37V29h8v8M10 29v-6h8v14M18 27h8v10M26 37V17h8v20M2 37h32" />
      <path d="M1.5 15 11 6l9 5.5 13.5-9.5" strokeLinecap="round" />
    </svg>
  );
}

/** Hide (an open eye), on a legend row's hover. */
export function EyeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.5 9C3.2 5.7 5.8 4 9 4s5.8 1.7 7.5 5c-1.7 3.3-4.3 5-7.5 5s-5.8-1.7-7.5-5Z" />
      <circle cx="9" cy="9" r="2.5" />
    </svg>
  );
}

/** A hidden indicator's eye, crossed out: 16 × 12 px after its title, as traced. */
export function EyeCrossedIcon() {
  return (
    <svg
      width="16"
      height="12"
      viewBox="0 0 16 12"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1 6c1.6-3 4.1-4.6 7-4.6 1.1 0 2.1.2 3.1.6M14 3.4c.7.7 1.3 1.6 1.9 2.6-1.6 3-4.1 4.6-7 4.6-1.1 0-2.1-.2-3-.6" />
      <path d="M5.6 7.3A2.5 2.5 0 0 1 9.3 4" />
      <path d="M2.5 11.5 14.5.5" />
    </svg>
  );
}

/** Settings (a gear), on a legend row's hover. */
export function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7.6 1.5h2.8l.4 2.2 1.4.8 2.1-.8 1.4 2.4-1.7 1.5v1.6l1.7 1.5-1.4 2.4-2.1-.8-1.4.8-.4 2.2H7.6l-.4-2.2-1.4-.8-2.1.8-1.4-2.4 1.7-1.5V7.6L2.3 6.1l1.4-2.4 2.1.8 1.4-.8z" />
      <circle cx="9" cy="9" r="2.5" />
    </svg>
  );
}

/** Remove (a bin), on a legend row's hover. */
export function TrashIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 4.5h13M7 4.5v-2h4v2M4.5 4.5l.8 11h7.4l.8-11M7.5 7.5v5.5M10.5 7.5v5.5" />
    </svg>
  );
}

/** The legend's fold button: ^ while the rows show, ⌄ once folded (8 × 5 px, as traced). */
export function FoldIcon({ folded }: { folded: boolean }) {
  return (
    <svg
      width="9"
      height="5"
      viewBox="0 0 9 5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={folded ? { transform: 'rotate(180deg)' } : undefined}
      aria-hidden
    >
      <path d="M.75 4.25 4.5.75l3.75 3.5" />
    </svg>
  );
}

/** The search field's magnifier. */
export function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="7.5" cy="7.5" r="5.5" />
      <path d="m11.5 11.5 5 5" />
    </svg>
  );
}
