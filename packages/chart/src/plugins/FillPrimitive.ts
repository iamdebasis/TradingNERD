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

/** A fill between two levels, or between two plots from bar `start` on (Pine's `fill`). */
export type FillShape =
  | { kind: 'levels'; from: number; to: number; color: string }
  | {
      kind: 'plots';
      upper: readonly number[];
      lower: readonly number[];
      start: number;
      color: string;
    };

/**
 * An indicator's fills, drawn behind its lines: RSI's background between its upper and lower
 * bands, and its Bollinger Bands' background between the two bands (the library's own bands
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

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private draw(target: DrawTarget): void {
    const { chart, series } = this;
    if (!chart || !series || this.shapes.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const shape of this.shapes) {
        ctx.fillStyle = shape.color;
        if (shape.kind === 'levels') {
          const a = series.priceToCoordinate(shape.from);
          const b = series.priceToCoordinate(shape.to);
          if (a === null || b === null) continue;
          ctx.fillRect(0, Math.min(a, b), mediaSize.width, Math.abs(b - a));
        } else {
          this.drawBand(ctx, chart, series, shape);
        }
      }
    });
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
    const last = Math.min(shape.upper.length, shape.lower.length) - 1;
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
      const high = shape.upper[i] ?? Number.NaN;
      const low = shape.lower[i] ?? Number.NaN;
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
