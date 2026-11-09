import {
  type BoxObject,
  colorCss,
  type DrawingSnapshot,
  EMPTY_DRAWINGS,
  type LabelObject,
  type LineObject,
  type PolylineObject,
  type TableCell,
  type TableObject,
} from '@tradingnerd/pine';
import type {
  IChartApi,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { DrawTarget } from './axisLabel';
import type { BarExtent } from './MarksPrimitive';

/**
 * A script's drawings on its pane (Pine docs: Text and shapes, Lines and boxes, Tables,
 * Polylines): labels, lines, boxes, polylines and linefills where their bars and prices are,
 * tables fixed at the pane's corners and edges. Sizes and padding TradingView doesn't document
 * are provisional (docs/SPEC.md §11), to be measured from the user's screenshots.
 */

/** What the chart knows that drawings need: its bars' times (seconds), highs and lows. */
export interface DrawingFrame {
  times: readonly number[];
  bars: BarExtent;
}

/** A text size's pixels: size.* by name, or v6's number of points (provisional). */
export function textPx(size: unknown, auto = 12): number {
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) return (size * 4) / 3;
  switch (size) {
    case 'tiny':
      return 8;
    case 'small':
      return 10;
    case 'large':
      return 16;
    case 'huge':
      return 24;
    case 'auto':
      return auto;
    default:
      return 12;
  }
}

/** A shape's box for a label's shape styles, by size (provisional, as plotshape's). */
const SHAPE_PX: Record<string, number> = {
  tiny: 8,
  small: 12,
  normal: 16,
  large: 24,
  huge: 32,
  auto: 12,
};

/** Between a bar's high or low and a label above or below it. */
const GAP = 4;
/** A label bubble's padding, corner and pointer (provisional). */
const PAD_X = 6;
const PAD_Y = 4;
const RADIUS = 2;
const POINTER = 6;
/** Between the pane's edge and a table. */
const TABLE_MARGIN = 0;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 3;

const css = (color: number): string | null => (Number.isNaN(color) ? null : colorCss(color));

/** Where bar `x` (by xloc) is on the time scale: a logical index, fractional between bars. */
export function logicalOf(x: number, xloc: string, times: readonly number[]): number | null {
  if (!Number.isFinite(x)) return null;
  if (xloc !== 'bar_time') return x;
  const n = times.length;
  if (n === 0) return null;
  const t = x / 1000;
  if (n === 1) return t >= (times[0] as number) ? 0 : null;
  const first = times[0] as number;
  const last = times[n - 1] as number;
  const step = last - (times[n - 2] as number) || 1;
  if (t >= last) return n - 1 + (t - last) / step;
  if (t <= first) return (t - first) / ((times[1] as number) - first || 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  const a = times[lo] as number;
  const b = times[hi] as number;
  return lo + (b > a ? (t - a) / (b - a) : 0);
}

const dashes = (style: string, width: number): number[] =>
  style === 'dotted' ? [width, width * 2] : style === 'dashed' ? [width * 4, width * 3] : [];

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private readonly views: readonly IPrimitivePaneView[];
  private readonly family: string;
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private drawings: DrawingSnapshot = EMPTY_DRAWINGS;
  private frame: DrawingFrame | null = null;
  /** What the last frame painted of each kind (off-screen and at-na ones aren't). */
  private painted = { labels: 0, lines: 0, boxes: 0, tables: 0, polylines: 0, linefills: 0 };

  /**
   * Where a price is on the pane. The series it's attached to may have no values (a script that
   * only draws), and such a series gives no place for a price: the chart's library needs a
   * series with values on the same scale.
   */
  private readonly priceToY: ((price: number) => number | null) | null;

  /** `font`: the chart's, e.g. "12px -apple-system, …"; its family writes the text. */
  constructor(font: string, priceToY: ((price: number) => number | null) | null = null) {
    this.priceToY = priceToY;
    this.family = font.replace(/^\s*\d+(\.\d+)?px\s*/, '');
    this.views = [{ zOrder: () => 'top', renderer: () => ({ draw: (t) => this.draw(t) }) }];
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  update(drawings: DrawingSnapshot, frame: DrawingFrame): void {
    this.drawings = drawings;
    this.frame = frame;
    this.requestUpdate?.();
  }

  /** The drawings it holds (for tests and diagnostics). */
  current(): DrawingSnapshot {
    return this.drawings;
  }

  /** How many of each kind the last frame painted (for tests and diagnostics). */
  paintedCounts(): Readonly<typeof this.painted> {
    return { ...this.painted };
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private font(px: number, formatting = 0, family = 'default'): string {
    const face = family === 'monospace' ? 'ui-monospace, Menlo, Consolas, monospace' : this.family;
    return `${formatting & 2 ? 'italic ' : ''}${formatting & 1 ? 'bold ' : ''}${px}px ${face}`;
  }

  private xOf(x: number, xloc: string): number | null {
    const { chart, frame } = this;
    if (!chart || !frame) return null;
    const logical = logicalOf(x, xloc, frame.times);
    if (logical === null) return null;
    return chart.timeScale().logicalToCoordinate(logical as Logical);
  }

  private yOf(price: number): number | null {
    if (!this.series || !Number.isFinite(price)) return null;
    return this.priceToY?.(price) ?? this.series.priceToCoordinate(price);
  }

  private draw(target: DrawTarget): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const { width, height } = mediaSize;
      const d = this.drawings;
      this.painted = { labels: 0, lines: 0, boxes: 0, tables: 0, polylines: 0, linefills: 0 };
      ctx.save();
      for (const fill of d.linefills)
        this.drawLinefill(ctx, fill.line1, fill.line2, fill.color, width);
      for (const box of d.boxes) this.drawBox(ctx, box, width);
      for (const line of d.lines) this.drawLine(ctx, line, width);
      for (const poly of d.polylines) this.drawPolyline(ctx, poly);
      for (const label of d.labels) this.drawLabel(ctx, label);
      // One table per position: the latest made there (Pine docs, Limitations: nine tables).
      const byPosition = new Map<string, TableObject>();
      for (const table of d.tables) byPosition.set(table.position, table);
      for (const table of byPosition.values()) this.drawTable(ctx, table, width, height);
      ctx.restore();
    });
  }

  /** A line's two ends on screen, carried to the pane's edges when it extends. */
  private lineEnds(line: LineObject, width: number): [number, number, number, number] | null {
    const x1 = this.xOf(line.x1, line.xloc);
    const x2 = this.xOf(line.x2, line.xloc);
    const y1 = this.yOf(line.y1);
    const y2 = this.yOf(line.y2);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return null;
    let [ax, ay, bx, by] = [x1, y1, x2, y2];
    const slope = bx !== ax ? (by - ay) / (bx - ax) : 0;
    const left = line.extend === 'left' || line.extend === 'both';
    const right = line.extend === 'right' || line.extend === 'both';
    // The line runs from its first point toward its second: extend.right carries it on past the
    // second, extend.left back past the first (the v6 reference, extend.*).
    const forward = bx >= ax;
    if (right && bx !== ax) {
      const nx = forward ? width : 0;
      by = by + slope * (nx - bx);
      bx = nx;
    } else if (right && bx === ax) {
      by = by >= ay ? 1e6 : -1e6;
    }
    if (left && bx !== ax) {
      const nx = forward ? 0 : width;
      ay = ay + slope * (nx - ax);
      ax = nx;
    }
    return [ax, ay, bx, by];
  }

  private drawLine(ctx: CanvasRenderingContext2D, line: LineObject, width: number): void {
    const color = css(line.color);
    if (!color) return;
    const ends = this.lineEnds(line, width);
    if (!ends) return;
    const [ax, ay, bx, by] = ends;
    this.painted.lines++;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = line.width;
    ctx.setLineDash(dashes(line.style, line.width));
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    const head = (fx: number, fy: number, tx: number, ty: number) => {
      const angle = Math.atan2(ty - fy, tx - fx);
      const size = 6 + line.width * 2;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(
        tx - size * Math.cos(angle - Math.PI / 7),
        ty - size * Math.sin(angle - Math.PI / 7),
      );
      ctx.lineTo(
        tx - size * Math.cos(angle + Math.PI / 7),
        ty - size * Math.sin(angle + Math.PI / 7),
      );
      ctx.closePath();
      ctx.fill();
    };
    if (line.style === 'arrow_right' || line.style === 'arrow_both') head(ax, ay, bx, by);
    if (line.style === 'arrow_left' || line.style === 'arrow_both') head(bx, by, ax, ay);
    ctx.restore();
  }

  private drawLinefill(
    ctx: CanvasRenderingContext2D,
    a: LineObject,
    b: LineObject,
    color: number,
    width: number,
  ): void {
    const fill = css(color);
    if (!fill) return;
    const p = this.lineEnds(a, width);
    const q = this.lineEnds(b, width);
    if (!p || !q) return;
    this.painted.linefills++;
    ctx.save();
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineTo(q[2], q[3]);
    ctx.lineTo(q[0], q[1]);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawBox(ctx: CanvasRenderingContext2D, box: BoxObject, width: number): void {
    let left = this.xOf(box.left, box.xloc);
    let right = this.xOf(box.right, box.xloc);
    const top = this.yOf(box.top);
    const bottom = this.yOf(box.bottom);
    if (left === null || right === null || top === null || bottom === null) return;
    if (box.extend === 'left' || box.extend === 'both')
      left = Math.min(left, right) === left ? 0 : left;
    if (box.extend === 'right' || box.extend === 'both') right = width;
    const x = Math.min(left, right);
    const y = Math.min(top, bottom);
    const w = Math.abs(right - left);
    const h = Math.abs(bottom - top);
    this.painted.boxes++;
    ctx.save();
    const bg = css(box.bgcolor);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(x, y, w, h);
    }
    const border = css(box.borderColor);
    if (border && box.borderWidth > 0) {
      ctx.strokeStyle = border;
      ctx.lineWidth = box.borderWidth;
      ctx.setLineDash(dashes(box.borderStyle, box.borderWidth));
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    const color = css(box.textColor);
    if (box.text && color) {
      // size.auto fits the box: the text's height a share of the box's, 8 to 24 px (provisional).
      const px =
        box.textSize === 'auto'
          ? Math.max(8, Math.min(24, Math.floor(h / 3)))
          : textPx(box.textSize);
      ctx.font = this.font(px, box.formatting, box.font);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const lines =
        box.textWrap === 'auto'
          ? wrap(ctx, box.text, Math.max(10, w - 2 * CELL_PAD_X))
          : box.text.split('\n');
      this.textBlock(
        ctx,
        lines,
        px,
        x + CELL_PAD_X,
        y + CELL_PAD_Y,
        w - 2 * CELL_PAD_X,
        h - 2 * CELL_PAD_Y,
        box.textHalign,
        box.textValign,
      );
    }
    ctx.restore();
  }

  /** Lines of text in a rectangle, aligned left, center or right and top, center or bottom. */
  private textBlock(
    ctx: CanvasRenderingContext2D,
    lines: readonly string[],
    px: number,
    x: number,
    y: number,
    w: number,
    h: number,
    halign: string,
    valign: string,
  ): void {
    const lineHeight = Math.round(px * 1.25);
    const total = lines.length * lineHeight;
    const top = valign === 'top' ? y : valign === 'bottom' ? y + h - total : y + (h - total) / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = halign === 'left' ? 'left' : halign === 'right' ? 'right' : 'center';
    const tx = halign === 'left' ? x : halign === 'right' ? x + w : x + w / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, tx, top + i * lineHeight + lineHeight / 2);
    });
  }

  private drawPolyline(ctx: CanvasRenderingContext2D, poly: PolylineObject): void {
    const pts: [number, number][] = [];
    for (const p of poly.points) {
      const x = this.xOf(p.x, poly.xloc);
      const y = this.yOf(p.y);
      if (x !== null && y !== null) pts.push([x, y]);
    }
    if (pts.length < 2) return;
    this.painted.polylines++;
    ctx.save();
    ctx.beginPath();
    const [fx, fy] = pts[0] as [number, number];
    ctx.moveTo(fx, fy);
    if (poly.curved && pts.length > 2) {
      // A smooth curve through every point: each segment a quadratic toward the next midpoint.
      for (let i = 1; i < pts.length - 1; i++) {
        const [cx, cy] = pts[i] as [number, number];
        const [nx, ny] = pts[i + 1] as [number, number];
        ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
      }
      const [lx, ly] = pts[pts.length - 1] as [number, number];
      ctx.lineTo(lx, ly);
    } else {
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
    }
    if (poly.closed) ctx.closePath();
    const fill = css(poly.fillColor);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    const stroke = css(poly.lineColor);
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = poly.lineWidth;
      ctx.setLineDash(dashes(poly.lineStyle, poly.lineWidth));
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLabel(ctx: CanvasRenderingContext2D, label: LabelObject): void {
    const x = this.xOf(label.x, label.xloc);
    if (x === null) return;
    const frame = this.frame;
    const bar = Math.round(
      label.xloc === 'bar_time'
        ? (logicalOf(label.x, label.xloc, frame?.times ?? []) ?? -1)
        : label.x,
    );
    let y: number | null;
    let style = label.style;
    if (label.yloc === 'abovebar') {
      const high = this.yOf(frame?.bars.high(bar) ?? Number.NaN);
      y = high === null ? null : high - GAP;
      // Above the bar, a bubble points down at it; below, up (the v6 reference, yloc.*).
      if (style === 'label_up') style = 'label_down';
    } else if (label.yloc === 'belowbar') {
      const low = this.yOf(frame?.bars.low(bar) ?? Number.NaN);
      y = low === null ? null : low + GAP;
      if (style === 'label_down') style = 'label_up';
    } else {
      y = this.yOf(label.y);
    }
    if (y === null) return;
    const px = textPx(label.size);
    this.painted.labels++;
    ctx.save();
    ctx.font = this.font(px, label.formatting, label.font);
    const lines = label.text === '' ? [] : label.text.split('\n');
    const lineHeight = Math.round(px * 1.25);
    const textW = lines.reduce((m, line) => Math.max(m, ctx.measureText(line).width), 0);
    const textH = lines.length * lineHeight;
    const color = css(label.color);
    const textColor = css(label.textcolor);
    const bubble = style.startsWith('label_');
    if (bubble) {
      const w = Math.max(textW + 2 * PAD_X, lines.length ? 0 : 2 * PAD_X);
      const h = Math.max(textH + 2 * PAD_Y, lines.length ? 0 : 2 * PAD_Y);
      let bx = x - w / 2;
      let by = y - h / 2;
      const tail: [number, number][] = [];
      switch (style) {
        case 'label_down':
          by = y - POINTER - h;
          tail.push([x - POINTER, by + h], [x, y], [x + POINTER, by + h]);
          break;
        case 'label_up':
          by = y + POINTER;
          tail.push([x - POINTER, by], [x, y], [x + POINTER, by]);
          break;
        case 'label_left':
          bx = x + POINTER;
          tail.push([bx, y - POINTER], [x, y], [bx, y + POINTER]);
          break;
        case 'label_right':
          bx = x - POINTER - w;
          tail.push([bx + w, y - POINTER], [x, y], [bx + w, y + POINTER]);
          break;
        case 'label_lower_left':
          bx = x;
          by = y - h;
          break;
        case 'label_lower_right':
          bx = x - w;
          by = y - h;
          break;
        case 'label_upper_left':
          bx = x;
          by = y;
          break;
        case 'label_upper_right':
          bx = x - w;
          by = y;
          break;
        default:
          break;
      }
      if (color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        roundRect(ctx, bx, by, w, h, RADIUS);
        ctx.fill();
        if (tail.length) {
          ctx.beginPath();
          ctx.moveTo(...(tail[0] as [number, number]));
          for (const pt of tail.slice(1)) ctx.lineTo(...pt);
          ctx.closePath();
          ctx.fill();
        }
      }
      if (textColor && lines.length) {
        ctx.fillStyle = textColor;
        this.textBlock(
          ctx,
          lines,
          px,
          bx + PAD_X,
          by + PAD_Y,
          w - 2 * PAD_X,
          h - 2 * PAD_Y,
          label.textalign,
          'center',
        );
      }
      ctx.restore();
      return;
    }
    if (style === 'none' || style === 'text_outline') {
      if (style === 'text_outline' && color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        lines.forEach((line, i) => {
          ctx.strokeText(line, x, y - textH / 2 + i * lineHeight + lineHeight / 2);
        });
      }
      if (textColor && lines.length) {
        ctx.fillStyle = textColor;
        this.textBlock(
          ctx,
          lines,
          px,
          x - textW / 2,
          y - textH / 2,
          textW,
          textH,
          label.textalign,
          'center',
        );
      }
      ctx.restore();
      return;
    }
    // A shape at the point, its text above it (below for the shapes that point up).
    const size = SHAPE_PX[typeof label.size === 'string' ? label.size : 'normal'] ?? 16;
    if (color) drawShape(ctx, style, x, y, size, color);
    if (textColor && lines.length) {
      ctx.fillStyle = textColor;
      const below = style === 'triangleup' || style === 'arrowup';
      const ty = below ? y + size / 2 + 2 : y - size / 2 - 2 - textH;
      this.textBlock(ctx, lines, px, x - textW / 2, ty, textW, textH, label.textalign, 'center');
    }
    ctx.restore();
  }

  private drawTable(
    ctx: CanvasRenderingContext2D,
    table: TableObject,
    paneW: number,
    paneH: number,
  ): void {
    const { columns, rows } = table;
    if (columns <= 0 || rows <= 0) return;
    const border = table.borderWidth;
    const frame = table.frameWidth;
    // Covered by a merge: drawn by the merge's first cell.
    const covered = new Set<string>();
    const spans = new Map<string, { cols: number; rows: number }>();
    for (const m of table.merges) {
      spans.set(`${m.c0},${m.r0}`, { cols: m.c1 - m.c0 + 1, rows: m.r1 - m.r0 + 1 });
      for (let r = m.r0; r <= m.r1; r++)
        for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(`${c},${r}`);
    }
    // Each column's width and row's height: the widest cell, or the cell's own share of the pane.
    const colW = Array.from({ length: columns }, () => 0);
    const rowH = Array.from({ length: rows }, () => 0);
    const cellOf = (c: number, r: number): TableCell | null => table.cells[r]?.[c] ?? null;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const cell = cellOf(c, r);
        if (!cell || covered.has(`${c},${r}`)) continue;
        const px = textPx(cell.textSize);
        ctx.font = this.font(px, cell.formatting, cell.font);
        const lines = cell.text.split('\n');
        const textW = lines.reduce((m, line) => Math.max(m, ctx.measureText(line).width), 0);
        const w = cell.width > 0 ? (cell.width / 100) * paneW : textW + 2 * CELL_PAD_X;
        const h =
          cell.height > 0
            ? (cell.height / 100) * paneH
            : lines.length * Math.round(px * 1.25) + 2 * CELL_PAD_Y;
        const span = spans.get(`${c},${r}`);
        if (!span || span.cols === 1) colW[c] = Math.max(colW[c] as number, w);
        if (!span || span.rows === 1) rowH[r] = Math.max(rowH[r] as number, h);
      }
    }
    const tableW = colW.reduce((a, b) => a + b, 0) + border * (columns - 1) + 2 * frame;
    const tableH = rowH.reduce((a, b) => a + b, 0) + border * (rows - 1) + 2 * frame;
    if (tableW <= 0 || tableH <= 0) return;
    const [v, h] = table.position.split('_') as [string, string];
    const x0 =
      h === 'left'
        ? TABLE_MARGIN
        : h === 'right'
          ? paneW - tableW - TABLE_MARGIN
          : (paneW - tableW) / 2;
    const y0 =
      v === 'top'
        ? TABLE_MARGIN
        : v === 'bottom'
          ? paneH - tableH - TABLE_MARGIN
          : (paneH - tableH) / 2;
    this.painted.tables++;
    ctx.save();
    const bg = css(table.bgcolor);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(x0, y0, tableW, tableH);
    }
    const colX = (c: number) =>
      x0 + frame + colW.slice(0, c).reduce((a, b) => a + b, 0) + border * c;
    const rowY = (r: number) =>
      y0 + frame + rowH.slice(0, r).reduce((a, b) => a + b, 0) + border * r;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        if (covered.has(`${c},${r}`)) continue;
        const cell = cellOf(c, r);
        const span = spans.get(`${c},${r}`) ?? { cols: 1, rows: 1 };
        const x = colX(c);
        const y = rowY(r);
        const w =
          colX(Math.min(columns, c + span.cols)) - x - (c + span.cols < columns ? border : 0);
        const hh = rowY(Math.min(rows, r + span.rows)) - y - (r + span.rows < rows ? border : 0);
        const cw = c + span.cols >= columns ? x0 + tableW - frame - x : w;
        const ch = r + span.rows >= rows ? y0 + tableH - frame - y : hh;
        if (!cell) continue;
        const cellBg = css(cell.bgcolor);
        if (cellBg) {
          ctx.fillStyle = cellBg;
          ctx.fillRect(x, y, cw, ch);
        }
        const color = css(cell.textColor);
        if (cell.text && color) {
          const px = textPx(cell.textSize);
          ctx.font = this.font(px, cell.formatting, cell.font);
          ctx.fillStyle = color;
          this.textBlock(
            ctx,
            cell.text.split('\n'),
            px,
            x + CELL_PAD_X,
            y + CELL_PAD_Y,
            cw - 2 * CELL_PAD_X,
            ch - 2 * CELL_PAD_Y,
            cell.textHalign,
            cell.textValign,
          );
        }
      }
    }
    const borderColor = css(table.borderColor);
    if (borderColor && border > 0) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = border;
      for (let c = 1; c < columns; c++) {
        const x = colX(c) - border / 2;
        ctx.beginPath();
        ctx.moveTo(x, y0 + frame);
        ctx.lineTo(x, y0 + tableH - frame);
        ctx.stroke();
      }
      for (let r = 1; r < rows; r++) {
        const y = rowY(r) - border / 2;
        ctx.beginPath();
        ctx.moveTo(x0 + frame, y);
        ctx.lineTo(x0 + tableW - frame, y);
        ctx.stroke();
      }
    }
    const frameColor = css(table.frameColor);
    if (frameColor && frame > 0) {
      ctx.strokeStyle = frameColor;
      ctx.lineWidth = frame;
      ctx.strokeRect(x0 + frame / 2, y0 + frame / 2, tableW - frame, tableH - frame);
    }
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Words wrapped to a width (text.wrap_auto). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** A label's shape styles (circle, square, diamond, triangles, arrows, crosses, flag). */
function drawShape(
  ctx: CanvasRenderingContext2D,
  style: string,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const h = size / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, size / 8);
  ctx.beginPath();
  switch (style) {
    case 'circle':
      ctx.arc(x, y, h, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'square':
      ctx.fillRect(x - h, y - h, size, size);
      return;
    case 'diamond':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x - h, y);
      ctx.closePath();
      ctx.fill();
      return;
    case 'triangleup':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.lineTo(x - h, y + h);
      ctx.closePath();
      ctx.fill();
      return;
    case 'triangledown':
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + h, y - h);
      ctx.lineTo(x - h, y - h);
      ctx.closePath();
      ctx.fill();
      return;
    case 'arrowup':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h * 0.8, y);
      ctx.lineTo(x + h * 0.3, y);
      ctx.lineTo(x + h * 0.3, y + h);
      ctx.lineTo(x - h * 0.3, y + h);
      ctx.lineTo(x - h * 0.3, y);
      ctx.lineTo(x - h * 0.8, y);
      ctx.closePath();
      ctx.fill();
      return;
    case 'arrowdown':
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + h * 0.8, y);
      ctx.lineTo(x + h * 0.3, y);
      ctx.lineTo(x + h * 0.3, y - h);
      ctx.lineTo(x - h * 0.3, y - h);
      ctx.lineTo(x - h * 0.3, y);
      ctx.lineTo(x - h * 0.8, y);
      ctx.closePath();
      ctx.fill();
      return;
    case 'cross':
      ctx.moveTo(x - h, y);
      ctx.lineTo(x + h, y);
      ctx.moveTo(x, y - h);
      ctx.lineTo(x, y + h);
      ctx.stroke();
      return;
    case 'xcross':
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.moveTo(x + h, y - h);
      ctx.lineTo(x - h, y + h);
      ctx.stroke();
      return;
    case 'flag':
      ctx.moveTo(x - h * 0.6, y + h);
      ctx.lineTo(x - h * 0.6, y - h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - h * 0.6, y - h);
      ctx.lineTo(x + h, y - h * 0.5);
      ctx.lineTo(x - h * 0.6, y);
      ctx.closePath();
      ctx.fill();
      return;
    default:
      ctx.arc(x, y, h, 0, Math.PI * 2);
      ctx.fill();
  }
}
