import type { IChartApi } from 'lightweight-charts';
import type { LogicalRange } from '../zoom';

/**
 * The visible time range, with changes that accumulate within a frame.
 *
 * Lightweight Charts applies setVisibleLogicalRange on its next animation frame, and
 * getVisibleLogicalRange keeps returning the old range until then. A trackpad can deliver
 * several wheel events per frame (and a held key repeats), so each step is computed from the
 * range we last asked for, not the stale one; otherwise steps are silently lost and gestures
 * feel sluggish.
 */
export class TimeViewport {
  private readonly chart: IChartApi;
  private pending: LogicalRange | null = null;
  private frame = 0;

  constructor(chart: IChartApi) {
    this.chart = chart;
  }

  /** The range as it will be after the next frame. */
  range(): LogicalRange | null {
    return this.pending ?? this.chart.timeScale().getVisibleLogicalRange();
  }

  width(): number {
    return this.chart.timeScale().width();
  }

  set(range: LogicalRange): void {
    this.pending = range;
    this.chart.timeScale().setVisibleLogicalRange(range);
    if (this.frame === 0) {
      // By the next frame the library has applied it; from then on its own value is current.
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.pending = null;
      });
    }
  }

  /** Forgets a pending range, e.g. when the view is reset by other means. */
  clear(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = null;
  }
}
