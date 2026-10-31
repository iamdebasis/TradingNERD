import type {
  IChartApi,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { DrawTarget } from './axisLabel';

/**
 * One bgcolor() of a script (Pine docs, Backgrounds): its color behind each bar, from bar `start`
 * on, drawn `offset` bars to the right; a bar without a color has no background.
 */
export interface BackgroundBand {
  id: string;
  /** The CSS color behind the bar of logical index `i`, or null for none. */
  colorAt(i: number): string | null;
  start: number;
  /** The last bar drawn: the chart's last, or less with show_last. */
  end: number;
}

interface Stripe {
  left: number;
  right: number;
  color: string;
}

/**
 * Scripts' backgrounds: colored stripes the pane's full height, one per bar, behind everything
 * else in the pane (Pine's z-order puts backgrounds first). Neighbouring bars of one color make
 * one stripe, edge to edge, as the session shading draws them.
 */
export class BackgroundPrimitive implements ISeriesPrimitive<Time> {
  private readonly views: readonly IPrimitivePaneView[];
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private bands: readonly BackgroundBand[] = [];
  private stripes: Stripe[] = [];

  constructor() {
    this.views = [{ zOrder: () => 'bottom', renderer: () => ({ draw: (t) => this.draw(t) }) }];
  }

  attached({ chart, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart;
    this.requestUpdate = requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
  }

  update(bands: readonly BackgroundBand[]): void {
    this.bands = bands;
    this.requestUpdate?.();
  }

  current(): readonly BackgroundBand[] {
    return this.bands;
  }

  /** The stripes drawn last, in media px (for tests and diagnostics). */
  drawnStripes(): readonly Stripe[] {
    return this.stripes;
  }

  updateAllViews(): void {
    this.stripes = this.computeStripes();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private computeStripes(): Stripe[] {
    const { chart } = this;
    if (!chart || this.bands.length === 0) return [];
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return [];
    const half = timeScale.options().barSpacing / 2;
    const stripes: Stripe[] = [];
    for (const band of this.bands) {
      const first = Math.max(band.start, Math.floor(range.from) - 1, 0);
      const last = Math.min(band.end, Math.ceil(range.to) + 1);
      let open: Stripe | null = null;
      for (let i = first; i <= last; i++) {
        const color = band.colorAt(i);
        const x = timeScale.logicalToCoordinate(i as Logical);
        if (open && (color !== open.color || x === null)) {
          stripes.push(open);
          open = null;
        }
        if (color === null || x === null) continue;
        if (open) open.right = x + half;
        else open = { left: x - half, right: x + half, color };
      }
      if (open) stripes.push(open);
    }
    return stripes;
  }

  private draw(target: DrawTarget): void {
    if (this.stripes.length === 0) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio }) => {
      for (const stripe of this.stripes) {
        // Whole device pixels, edge to edge, so neighbouring stripes neither gap nor overlap.
        const left = Math.round(stripe.left * horizontalPixelRatio);
        const right = Math.round(stripe.right * horizontalPixelRatio);
        if (right <= 0 || left >= bitmapSize.width) continue;
        ctx.fillStyle = stripe.color;
        ctx.fillRect(left, 0, right - left, bitmapSize.height);
      }
    });
  }
}
