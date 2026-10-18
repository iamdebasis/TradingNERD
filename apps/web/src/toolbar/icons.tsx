/**
 * Toolbar and menu icons, traced from the reference screenshots at 2× (docs/reference/02 and
 * 03): 1 px strokes in currentColor, drawn on whole and half pixels so they stay crisp.
 */

/** Two hollow candles, as inside the symbol pill. Sized to the pill's 24 px inner capsule. */
export function CandlesIcon() {
  return (
    <svg width="12" height="24" viewBox="0 0 12 24" fill="none" stroke="currentColor" aria-hidden>
      <rect x="0.5" y="8.5" width="4" height="8" rx="0.5" />
      <path d="M2.5 6v2M2.5 17v2" />
      <rect x="7.5" y="9.5" width="4" height="6" rx="0.5" />
      <path d="M9.5 7v2M9.5 16v2" />
    </svg>
  );
}

/** The interval menu's ⌄. */
export function ChevronDownIcon() {
  return (
    <svg
      width="8"
      height="5"
      viewBox="0 0 8 5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M0.5 0.5 4 4l3.5-3.5" />
    </svg>
  );
}

/** A section header's caret: up while the section is open. */
export function CaretIcon({ open }: { open: boolean }) {
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
      style={open ? undefined : { transform: 'rotate(180deg)' }}
      aria-hidden
    >
      <path d="M0.75 4.25 4.5 0.75l3.75 3.5" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" aria-hidden>
      <path d="M8.5 0v17M0 8.5h17" />
    </svg>
  );
}

/** A regular five-point star, 15 px wide (outer radius 7.9): filled for favorites. */
const FILLED_STAR =
  'M7.5 0 9.28 5.46H15l-4.63 3.37 1.77 5.46L7.5 10.92l-4.64 3.37 1.77-5.46L0 5.46h5.72z';
/** The same star half a pixel smaller, so a 1 px outline stays inside the same box. */
const OUTLINED_STAR =
  'M7.5.5 9.16 5.61h5.38l-4.35 3.16 1.66 5.12L7.5 10.73l-4.35 3.16 1.66-5.12L.46 5.61h5.38z';

/** Drawn at 15.5 px: the reference star measures 3% larger than a 15 px one. */
export function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="15.5"
      height="15.5"
      viewBox="0 0 15 15"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={filled ? FILLED_STAR : OUTLINED_STAR} />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="m1.5 1.5 7 7m0-7-7 7" />
    </svg>
  );
}
