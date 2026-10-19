/**
 * Symbol search icons, traced from docs/reference/04-add-symbol.png at 2× (CSS px): strokes in
 * currentColor, on whole and half pixels so they stay crisp.
 */

/** The search field's magnifier: a ring and its handle, 1.5 px strokes. */
export function SearchIcon() {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="9.25" cy="8.75" r="7.5" />
      <path d="M14.55 13.8 19.9 19.4" />
    </svg>
  );
}

/** "Clear": a filled 16 px disc with a cut-out ×. */
export function ClearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path
        d="m5.25 5.25 5.5 5.5m0-5.5-5.5 5.5"
        stroke="var(--color-popup)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The dialog's close ×, 15 px across, a little heavier than 1 px. */
export function CloseLargeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="m1.25 1.25 13.5 13.5m0-13.5-13.5 13.5" />
    </svg>
  );
}

/** "Remove from watchlist": a bin with a lid and handle. */
export function TrashIcon() {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 21 21"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 4h17M7.5 3.5v-1A1.5 1.5 0 0 1 9 1h4a1.5 1.5 0 0 1 1.5 1.5v1" />
      <path d="M4.5 4.5 6 20h10l1.5-15.5" />
    </svg>
  );
}

/** "Show in watchlist": a ring with four ticks through it. */
export function LocateIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 21 21" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="11.5" cy="10" r="7" />
      <path d="M2 10h6m7 0h5.5M11.5.5V6m0 7.5V19" />
    </svg>
  );
}

/** A row's ⌄ for the exchanges that list a pair: larger and heavier than a menu's. */
export function ExpandIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="7"
      viewBox="0 0 11 7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={open ? { transform: 'rotate(180deg)' } : undefined}
      aria-hidden
    >
      <path d="m1 1 4.5 4.5L10 1" />
    </svg>
  );
}

/** ⇧, inside a keycap. */
export function ShiftIcon() {
  return (
    <svg
      width="15"
      height="13"
      viewBox="0 0 15 13"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7.5 1.25 12.5 6.25h-2v4.75h-6V6.25h-2z" />
    </svg>
  );
}

/** A filter option's check mark. */
export function CheckIcon() {
  return (
    <svg
      width="14"
      height="10"
      viewBox="0 0 14 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m1 5 4 4 8-8" />
    </svg>
  );
}
