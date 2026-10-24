import type { ReactNode } from 'react';

/**
 * Icons of TradingView's list menu, after a screenshot of it (docs/SPEC.md §5.9): 28 px, 1 px
 * strokes in currentColor, as the row menu's. Their exact paths are provisional (§11).
 */

const icon = (children: ReactNode) => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" aria-hidden>
    {children}
  </svg>
);

/** "Make a copy…": two sheets, one over the other. */
export function CopyIcon() {
  return icon(
    <>
      <path d="M10.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 22.5 6v9a1.5 1.5 0 0 1-1.5 1.5h-1.5" />
      <rect x="5.5" y="10.5" width="14" height="13" rx="1.5" />
    </>,
  );
}

/** "Rename": a pencil. */
export function RenameIcon() {
  return icon(
    <path
      d="M6.5 21.5 7.4 17.6 18.6 6.4a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L10.4 20.6zM16.5 8.5l3 3"
      strokeLinejoin="round"
    />,
  );
}

/** "Clear list": a broom. */
export function ClearIcon() {
  return icon(
    <>
      <path d="M21.5 5.5 15 12" strokeLinecap="round" />
      <path
        d="M12.4 10.6 17.4 15.6 15.6 17.4C13.8 19.2 10.4 21.4 6.5 21.5 6.6 17.6 8.8 14.2 10.6 12.4z"
        strokeLinejoin="round"
      />
      <path d="M9.5 21 13 17.5M7.5 19.5l3.5-3.5" />
    </>,
  );
}

/** "Create new list…": a sheet with lines and a plus. */
export function NewListIcon() {
  return icon(
    <>
      <path d="M17.5 20.5h-9a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7" />
      <path d="M10 10.5h8M10 14.5h5M21.5 17v7M18 20.5h7" />
    </>,
  );
}

/** "Upload list…": an arrow up out of a tray. */
export function UploadIcon() {
  return icon(
    <>
      <path d="M5.5 16.5v4a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4" />
      <path d="M14 18V5.5M9.5 10 14 5.5l4.5 4.5" strokeLinejoin="round" />
    </>,
  );
}

/** "Open list…": a folder. */
export function FolderIcon() {
  return icon(
    <path
      d="M5.5 8.5v11a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-7l-2.5-3h-3.5a2 2 0 0 0-2 2z"
      strokeLinejoin="round"
    />,
  );
}

/** A list's download button: an arrow down into a tray, 18 px. */
export function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" aria-hidden>
      <path d="M3.5 11v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" />
      <path d="M9 3v8.5M5.5 8 9 11.5 12.5 8" strokeLinejoin="round" />
    </svg>
  );
}

/** A list's star (TradingView's favorites): filled when starred. 12 px, as the screenshot's. */
export function ListStarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 15 15"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7.5.9 9.36 5.3l4.74.38-3.6 3.12 1.1 4.65L7.5 11 3.4 13.45l1.1-4.65L.9 5.68l4.74-.38z" />
    </svg>
  );
}
