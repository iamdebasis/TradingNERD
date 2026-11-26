import { type HAlign, TOOL_OPTIONS, type VAlign } from '@tradingnerd/core';
import type {
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { AXIS_LABEL, type DrawTarget, drawAxisLabel } from '../plugins/axisLabel';
import type { DrawingEngine, PlacedShape } from './DrawingEngine';
import { along, type Pt, type Rect } from './geometry';
import {
  cutSegment,
  drawArrowHead,
  drawHandle,
  drawLabel,
  drawStatsBox,
  drawText,
  drawTimeLabel,
  drawTrendAngle,
  fillArea,
  fontOf,
  layoutText,
  strokeSegments,
  type TextLayout,
  type TextSide,
  textOn,
  withAlpha,
} from './paint';
import { statsRows } from './stats';

/** What a pane's drawing layer needs of the chart around it. */
export interface DrawingLayerHost {
  engine: DrawingEngine;
  /** The chart's background: a handle's fill. */
  background: string;
  fontFamily: string;
  /** The axes' font size, px. */
  fontSize: number;
  /** A price as pane `pane`'s scale writes it. */
  formatPrice(pane: number, price: number): string;
  /** A time (UTC seconds) as the crosshair writes it on the time axis. */
  formatTime(time: number): string;
  /** A pip on pane `pane`: the symbol's tick on the price pane. */
  tickSize(pane: number): number;
  /** Pane y of each tick label on pane `pane`'s price axis, so labels hide those they cover. */
  tickYs(pane: number): readonly number[];
  /** The price axis' background. */
  axisBackground: string;
}

/** A selected drawing's span on the axes: its line's color, this opaque (ours, provisional, §11). */
const AXIS_BAND = 0.25;
/** A line's middle point (provisional, §11). */
const MIDDLE_POINT_RADIUS = 3;
/** Horizontal lines' text sits this far in from their ends (the capture's). */
const H_TEXT_INSET = 3;

/**
 * The box Ctrl/⌘ + drag draws to select: a thin border in the drawings' blue over a light fill of
 * it (ours: TradingView's box isn't measured yet, provisional §11).
 */
const BOX_COLOR = '#2962FF';
const BOX_FILL = 0.1;

/** TradingView's vertical alignment says which side of the text meets the line. */
const SIDE_OF: Record<VAlign, TextSide> = { bottom: 'above', middle: 'on', top: 'below' };

/**
 * From this many drawings standing still round those being moved or placed, the still ones under
 * the lowest moving one and over the highest are painted once into bitmaps of their own and
 * copied each frame: a hundred channels' and pitchforks' bands take too long to paint again at
 * every move (measured in the cloud's software canvas, 2026-11-26: 110 to 126 ms a frame).
 */
const STILL_LAYERS_FROM = 12;

/** The bitmaps: under the moving drawings and over them, for each of the two layers. */
type StillName = 'bottom-under' | 'bottom-over' | 'top-under' | 'top-over';

interface StillLayer {
  canvas: HTMLCanvasElement;
  /** What it was painted from: each drawing, its state and its points, and the bitmap's size. */
  key: string;
}

/**
 * One pane's user drawings (docs/SPEC.md §6.24), attached to the series whose scale the pane
 * has: the candles on the price pane, an indicator's first plot on its own pane. Two pane views:
 * one under the series for the drawings sent under the bars (Visual order, D3a), one over them
 * for the rest, every handle and the selecting box; the axis views paint under the crosshair's
 * own labels.
 */
export class DrawingLayer implements ISeriesPrimitive<Time> {
  private readonly host: DrawingLayerHost;
  private readonly pane: readonly IPrimitivePaneView[];
  private readonly priceAxis: readonly IPrimitivePaneView[];
  private readonly timeAxis: readonly IPrimitivePaneView[];
  private series: ISeriesApi<SeriesType> | null = null;
  private redraw: (() => void) | null = null;
  /** The still drawings under and over those moving, while some do. */
  private readonly still = new Map<StillName, StillLayer>();
  /** A number for each drawing object, so a still layer knows when one changed. */
  private readonly serials = new WeakMap<object, number>();
  private serial = 0;

  constructor(host: DrawingLayerHost) {
    this.host = host;
    this.pane = [
      { zOrder: () => 'bottom', renderer: () => ({ draw: (t) => this.drawPane(t, true) }) },
      { zOrder: () => 'top', renderer: () => ({ draw: (t) => this.drawPane(t, false) }) },
    ];
    this.priceAxis = [
      { zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.drawPriceAxis(t) }) },
    ];
    this.timeAxis = [
      { zOrder: () => 'normal', renderer: () => ({ draw: (t) => this.drawTimeAxis(t) }) },
    ];
  }

  attached({ series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.series = series;
    this.redraw = requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.redraw = null;
  }

  isAttached(): boolean {
    return this.series !== null;
  }

  requestUpdate(): void {
    this.redraw?.();
  }

  /** The pane it's on now (panes move as indicators come and go). */
  paneIndex(): number | null {
    try {
      return this.series?.getPane().paneIndex() ?? null;
    } catch {
      return null;
    }
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.pane;
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.priceAxis;
  }

  timeAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.timeAxis;
  }

  /**
   * The pane's drawings under the bars (`under`) or over them; the upper layer also paints every
   * handle, over every drawing, and the box Ctrl/⌘ + drag is drawing.
   */
  private drawPane(target: DrawTarget, under: boolean): void {
    const pane = this.paneIndex();
    if (pane === null) return;
    const { engine } = this.host;
    const all = engine.shapes(pane);
    const shapes = all.filter((shape) => shape.drawing.below === under);
    const box = under ? null : engine.selectionBox(pane);
    const prefix = under ? 'bottom' : 'top';
    const active = engine.activeIds();
    let first = -1;
    let last = -1;
    if (active) {
      for (const [i, shape] of shapes.entries()) {
        if (!active.has(shape.drawing.id)) continue;
        if (first < 0) first = i;
        last = i;
      }
    }
    const still = shapes.length - (first < 0 ? 0 : last - first + 1);
    if (first < 0 || still < STILL_LAYERS_FROM) {
      this.still.delete(`${prefix}-under`);
      this.still.delete(`${prefix}-over`);
      if (shapes.length === 0 && (under || (all.length === 0 && !box))) return;
      target.useMediaCoordinateSpace(({ context: ctx }) => {
        for (const shape of shapes) this.drawShape(ctx, shape);
        if (!under) this.drawOverlay(ctx, all, box);
      });
      return;
    }
    // Some moving among many: the still ones under the lowest moving drawing and over the highest
    // copied from their bitmaps, those between painted afresh, all in the same order.
    target.useBitmapCoordinateSpace(
      ({ context: ctx, bitmapSize, horizontalPixelRatio: h, verticalPixelRatio: v }) => {
        const below = this.stillLayer(`${prefix}-under`, shapes.slice(0, first), bitmapSize, h, v);
        const above = this.stillLayer(`${prefix}-over`, shapes.slice(last + 1), bitmapSize, h, v);
        if (below) ctx.drawImage(below, 0, 0);
        ctx.save();
        ctx.scale(h, v);
        for (const shape of shapes.slice(first, last + 1)) this.drawShape(ctx, shape);
        ctx.restore();
        if (above) ctx.drawImage(above, 0, 0);
        if (under) return;
        ctx.save();
        ctx.scale(h, v);
        this.drawOverlay(ctx, all, box);
        ctx.restore();
      },
    );
  }

  /** Over every drawing: the handles, then the selecting box. */
  private drawOverlay(
    ctx: CanvasRenderingContext2D,
    shapes: readonly PlacedShape[],
    box: Rect | null,
  ): void {
    this.drawHandles(ctx, shapes);
    if (!box) return;
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    ctx.save();
    ctx.fillStyle = withAlpha(BOX_COLOR, BOX_FILL);
    ctx.fillRect(box.left, box.top, width, height);
    ctx.strokeStyle = BOX_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(box.left) + 0.5,
      Math.round(box.top) + 0.5,
      Math.round(width),
      Math.round(height),
    );
    ctx.restore();
  }

  /** Handles over every line: a selected drawing's, a hovered one's. */
  private drawHandles(ctx: CanvasRenderingContext2D, shapes: readonly PlacedShape[]): void {
    const { engine } = this.host;
    const hovered = engine.hoveredHandle();
    for (const shape of shapes) {
      if (!engine.showsHandles(shape.drawing)) continue;
      const selected = engine.isSelected(shape.drawing.id);
      for (const handle of shape.handles) {
        drawHandle(ctx, handle, {
          square: handle.square,
          fill: this.host.background,
          selected,
          hovered: hovered?.id === shape.drawing.id && hovered.point === handle.point,
        });
      }
    }
  }

  /** The still drawings under (or over) the moving ones, painted once while they stay so. */
  private stillLayer(
    which: StillName,
    shapes: readonly PlacedShape[],
    size: { width: number; height: number },
    h: number,
    v: number,
  ): HTMLCanvasElement | null {
    if (shapes.length === 0) return null;
    const { engine } = this.host;
    const key = [
      size.width,
      size.height,
      h,
      v,
      ...shapes.map((shape) => {
        const { drawing } = shape;
        const state = `${engine.isSelected(drawing.id) ? 's' : ''}${engine.isHovered(drawing.id) ? 'h' : ''}`;
        const at = shape.points.map((point) => (point ? `${point.x},${point.y}` : '-')).join(';');
        return `${this.serialOf(drawing)}${state}:${at}`;
      }),
    ].join('|');
    const kept = this.still.get(which);
    if (kept?.key === key) return kept.canvas;
    const canvas = kept?.canvas ?? document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(h, 0, 0, v, 0, 0);
    for (const shape of shapes) this.drawShape(ctx, shape);
    this.still.set(which, { canvas, key });
    return canvas;
  }

  private serialOf(drawing: object): number {
    let serial = this.serials.get(drawing);
    if (serial === undefined) {
      serial = ++this.serial;
      this.serials.set(drawing, serial);
    }
    return serial;
  }

  private drawShape(ctx: CanvasRenderingContext2D, shape: PlacedShape): void {
    const { drawing, segment } = shape;
    const { style } = drawing;
    const options = TOOL_OPTIONS[drawing.tool];
    // A channel's or pitchfork's bands under its lines, its levels under its main lines.
    for (const fill of shape.fills) fillArea(ctx, fill.points, fill.color, fill.opacity);
    for (const look of shape.looks) strokeSegments(ctx, [[look.a, look.b]], look);
    const text = options.text ? this.textLayout(ctx, shape) : null;
    const lines = text?.gap
      ? shape.lines.flatMap((line) => cutSegment(line, text.gap as [Pt, Pt]))
      : shape.lines;
    strokeSegments(ctx, lines, style);
    for (const [tip, from] of shape.arrows) {
      drawArrowHead(ctx, tip, from, style.color, style.width);
    }
    if (drawing.tool === 'trend-angle' && segment) {
      const { size, bold, italic } = style.text;
      const font = fontOf(size, this.host.fontFamily, bold, italic);
      drawTrendAngle(ctx, segment[0], segment[1], style.color, font, size);
    }
    if (options.middlePoint && style.showMiddlePoint && segment) {
      const middle = along(segment[0], segment[1], 0.5);
      ctx.save();
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(middle.x, middle.y, MIDDLE_POINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (text) drawText(ctx, text);
    if (shape.label) {
      const { at, text: value, color, size } = shape.label;
      drawLabel(ctx, at, value, color, fontOf(size, this.host.fontFamily));
    }
    if (options.stats && segment) this.drawStats(ctx, shape, segment);
  }

  /** Where the drawing's text goes, by tool (the capture's layouts; provisional, §11). */
  private textLayout(ctx: CanvasRenderingContext2D, shape: PlacedShape): TextLayout | null {
    const { drawing, segment, size, frame } = shape;
    const { text } = drawing.style;
    if (!text.value || !shape.own) return null;
    const family = this.host.fontFamily;
    const [point] = shape.points;
    if (frame) {
      // A channel's text (TradingView's blog, 21 August 2023: Top, Inside or Bottom; left,
      // centre or right): over its upper line, between its lines, or under its lower one. Its
      // lines stay whole (provisional, §11).
      const { upper, lower } = frame;
      const inside: [Pt, Pt] = [along(upper[0], lower[0], 0.5), along(upper[1], lower[1], 0.5)];
      const [line, side]: [[Pt, Pt], TextSide] =
        text.alignV === 'top'
          ? [upper, 'above']
          : text.alignV === 'middle'
            ? [inside, 'on']
            : [lower, 'below'];
      const layout = layoutText(ctx, line[0], line[1], text, family, text.alignH, side);
      return layout ? { ...layout, gap: null } : null;
    }
    switch (drawing.tool) {
      case 'horizontal-line':
      case 'horizontal-ray': {
        if (!point) return null;
        const from = drawing.tool === 'horizontal-ray' ? point.x : 0;
        return layoutText(
          ctx,
          { x: from, y: point.y },
          { x: size.width, y: point.y },
          text,
          family,
          text.alignH,
          SIDE_OF[text.alignV],
          H_TEXT_INSET,
        );
      }
      case 'vertical-line': {
        if (!point) return null;
        // Turned to read upwards: along the line is the vertical alignment, the side the
        // horizontal one.
        const alongLine: Record<VAlign, HAlign> = {
          top: 'right',
          middle: 'center',
          bottom: 'left',
        };
        const side: Record<HAlign, TextSide> = { left: 'above', center: 'on', right: 'below' };
        return layoutText(
          ctx,
          { x: point.x, y: size.height },
          { x: point.x, y: 0 },
          text,
          family,
          alongLine[text.alignV],
          side[text.alignH],
        );
      }
      default:
        if (!segment) return null;
        return layoutText(
          ctx,
          segment[0],
          segment[1],
          text,
          family,
          text.alignH,
          SIDE_OF[text.alignV],
        );
    }
  }

  /** The stats box: always when the drawing asks, else while it's selected or hovered. */
  private drawStats(ctx: CanvasRenderingContext2D, shape: PlacedShape, segment: [Pt, Pt]): void {
    const { engine } = this.host;
    const { drawing } = shape;
    const { style } = drawing;
    const shown =
      style.alwaysShowStats || engine.isSelected(drawing.id) || engine.isHovered(drawing.id);
    const [from, to] = drawing.points;
    if (!shown || !from || !to) return;
    const [a, b] = segment;
    const rows = statsRows({
      from,
      to,
      a,
      b,
      bars: engine.logicalOf(to.time) - engine.logicalOf(from.time),
      stats: style.stats,
      formatPrice: (value) => this.host.formatPrice(shape.pane, value),
      tickSize: this.host.tickSize(shape.pane),
    });
    if (rows.length === 0) return;
    const at =
      style.statsPosition === 'left' ? a : style.statsPosition === 'right' ? b : along(a, b, 0.5);
    // Off the line: above where it runs down to the right (or up to the left), else below.
    const above = (b.x - a.x) * (b.y - a.y) > 0;
    drawStatsBox(ctx, at, rows, above, this.host.fontFamily);
  }

  private drawPriceAxis(target: DrawTarget): void {
    const pane = this.paneIndex();
    if (pane === null) return;
    const { engine } = this.host;
    const shapes = engine.shapes(pane).filter((shape) => shape.own);
    if (shapes.length === 0) return;
    const font = fontOf(this.host.fontSize, this.host.fontFamily);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const labels: { y: number; price: number; color: string }[] = [];
      for (const shape of shapes) {
        const { drawing } = shape;
        const { style } = drawing;
        const selected = engine.isSelected(drawing.id);
        if (drawing.tool === 'vertical-line') continue;
        // A selected drawing's span between its lowest and highest marked prices.
        const ys = shape.axis.flatMap((point) => (point.y === null ? [] : [point.y]));
        if (selected && ys.length >= 2) {
          const top = Math.min(...ys);
          ctx.fillStyle = withAlpha(style.color, AXIS_BAND);
          ctx.fillRect(0, top, mediaSize.width, Math.max(...ys) - top);
        }
        const always =
          drawing.tool === 'horizontal-line' ||
          drawing.tool === 'horizontal-ray' ||
          drawing.tool === 'cross-line'
            ? style.showPrice
            : style.showPriceLabels;
        if (!always && !selected) continue;
        for (const point of shape.axis) {
          if (point.y !== null) labels.push({ y: point.y, price: point.price, color: style.color });
        }
      }
      const mask = {
        tickYs: this.host.tickYs(pane),
        background: this.host.axisBackground,
        axisWidth: mediaSize.width,
      };
      for (const label of labels) {
        drawAxisLabel(
          ctx,
          label.y,
          [this.host.formatPrice(pane, label.price)],
          {
            background: label.color,
            color: textOn(label.color),
            font,
            rowHeight: AXIS_LABEL.priceRowHeight,
          },
          mask,
        );
      }
    });
  }

  private drawTimeAxis(target: DrawTarget): void {
    const pane = this.paneIndex();
    if (pane === null) return;
    const { engine } = this.host;
    const shapes = engine.shapes(pane).filter((shape) => shape.own);
    if (shapes.length === 0) return;
    const { fontSize } = this.host;
    const font = fontOf(fontSize, this.host.fontFamily);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const labels: { x: number; time: number; color: string }[] = [];
      for (const shape of shapes) {
        const { drawing } = shape;
        const { style } = drawing;
        if (drawing.tool === 'horizontal-line') continue;
        const selected = engine.isSelected(drawing.id);
        // A selected drawing's span between its first and last marked times.
        const xs = shape.axis.flatMap((point) => (point.x === null ? [] : [point.x]));
        if (selected && xs.length >= 2) {
          const left = Math.min(...xs);
          ctx.fillStyle = withAlpha(style.color, AXIS_BAND);
          ctx.fillRect(left, 0, Math.max(...xs) - left, mediaSize.height);
        }
        const always =
          (drawing.tool === 'vertical-line' || drawing.tool === 'cross-line') && style.showTime;
        if (!always && !selected) continue;
        // A channel's corners share their bars: one label each.
        const seen = new Set<number>();
        for (const point of shape.axis) {
          if (point.x === null || seen.has(point.time)) continue;
          seen.add(point.time);
          labels.push({ x: point.x, time: point.time, color: style.color });
        }
      }
      for (const label of labels) {
        drawTimeLabel(
          ctx,
          label.x,
          this.host.formatTime(label.time),
          { background: label.color, color: textOn(label.color), font, fontSize },
          mediaSize.width,
        );
      }
    });
  }
}
