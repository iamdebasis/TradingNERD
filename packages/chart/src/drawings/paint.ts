import type { DrawingLineStyle, HAlign } from '@tradingnerd/core';
import { luminance } from '../plugins/ValueLabelsPrimitive';
import { angleOf, dashOf, formatAngle, HANDLE_RADIUS, type Pt } from './geometry';
import type { StatsIcon, StatsRow } from './stats';

/**
 * How the drawing tools look on the canvas (docs/SPEC.md §7.8). The sizes and colors are a
 * third-party capture of TradingView's (deepentropy/lightweight-charts-drawing, MIT), provisional
 * until measured from the user's screenshots (§11).
 */

/** A handle's ring (the capture's TV_ANCHOR_COLOR). */
export const ANCHOR_COLOR = '#1E53E5';
const ANCHOR_HALO = 'rgba(30, 83, 229, 0.2)';

/** The stats' box beside a line (Info line). */
export const STATS_BOX = {
  background: 'rgba(70, 70, 70, 0.9)',
  text: '#FFFFFF',
  icon: '#F9F9F9',
  fontSize: 12,
  padding: 12,
  rowHeight: 18,
  rowGap: 8,
  iconSize: 18,
  radius: 4,
  /** Its corner from the point it's at, right and up or down. */
  offset: 12,
} as const;

/** Trend angle's arc, from its first point (CSS px). */
export const TREND_ANGLE_RADIUS = 50;
/** An open arrowhead's arms, in line widths, back along the line and to each side. */
const ARROW_ARM = 5;

/** The library's time-axis label, measured from its code (5.2.1): paddings in 12ths of the font. */
const TIME_LABEL = { border: 1, tick: 5, radius: 2 } as const;

const DARK_TEXT = '#000000';
const LIGHT_TEXT = '#FFFFFF';

/** "#RRGGBB" or "#RRGGBBAA" at an opacity, its own alpha kept. */
export function withAlpha(color: string, alpha: number): string {
  const value = Number.parseInt(color.slice(1, 7), 16);
  const own = color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) / 255 : 1;
  const a = Math.round(own * alpha * 1000) / 1000;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${a})`;
}

/** Black on a light label, white on the rest (the capture's textOnColor). */
export function textOn(background: string): string {
  return luminance(background) > 0.5 ? DARK_TEXT : LIGHT_TEXT;
}

/** A font as canvas writes it. */
export function fontOf(size: number, family: string, bold = false, italic = false): string {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${family}`;
}

export interface LineLook {
  color: string;
  width: number;
  lineStyle: DrawingLineStyle;
}

/** Lines in a drawing's look: solid ones with round ends, as TradingView's. */
export function strokeSegments(
  ctx: CanvasRenderingContext2D,
  segments: readonly (readonly [Pt, Pt])[],
  look: LineLook,
): void {
  if (segments.length === 0) return;
  ctx.save();
  ctx.strokeStyle = look.color;
  ctx.lineWidth = look.width;
  ctx.setLineDash(dashOf(look.lineStyle, look.width));
  ctx.lineCap = look.lineStyle === 'solid' ? 'round' : 'butt';
  ctx.beginPath();
  for (const [a, b] of segments) {
    const [p, q] = crisp(ctx, a, b, look.width);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * A horizontal or vertical line on whole device pixels (an odd width centred on one), so it's as
 * sharp as the chart's own; a slanted line as it is.
 */
function crisp(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, width: number): [Pt, Pt] {
  const { a: sx, d: sy } = ctx.getTransform();
  const snap = (value: number, scale: number) => {
    const device = Math.round(width * scale);
    const half = device % 2 === 1 ? 0.5 : 0;
    return (Math.round(value * scale - half) + half) / scale;
  };
  if (a.y === b.y) {
    const y = snap(a.y, sy);
    return [
      { x: a.x, y },
      { x: b.x, y },
    ];
  }
  if (a.x === b.x) {
    const x = snap(a.x, sx);
    return [
      { x, y: a.y },
      { x, y: b.y },
    ];
  }
  return [a, b];
}

/** An open arrowhead at `tip`, pointing away from `from`. */
export function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tip: Pt,
  from: Pt,
  color: string,
  width: number,
): void {
  const length = Math.hypot(tip.x - from.x, tip.y - from.y);
  if (length === 0 || width < 1) return;
  const ux = (tip.x - from.x) / length;
  const uy = (tip.y - from.y) / length;
  const arm = ARROW_ARM * width;
  const bx = tip.x - ux * arm;
  const by = tip.y - uy * arm;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bx - uy * arm, by + ux * arm);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(bx + uy * arm, by - ux * arm);
  ctx.stroke();
  ctx.restore();
}

export interface HandleLook {
  /** A rounded square (a horizontal or vertical line's), else a circle. */
  square: boolean;
  /** Its fill: the chart's background. */
  fill: string;
  /** Its drawing is selected (a thicker ring), not only hovered. */
  selected: boolean;
  /** The pointer is on this handle: a halo round it. */
  hovered: boolean;
}

/** A drawing's handle at a point. */
export function drawHandle(ctx: CanvasRenderingContext2D, at: Pt, look: HandleLook): void {
  const ring = look.selected ? 2 : 1;
  const r = HANDLE_RADIUS;
  ctx.save();
  ctx.setLineDash([]);
  const outline = (extra: number) => {
    ctx.beginPath();
    if (look.square) {
      const side = 2 * r - ring + 2 * extra;
      ctx.roundRect(at.x - side / 2, at.y - side / 2, side, side, 3 + extra);
    } else {
      ctx.arc(at.x, at.y, r + extra, 0, Math.PI * 2);
    }
  };
  if (look.hovered) {
    ctx.strokeStyle = ANCHOR_HALO;
    ctx.lineWidth = 3;
    outline(1.5 + ring / 2);
    ctx.stroke();
  }
  ctx.fillStyle = look.fill;
  ctx.strokeStyle = ANCHOR_COLOR;
  ctx.lineWidth = ring;
  outline(0);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** The stats box's size for these rows, CSS px. */
export function statsBoxSize(
  ctx: CanvasRenderingContext2D,
  rows: readonly StatsRow[],
  family: string,
): { width: number; height: number } {
  const { padding, iconSize, rowHeight, rowGap, fontSize } = STATS_BOX;
  ctx.font = fontOf(fontSize, family);
  const text = Math.max(0, ...rows.map((row) => ctx.measureText(row.text).width));
  const width = Math.ceil(text + padding + iconSize + padding + padding);
  return {
    width: width + (width % 2),
    height: rows.length * rowHeight + Math.max(0, rows.length - 1) * rowGap + 2 * padding,
  };
}

/**
 * The stats beside a line: right of `at`, above it when the line runs down to the right (or up
 * to the left) so the box stays off the line, else below.
 */
export function drawStatsBox(
  ctx: CanvasRenderingContext2D,
  at: Pt,
  rows: readonly StatsRow[],
  above: boolean,
  family: string,
): void {
  if (rows.length === 0) return;
  const { padding, iconSize, rowHeight, rowGap, offset, radius } = STATS_BOX;
  const { width, height } = statsBoxSize(ctx, rows, family);
  const left = at.x + offset;
  const top = above ? at.y - offset - height : at.y + offset;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = STATS_BOX.background;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, radius);
  ctx.fill();
  ctx.font = fontOf(STATS_BOX.fontSize, family);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const rowTop = top + padding + i * (rowHeight + rowGap);
    drawStatsIcon(ctx, row.icon, left + padding, rowTop + (rowHeight - iconSize) / 2);
    ctx.fillStyle = STATS_BOX.text;
    ctx.fillText(row.text, left + padding + iconSize + padding, rowTop + rowHeight / 2);
  });
  ctx.restore();
}

/**
 * A row's icon in an 18 px square: ours, drawn to the size of TradingView's (its own icons are
 * its art): a double arrow up and down for the price, left and right for bars and time, and an
 * angle for the angle.
 */
function drawStatsIcon(ctx: CanvasRenderingContext2D, icon: StatsIcon, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = STATS_BOX.icon;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (icon) {
    case 'price':
      ctx.moveTo(9, 3.5);
      ctx.lineTo(9, 14.5);
      ctx.moveTo(6, 6.5);
      ctx.lineTo(9, 3.5);
      ctx.lineTo(12, 6.5);
      ctx.moveTo(6, 11.5);
      ctx.lineTo(9, 14.5);
      ctx.lineTo(12, 11.5);
      break;
    case 'bars':
      ctx.moveTo(3.5, 9);
      ctx.lineTo(14.5, 9);
      ctx.moveTo(6.5, 6);
      ctx.lineTo(3.5, 9);
      ctx.lineTo(6.5, 12);
      ctx.moveTo(11.5, 6);
      ctx.lineTo(14.5, 9);
      ctx.lineTo(11.5, 12);
      break;
    case 'angle':
      ctx.moveTo(14.5, 14.5);
      ctx.lineTo(3.5, 14.5);
      ctx.lineTo(12.5, 4.5);
      ctx.moveTo(8.5, 14.5);
      ctx.arc(3.5, 14.5, 5, 0, -Math.atan2(10, 9), true);
      break;
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Trend angle's measure at its first point: a dotted line along the horizontal and an arc to the
 * line, both 50 px, and the angle right of the arc in the line's color ("45º").
 */
export function drawTrendAngle(
  ctx: CanvasRenderingContext2D,
  a: Pt,
  b: Pt,
  color: string,
  font: string,
  fontSize: number,
): void {
  const r = TREND_ANGLE_RADIUS;
  const end = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 2]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(a.x + r, a.y);
  // Up the screen is a negative canvas angle: the arc turns counterclockwise to reach it.
  if (b.x !== a.x || b.y !== a.y) ctx.arc(a.x, a.y, r, 0, end, end < 0);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatAngle(angleOf(a, b)), a.x + r + 5 + fontSize / 3, a.y);
  ctx.restore();
}

/** Which side of its line a text sits on: above, on (with a gap in the line), or below. */
export type TextSide = 'above' | 'on' | 'below';

export interface TextLayout {
  /** Where the text's line starts, and its angle there (radians). */
  origin: Pt;
  angle: number;
  /** Along the line and across it (y down), in the text's own frame. */
  x: number;
  top: number;
  lines: string[];
  lineHeight: number;
  font: string;
  color: string;
  /** Where the line is left out for the text (it sits on the line), or null. */
  gap: [Pt, Pt] | null;
}

export interface TextLook {
  value: string;
  color: string;
  size: number;
  bold: boolean;
  italic: boolean;
}

/**
 * Where a drawing's text goes along its line from `from` to `to` (as the capture lays it out):
 * read left to right, turned to the line, at its left, centre or right end (`inset` in from the
 * end), above it, on it or below it, a third of its size away. Null for no text.
 */
export function layoutText(
  ctx: CanvasRenderingContext2D,
  from: Pt,
  to: Pt,
  look: TextLook,
  family: string,
  along: HAlign,
  side: TextSide,
  inset = look.size / 3,
): TextLayout | null {
  const lines = look.value.split('\n');
  if (lines.every((line) => line.trim() === '')) return null;
  // Left to right on screen; straight up (a vertical line's) from the first point given.
  const [l, r] = to.x < from.x ? [to, from] : [from, to];
  const length = Math.hypot(r.x - l.x, r.y - l.y);
  const angle = length > 0 ? Math.atan2(r.y - l.y, r.x - l.x) : 0;
  const font = fontOf(look.size, family, look.bold, look.italic);
  ctx.save();
  ctx.font = font;
  const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
  ctx.restore();
  const lineHeight = Math.ceil(look.size);
  const height = lines.length * lineHeight;
  const pad = look.size / 3;
  const x =
    along === 'left' ? inset : along === 'right' ? length - inset - width : (length - width) / 2;
  const top = side === 'above' ? -pad - height : side === 'below' ? pad : -height / 2;
  // On the line, the line makes room for the text's middle row (the capture's rule: only when
  // it has a middle row with something in it).
  const middle = lines.length % 2 === 1 ? lines[(lines.length - 1) / 2] : undefined;
  let gap: [Pt, Pt] | null = null;
  if (side === 'on' && middle !== undefined && middle.trim() !== '' && length > 0) {
    const ux = (r.x - l.x) / length;
    const uy = (r.y - l.y) / length;
    const at = (s: number): Pt => ({ x: l.x + ux * s, y: l.y + uy * s });
    gap = [at(x - pad), at(x + width + pad)];
  }
  return {
    origin: l,
    angle,
    x,
    top,
    lines,
    lineHeight,
    font,
    color: look.color,
    gap,
  };
}

export function drawText(ctx: CanvasRenderingContext2D, layout: TextLayout): void {
  ctx.save();
  ctx.translate(layout.origin.x, layout.origin.y);
  ctx.rotate(layout.angle);
  ctx.font = layout.font;
  ctx.fillStyle = layout.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  layout.lines.forEach((line, i) => {
    ctx.fillText(line, layout.x, layout.top + i * layout.lineHeight);
  });
  ctx.restore();
}

/**
 * A segment with the part between two points on it left out (the text's gap): what's left of
 * it, none to two pieces.
 */
export function cutSegment(segment: readonly [Pt, Pt], gap: readonly [Pt, Pt]): [Pt, Pt][] {
  const [a, b] = segment;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return [[a, b]];
  const t = (p: Pt) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / length;
  const from = Math.min(t(gap[0]), t(gap[1]));
  const to = Math.max(t(gap[0]), t(gap[1]));
  const point = (s: number): Pt => ({ x: a.x + dx * s, y: a.y + dy * s });
  const pieces: [Pt, Pt][] = [];
  if (from > 0) pieces.push([a, point(Math.min(1, from))]);
  if (to < 1) pieces.push([point(Math.max(0, to)), b]);
  return pieces;
}

export interface TimeLabelLook {
  background: string;
  color: string;
  font: string;
  fontSize: number;
}

/**
 * A label on the time axis centred on `x`, kept on the axis, in the shape and size of the
 * crosshair's own (Lightweight Charts 5.2.1's TimeAxisViewRenderer).
 */
export function drawTimeLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  text: string,
  look: TimeLabelLook,
  axisWidth: number,
): void {
  const { fontSize } = look;
  const paddingTop = (3 * fontSize) / 12;
  const paddingX = (9 * fontSize) / 12;
  ctx.save();
  ctx.font = look.font;
  const width = Math.round(ctx.measureText(text).width) + 2 * paddingX;
  let left = Math.floor(x - width / 2) + 0.5;
  if (left < 0) left = 0.5;
  else if (left + width > axisWidth) left = Math.floor(axisWidth - width) + 0.5;
  const height = Math.ceil(TIME_LABEL.border + TIME_LABEL.tick + 2 * paddingTop + fontSize);
  ctx.fillStyle = look.background;
  ctx.beginPath();
  ctx.roundRect(left, 0, width, height, [0, 0, TIME_LABEL.radius, TIME_LABEL.radius]);
  ctx.fill();
  ctx.fillStyle = look.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    text,
    left + paddingX,
    TIME_LABEL.border + TIME_LABEL.tick + paddingTop + fontSize / 2,
  );
  ctx.restore();
}
