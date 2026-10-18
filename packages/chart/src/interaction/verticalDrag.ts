import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';

/** Vertical travel (px) before a drag counts as moving the price scale. */
const THRESHOLD_PX = 8;
/** …and it must be at least this steep (|dy| ≥ |dx| × ratio), so horizontal pans stay auto. */
const MIN_STEEPNESS = 0.5;

/**
 * TradingView switches auto-scale off when you drag the chart up or down, and the prices follow
 * the pointer. Lightweight Charts ignores vertical drags while auto-scale is on, so the first
 * such drag is handled here. Once auto-scale is off, the library's own drag takes over.
 * Double-clicking the price axis (or Alt+R) turns auto-scale back on.
 */
export function installVerticalDrag(chart: IChartApi, series: ISeriesApi<SeriesType>): () => void {
  const element = chart.chartElement();

  const onPointerDown = (down: PointerEvent) => {
    if (down.button !== 0 || !down.isPrimary) return;
    const scale = series.priceScale();
    if (!scale.options().autoScale) return;
    const box = element.getBoundingClientRect();
    const pane = chart.paneSize();
    const x = down.clientX - box.left;
    const y = down.clientY - box.top;
    if (x < 0 || y < 0 || x > pane.width || y > pane.height) return; // the axes scale, not pan

    let start: { from: number; to: number; pricePerPixel: number } | null = null;
    let libraryDragStarted = false;
    const onMove = (move: PointerEvent) => {
      // Lightweight Charts starts its own drag on the first move (pointer events fire before
      // the mouse events it listens to). Engaging only after that keeps it from also scrolling
      // the price scale, which would move prices twice as fast.
      if (!libraryDragStarted) {
        libraryDragStarted = true;
        return;
      }
      const dy = move.clientY - down.clientY;
      if (!start) {
        const dx = move.clientX - down.clientX;
        if (Math.abs(dy) < THRESHOLD_PX || Math.abs(dy) < Math.abs(dx) * MIN_STEEPNESS) return;
        // Price per pixel from the chart's own mapping, which leaves room for the scale margins.
        const range = scale.getVisibleRange();
        const top = series.coordinateToPrice(0);
        const bottom = series.coordinateToPrice(pane.height);
        if (!range || top === null || bottom === null) return;
        start = { ...range, pricePerPixel: (top - bottom) / pane.height };
        scale.setAutoScale(false);
      }
      // The price that was under the pointer stays under it.
      const shift = dy * start.pricePerPixel;
      scale.setVisibleRange({ from: start.from + shift, to: start.to + shift });
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  element.addEventListener('pointerdown', onPointerDown, { capture: true });
  return () => element.removeEventListener('pointerdown', onPointerDown, { capture: true });
}
