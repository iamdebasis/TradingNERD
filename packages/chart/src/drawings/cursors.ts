import type { CursorMode } from './DrawingEngine';

/**
 * The CSS cursors over the panes for the drawing tools' cursor modes (docs/SPEC.md §6.24). The
 * dot and the eraser are ours, drawn to look like TradingView's (its own are its art); their
 * sizes are provisional until measured from the user's screenshots (§11).
 */

const svg = (body: string, size: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`,
  )}`;

/** A light dot with a dark rim, so it shows on any candle. */
const DOT = svg('<circle cx="4.5" cy="4.5" r="2.5" fill="#DBDBDB" stroke="#0F0F0F"/>', 9);

/** An eraser tilted to the right, its tip at the bottom left. */
const ERASER = svg(
  '<g fill="none" stroke="#0F0F0F" stroke-width="3" stroke-linejoin="round">' +
    '<path d="M3 15.5 11.5 7l5 5L10 18.5H6z"/></g>' +
    '<path d="M3 15.5 11.5 7l5 5L10 18.5H6z" fill="#DBDBDB" stroke="#DBDBDB" stroke-linejoin="round"/>' +
    '<path d="M7 11.5l5 5" stroke="#0F0F0F" stroke-width="1.2"/>',
  20,
);

/** The CSS cursor for a cursor the drawing engine asks for. */
export function cursorCss(cursor: string): string {
  switch (cursor) {
    case 'dot':
      return `url("${DOT}") 4 4, crosshair`;
    case 'eraser':
      return `url("${ERASER}") 3 17, default`;
    default:
      return cursor;
  }
}

/** Whether the crosshair's lines show in a cursor mode: not with the arrow or the eraser. */
export function crosshairLinesShow(mode: CursorMode): boolean {
  return mode === 'cross' || mode === 'dot';
}
