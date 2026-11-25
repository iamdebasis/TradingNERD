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
import { along, type Pt } from './geometry';
import {
  cutSegment,
  drawArrowHead,
  drawHandle,
  drawStatsBox,
  drawText,
  drawTimeLabel,
  drawTrendAngle,
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

/** TradingView's vertical alignment says which side of the text meets the line. */
const SIDE_OF: Record<VAlign, TextSide> = { bottom: 'above', middle: 'on', top: 'below' };

/**
 * One pane's user drawings (docs/SPEC.md §6.24), attached to the series whose scale the pane
 * has: the candles on the price pane, an indicator's first plot on its own pane. The pane
 * view paints over the series; the axis views paint under the crosshair's own labels.
 */
export class DrawingLayer implements ISeriesPrimitive<Time> {
  private readonly host: DrawingLayerHost;
  private readonly pane: readonly IPrimitivePaneView[];
  private readonly priceAxis: readonly IPrimitivePaneView[];
  private readonly timeAxis: readonly IPrimitivePaneView[];
  private series: ISeriesApi<SeriesType> | null = null;
  private redraw: (() => void) | null = null;

  constructor(host: DrawingLayerHost) {
    this.host = host;
    this.pane = [{ zOrder: () => 'top', renderer: () => ({ draw: (t) => this.drawPane(t) }) }];
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

  private drawPane(target: DrawTarget): void {
    const pane = this.paneIndex();
    if (pane === null) return;
    const { engine } = this.host;
    const shapes = engine.shapes(pane);
    if (shapes.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const shape of shapes) this.drawShape(ctx, shape);
      // Handles over every line.
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
    });
  }

  private drawShape(ctx: CanvasRenderingContext2D, shape: PlacedShape): void {
    const { drawing, segment } = shape;
    const { style } = drawing;
    const options = TOOL_OPTIONS[drawing.tool];
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
    if (options.stats && segment) this.drawStats(ctx, shape, segment);
  }

  /** Where the drawing's text goes, by tool (the capture's layouts; provisional, §11). */
  private textLayout(ctx: CanvasRenderingContext2D, shape: PlacedShape): TextLayout | null {
    const { drawing, segment, size } = shape;
    const { text } = drawing.style;
    if (!text.value || !shape.own) return null;
    const family = this.host.fontFamily;
    const [point] = shape.points;
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
        const ys = shape.points.map((point) => point?.y ?? null);
        if (drawing.tool === 'vertical-line') continue;
        // A selected drawing's span between its points' prices.
        const [y0, y1] = ys;
        if (selected && y0 !== null && y0 !== undefined && y1 !== null && y1 !== undefined) {
          ctx.fillStyle = withAlpha(style.color, AXIS_BAND);
          ctx.fillRect(0, Math.min(y0, y1), mediaSize.width, Math.abs(y1 - y0));
        }
        const always =
          drawing.tool === 'horizontal-line' ||
          drawing.tool === 'horizontal-ray' ||
          drawing.tool === 'cross-line'
            ? style.showPrice
            : style.showPriceLabels;
        if (!always && !selected) continue;
        drawing.points.forEach((point, i) => {
          const y = ys[i];
          if (y !== null && y !== undefined)
            labels.push({ y, price: point.price, color: style.color });
        });
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
        const xs = shape.points.map((point) => point?.x ?? null);
        const [x0, x1] = xs;
        if (selected && x0 !== null && x0 !== undefined && x1 !== null && x1 !== undefined) {
          ctx.fillStyle = withAlpha(style.color, AXIS_BAND);
          ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), mediaSize.height);
        }
        const always =
          (drawing.tool === 'vertical-line' || drawing.tool === 'cross-line') && style.showTime;
        if (!always && !selected) continue;
        drawing.points.forEach((point, i) => {
          const x = xs[i];
          if (x !== null && x !== undefined)
            labels.push({ x, time: point.time, color: style.color });
        });
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
