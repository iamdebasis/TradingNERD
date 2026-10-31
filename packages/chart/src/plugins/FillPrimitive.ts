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

/** One side of a band: a plot's value on each bar, or a fixed price. */
export type BandEdge = ArrayLike<number> | number;

/**
 * Pine's gradient fill: `topColor` at price `top`, `bottomColor` at `bottom`, in a straight line
 * between, and the end colors beyond them (a canvas gradient's own rule).
 */
export interface GradientPaint {
  top: number;
  bottom: number;
  topColor: string;
  bottomColor: string;
}

/** A script's fill whose color changes from bar to bar: its color at each bar, or none. */
export interface BarColors {
  at(i: number): string | null;
}

/**
 * A fill between two levels, or between two edges from bar `start` on (Pine's `fill`), by its
 * fill's id.
 */
export type FillShape =
  | { id: string; kind: 'levels'; from: number; to: number; color: string }
  | {
      id: string;
      kind: 'plots';
      upper: BandEdge;
      lower: BandEdge;
      start: number;
      color: string | GradientPaint | BarColors;
    };

/**
 * An indicator's fills, drawn behind its lines (Pine's z-order puts fills under plots and levels):
 * RSI's background between its upper and lower bands, its gradients beyond 70 and 30 between the
 * RSI and 50, and its Bollinger Bands' background between the two bands (the library's own bands
 * example draws the same way). Bars where either side has no value leave a gap, as in Pine.
 */
export class FillPrimitive implements ISeriesPrimitive<Time> {
  private readonly views: readonly IPrimitivePaneView[];
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private shapes: readonly FillShape[] = [];

  constructor() {
    this.views = [{ zOrder: () => 'bottom', renderer: () => ({ draw: (t) => this.draw(t) }) }];
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

  update(shapes: readonly FillShape[]): void {
    this.shapes = shapes;
    this.requestUpdate?.();
  }

  current(): readonly FillShape[] {
    return this.shapes;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: DrawTarget): void {
    const { chart, series } = this;
    if (!chart || !series || this.shapes.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const shape of this.shapes) {
        if (shape.kind === 'levels') {
          const a = series.priceToCoordinate(shape.from);
          const b = series.priceToCoordinate(shape.to);
          if (a === null || b === null) continue;
          ctx.fillStyle = shape.color;
          ctx.fillRect(0, Math.min(a, b), mediaSize.width, Math.abs(b - a));
        } else if (typeof shape.color === 'object' && 'at' in shape.color) {
          this.drawColoredBand(ctx, chart, series, shape, shape.color);
        } else {
          const paint = this.paint(ctx, series, shape.color);
          if (paint === null) continue;
          ctx.fillStyle = paint;
          this.drawBand(ctx, chart, series, shape);
        }
      }
    });
  }

  /** A solid color, or a gradient placed at its prices on the pane's scale now. */
  private paint(
    ctx: CanvasRenderingContext2D,
    series: ISeriesApi<SeriesType>,
    color: string | GradientPaint,
  ): string | CanvasGradient | null {
    if (typeof color === 'string') return color;
    const top = series.priceToCoordinate(color.top);
    const bottom = series.priceToCoordinate(color.bottom);
    // A scale squeezed to nothing leaves no room for a gradient: nothing to draw.
    if (top === null || bottom === null || top === bottom) return null;
    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, color.topColor);
    gradient.addColorStop(1, color.bottomColor);
    return gradient;
  }

  /**
   * A band whose color changes from bar to bar: each stretch between two bars in the color of
   * the later one (as we read Pine's fill; provisional, docs/SPEC.md §11).
   */
  private drawColoredBand(
    ctx: CanvasRenderingContext2D,
    chart: IChartApi,
    series: ISeriesApi<SeriesType>,
    shape: Extract<FillShape, { kind: 'plots' }>,
    colors: BarColors,
  ): void {
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;
    const last = Math.min(edgeLength(shape.upper), edgeLength(shape.lower)) - 1;
    const from = Math.max(shape.start, Math.floor(range.from) - 1, 0);
    const to = Math.min(last, Math.ceil(range.to) + 1);
    let before: { x: number; upper: number; lower: number } | null = null;
    for (let i = from; i <= to; i++) {
      const high = edgeAt(shape.upper, i);
      const low = edgeAt(shape.lower, i);
      const x = timeScale.logicalToCoordinate(i as Logical);
      const upper = Number.isFinite(high) ? series.priceToCoordinate(high) : null;
      const lower = Number.isFinite(low) ? series.priceToCoordinate(low) : null;
      if (x === null || upper === null || lower === null) {
        before = null;
        continue;
      }
      const color = colors.at(i);
      if (before && color !== null) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(before.x, before.upper);
        ctx.lineTo(x, upper);
        ctx.lineTo(x, lower);
        ctx.lineTo(before.x, before.lower);
        ctx.closePath();
        ctx.fill();
      }
      before = { x, upper, lower };
    }
  }

  /** The band between two plots over the bars in view, one polygon per run of values. */
  private drawBand(
    ctx: CanvasRenderingContext2D,
    chart: IChartApi,
    series: ISeriesApi<SeriesType>,
    shape: Extract<FillShape, { kind: 'plots' }>,
  ): void {
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return;
    const last = Math.min(edgeLength(shape.upper), edgeLength(shape.lower)) - 1;
    const from = Math.max(shape.start, Math.floor(range.from) - 1, 0);
    const to = Math.min(last, Math.ceil(range.to) + 1);
    let run: { x: number; upper: number; lower: number }[] = [];
    const flush = () => {
      if (run.length > 1) {
        ctx.beginPath();
        for (const [i, p] of run.entries()) {
          if (i === 0) ctx.moveTo(p.x, p.upper);
          else ctx.lineTo(p.x, p.upper);
        }
        for (let i = run.length - 1; i >= 0; i--) {
          const p = run[i] as { x: number; lower: number };
          ctx.lineTo(p.x, p.lower);
        }
        ctx.closePath();
        ctx.fill();
      }
      run = [];
    };
    for (let i = from; i <= to; i++) {
      const high = edgeAt(shape.upper, i);
      const low = edgeAt(shape.lower, i);
      const x = timeScale.logicalToCoordinate(i as Logical);
      const upper = Number.isFinite(high) ? series.priceToCoordinate(high) : null;
      const lower = Number.isFinite(low) ? series.priceToCoordinate(low) : null;
      if (x === null || upper === null || lower === null) {
        flush();
        continue;
      }
      run.push({ x, upper, lower });
    }
    flush();
  }
}

/** How many bars an edge has a say on: a fixed price, all of them. */
const edgeLength = (edge: BandEdge): number =>
  typeof edge === 'number' ? Number.POSITIVE_INFINITY : edge.length;

/** An edge's price on bar `i` (NaN where its plot has no value). */
const edgeAt = (edge: BandEdge, i: number): number =>
  typeof edge === 'number' ? edge : (edge[i] ?? Number.NaN);
