import type { DrawingLineStyle } from '@tradingnerd/core';

/**
 * The drawing tools' geometry on a pane, in CSS px from its top-left (docs/SPEC.md §6.24): lines
 * carried to the pane's edges, distances for hit tests, Shift's 45° steps, and the stats'
 * numbers. Pure, so each rule is tested on its own.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** How near a line the pointer must be to take it, CSS px (provisional, §11). */
export const LINE_HIT = 5;
/**
 * A drawing's handle: its radius, and how near its centre the mouse takes it (a third-party
 * capture of TradingView's, deepentropy/lightweight-charts-drawing, MIT; provisional, §11).
 */
export const HANDLE_RADIUS = 6;
export const HANDLE_HIT = 12;

/** Beyond the pane's edges a line still runs this far, so its end never shows. */
const MARGIN = 4;
/**
 * How far past the pane a filled area's edges are carried (CSS px): far enough that the edge
 * closing it never crosses the pane, near enough to keep the canvas' numbers small.
 */
export const FILL_REACH = 100_000;

/**
 * The part of the line through `a` and `b` a drawing shows on the pane: from `a` to `b`, carried
 * on past `b` when it extends right and back past `a` when it extends left, so a ray runs from
 * its first point through its second (the direction, not the screen's right). Clipped to the
 * pane (and `margin` beyond it); null when none of it is there.
 */
export function lineSegment(
  a: Pt,
  b: Pt,
  extendLeft: boolean,
  extendRight: boolean,
  size: Size,
  margin = MARGIN,
): [Pt, Pt] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return [a, b];
  const range = clipRange(a, dx, dy, size, margin);
  if (!range) return null;
  const from = Math.max(extendLeft ? Number.NEGATIVE_INFINITY : 0, range[0]);
  const to = Math.min(extendRight ? Number.POSITIVE_INFINITY : 1, range[1]);
  if (from > to) return null;
  return [
    { x: a.x + dx * from, y: a.y + dy * from },
    { x: a.x + dx * to, y: a.y + dy * to },
  ];
}

/** Where the line a + t·(dx, dy) is on the pane, as its range of t (Liang–Barsky). */
function clipRange(
  a: Pt,
  dx: number,
  dy: number,
  size: Size,
  margin: number,
): [number, number] | null {
  let from = Number.NEGATIVE_INFINITY;
  let to = Number.POSITIVE_INFINITY;
  const sides: [number, number][] = [
    [-dx, a.x + margin],
    [dx, size.width + margin - a.x],
    [-dy, a.y + margin],
    [dy, size.height + margin - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) from = Math.max(from, r);
    else to = Math.min(to, r);
  }
  return from > to ? null : [from, to];
}

/** The distance from `p` to the segment from `a` to `b`. */
/** A box on a pane, its edges in CSS px. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The box two corners make, whichever way round they are. */
export function rectOf(a: Pt, b: Pt): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

export function insideRect(p: Pt, rect: Rect): boolean {
  return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
}

/** Whether any part of the segment from a to b lies in the box (Liang–Barsky's clipping). */
export function segmentTouchesRect(a: Pt, b: Pt, rect: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let from = 0;
  let to = 1;
  const sides: [number, number][] = [
    [-dx, a.x - rect.left],
    [dx, rect.right - a.x],
    [-dy, a.y - rect.top],
    [dy, rect.bottom - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) from = Math.max(from, r);
    else to = Math.min(to, r);
    if (from > to) return false;
  }
  return true;
}

export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Shift held: the second point turned to the nearest 45° from the first, keeping its x (a bar)
 * and setting its y to match, as TradingView keeps a line horizontal, vertical or diagonal.
 */
export function snap45(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return to;
  const step = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  switch (((step % 4) + 4) % 4) {
    case 0:
      return { x: to.x, y: from.y };
    case 2:
      return { x: from.x, y: to.y };
    default: {
      // ±45°: as far up or down as along, the sign the angle's.
      const slope = Math.round(Math.tan((step * Math.PI) / 4));
      return { x: to.x, y: from.y + dx * slope };
    }
  }
}

/** A line's angle on screen, degrees up from the right (TradingView's Angle stat and Trend angle). */
export function angleOf(a: Pt, b: Pt): number {
  return (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI;
}

/**
 * A line style's dashes at a width: "2 3" dotted and "6 4" dashed at the default 2 px (the
 * third-party capture's), in step with the width (provisional, §11).
 */
export function dashOf(style: DrawingLineStyle, width: number): number[] {
  if (style === 'dotted') return [width, width * 1.5];
  if (style === 'dashed') return [width * 3, width * 2];
  return [];
}

/**
 * A span of time as the stats write it: days, hours, minutes and seconds, the zero ones left
 * out ("1d 21h 30m", "45s"); the third-party capture's (provisional, §11).
 */
export function formatDuration(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  let left = Math.round(Math.abs(seconds));
  const units: [string, number][] = [
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ];
  const parts: string[] = [];
  for (const [name, size] of units) {
    const count = Math.floor(left / size);
    if (count > 0) parts.push(`${count}${name}`);
    left -= count * size;
  }
  return parts.length === 0 ? '0s' : sign + parts.join(' ');
}

/**
 * An angle as the stats and Trend angle write it: up to two decimals, none trailing, and the
 * capture's "º" ("45º", "-12.5º"); provisional, §11.
 */
export function formatAngle(degrees: number): string {
  const rounded = Math.round(degrees * 100) / 100;
  return `${Object.is(rounded, -0) ? 0 : rounded}º`;
}

/** The screen point a fraction `t` of the way from `a` to `b`. */
export function along(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Whether `p` is inside the polygon with these corners (even-odd, its edges counting in). */
export function insidePolygon(p: Pt, corners: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const a = corners[i] as Pt;
    const b = corners[j] as Pt;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** A "#RRGGBBAA" color's opacity, 0 to 1 ("#RRGGBB" is opaque). */
export function opacityOf(color: string): number {
  return color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1;
}
