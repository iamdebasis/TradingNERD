import type { Bar } from '@tradingnerd/core';
import type {
  IChartApi,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { DrawTarget } from './axisLabel';

/** Which part of the extended session a bar is in: pre-market, post-market, or neither. */
export type SessionPart = 'pre' | 'post' | null;

export interface SessionShading {
  /** The part of the session the bar opening at `time` (UTC s) is in. */
  partOf(time: number): SessionPart;
  /** Background colors, with their transparency (CSS colors). */
  pre: string;
  post: string;
}

interface Band {
  left: number;
  right: number;
  color: string;
}

/**
 * TradingView's pre/post market hours background: with extended hours on, the bars of each
 * pre- and post-market stretch sit on a band of color the full height of the pane, behind the
 * candles.
 */
export class SessionShadePrimitive implements ISeriesPrimitive<Time> {
  private readonly bars: () => readonly Bar[];
  private readonly views: readonly IPrimitivePaneView[];
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private shading: SessionShading | null = null;
  private bands: Band[] = [];

  /** `bars`: the bars as the series holds them, ascending (index = logical index). */
  constructor(bars: () => readonly Bar[]) {
    this.bars = bars;
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

  update(shading: SessionShading | null): void {
    this.shading = shading;
    this.requestUpdate?.();
  }

  current(): SessionShading | null {
    return this.shading;
  }

  /** The bands drawn last, in media px (for tests and diagnostics). */
  drawnBands(): readonly Band[] {
    return this.bands;
  }

  updateAllViews(): void {
    this.bands = this.computeBands();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private computeBands(): Band[] {
    const { chart, shading } = this;
    const bars = this.bars();
    if (!chart || !shading || bars.length === 0) return [];
    const timeScale = chart.timeScale();
    const range = timeScale.getVisibleLogicalRange();
    if (!range) return [];
    const half = timeScale.options().barSpacing / 2;
    const first = Math.max(0, Math.floor(range.from) - 1);
    const last = Math.min(bars.length - 1, Math.ceil(range.to) + 1);
    const bands: Band[] = [];
    let open: { part: 'pre' | 'post'; left: number; right: number } | null = null;
    for (let index = first; index <= last; index++) {
      const bar = bars[index];
      const x = timeScale.logicalToCoordinate(index as Logical);
      const part = bar === undefined ? null : shading.partOf(bar.time);
      if (open && (part !== open.part || x === null)) {
        bands.push({ left: open.left, right: open.right, color: shading[open.part] });
        open = null;
      }
      if (!part || x === null) continue;
      if (open) open.right = x + half;
      else open = { part, left: x - half, right: x + half };
    }
    if (open) bands.push({ left: open.left, right: open.right, color: shading[open.part] });
    return bands;
  }

  private draw(target: DrawTarget): void {
    if (this.bands.length === 0) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio }) => {
      for (const band of this.bands) {
        // Whole device pixels, edge to edge, so neighboring bands neither gap nor overlap.
        const left = Math.round(band.left * horizontalPixelRatio);
        const right = Math.round(band.right * horizontalPixelRatio);
        if (right <= 0 || left >= bitmapSize.width) continue;
        ctx.fillStyle = band.color;
        ctx.fillRect(left, 0, right - left, bitmapSize.height);
      }
    });
  }
}
