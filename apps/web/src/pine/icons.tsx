/** Icons of the Pine Editor and the right toolbar, ours in TradingView's line style (provisional). */

const line = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** The panel's mark beside "Pine Editor": a panel docked to the side. */
export function PanelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" {...line} aria-hidden>
      <rect x="2.5" y="3.5" width="13" height="11" rx="1" />
      <path d="M11.5 3.5v11M5.5 9h3.5M7.5 7l2 2-2 2" />
    </svg>
  );
}

/** Pine's mark on the right toolbar: a pine tree's outline. */
export function PineIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" {...line} aria-hidden>
      <path d="M14 4.5 8 12.5h3.5L7 18.5h5.5v5h3v-5H21l-4.5-6H20z" />
    </svg>
  );
}

/** The watchlist's mark on the right toolbar: a list. */
export function ListIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" {...line} aria-hidden>
      <path d="M10.5 8.5h11M10.5 14h11M10.5 19.5h11" />
      <circle cx="6.5" cy="8.5" r="1" />
      <circle cx="6.5" cy="14" r="1" />
      <circle cx="6.5" cy="19.5" r="1" />
    </svg>
  );
}

/** Before the script's name: an indicator (a small wave). */
export function WaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" {...line} aria-hidden>
      <path d="M2 11.5c1.5-3 3-4.5 4.5-4.5S9 10 10.5 10 13.5 7 16 5.5" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" {...line} aria-hidden>
      <path d="M3 4.5 6 7.5l3-3" />
    </svg>
  );
}

/** Add to chart: a play triangle. */
export function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" {...line} aria-hidden>
      <path d="M5.5 3.5v11l9-5.5z" />
    </svg>
  );
}

/** Save script: a floppy disk. */
export function SaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" {...line} aria-hidden>
      <path d="M3.5 2.5h9l3 3v10h-12z" />
      <path d="M6 2.5v4h5.5v-4M6 15.5v-5h6v5" />
    </svg>
  );
}

/** The console's toggle in the status bar: a prompt. */
export function ConsoleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" {...line} aria-hidden>
      <rect x="2.5" y="3.5" width="13" height="11" rx="1.5" />
      <path d="m5.5 7 2 2-2 2M9 11h3.5" />
    </svg>
  );
}

/** The banner's warning mark: an orange circled "!" (measured #F67E05). */
export function NoticeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="8" fill="#F67E05" />
      <path d="M9 4.8v5.4" stroke="#000" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="9" cy="13" r="1.05" fill="#000" />
    </svg>
  );
}
