/**
 * Alerts' icons, ours in TradingView's line style: an alarm clock with a plus on the top bar's
 * Alert button (docs/reference/01-chart-layout.png) and an alarm clock on the right toolbar.
 * Provisional until measured from a screenshot (docs/SPEC.md §11).
 */

const line = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** The top bar's Alert: an alarm clock with a plus beside it. */
export function AlarmAddIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" {...line} aria-hidden>
      <circle cx="10" cy="12" r="6.5" />
      <path d="M10 8.5V12l2.2 1.6M4.3 4.2 2.5 6M15.7 4.2 17.5 6M7 19.5l-1 1.5M13 19.5l1 1.5" />
      <path d="M18.5 1.5v4M16.5 3.5h4" />
    </svg>
  );
}

/** The right toolbar's Alerts: an alarm clock. */
export function AlarmIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" {...line} aria-hidden>
      <circle cx="14" cy="15" r="7.5" />
      <path d="M14 11v4l2.5 1.8M7.5 6.5l-2.5 2.5M20.5 6.5l2.5 2.5M10.5 23l-1.2 1.8M17.5 23l1.2 1.8" />
    </svg>
  );
}

/** A row's Edit: a pencil. */
export function EditIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" {...line} aria-hidden>
      <path d="m11.5 3.5 3 3-8.5 8.5H3v-3z" />
      <path d="m10 5 3 3" />
    </svg>
  );
}
