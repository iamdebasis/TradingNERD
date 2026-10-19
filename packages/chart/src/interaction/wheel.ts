import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { type PriceRange, scalePriceRange } from '../priceZoom';
import type { GestureTuning, TuningNumber } from '../tuning';
import { normalizeWheel, panRange, type SpacingLimits, wheelZoomScale, zoomRange } from '../zoom';
import type { TimeViewport } from './viewport';

export function spacingLimits(chart: IChartApi): SpacingLimits {
  const timeScale = chart.timeScale();
  const { minBarSpacing, maxBarSpacing } = timeScale.options();
  return { min: minBarSpacing, max: maxBarSpacing > 0 ? maxBarSpacing : timeScale.width() / 2 };
}

const windowsChromium =
  typeof navigator !== 'undefined' &&
  /Windows/.test(navigator.userAgent) &&
  /Chrome\//.test(navigator.userAgent);

export interface WheelOptions {
  /** The gesture constants, read on every event so a change applies at once. */
  tuning(): GestureTuning;
  /** The latest price, for the `lastPrice` anchor. */
  lastPrice(): number | null;
  /** Each setting a wheel event used, e.g. so a settings panel can show which one is in play. */
  onGesture?(setting: TuningNumber): void;
}

/** Whether a point (px from the chart's top-left) is on the right price axis, beside the pane. */
export function isOverPriceAxis(
  x: number,
  y: number,
  pane: { width: number; height: number },
): boolean {
  return x >= pane.width && y >= 0 && y < pane.height;
}

/**
 * Mouse wheel and trackpad, TradingView style:
 * - Over the chart and the time axis, a vertical wheel zooms with the right edge fixed; Ctrl/⌘ +
 *   wheel and trackpad pinch (which browsers report as Ctrl + wheel) zoom around the cursor.
 * - Over the price axis, a vertical wheel stretches the price scale instead (the way that zooms
 *   the chart in makes the candles taller) and turns auto-scale off, as dragging the axis does.
 * - A horizontal swipe or Shift + wheel pans, anywhere.
 * The OS supplies the momentum, so a flick keeps gliding.
 *
 * Replaces Lightweight Charts' own wheel handling, which must be switched off
 * (handleScroll.mouseWheel and handleScale.mouseWheel set to false).
 */
export function installWheel(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  viewport: TimeViewport,
  options: WheelOptions,
): () => void {
  const element = chart.chartElement();

  const anchorPrice = (tuning: GestureTuning, range: PriceRange, y: number): number => {
    const center = (range.from + range.to) / 2;
    if (tuning.priceAnchor === 'pointer') return series.coordinateToPrice(y) ?? center;
    if (tuning.priceAnchor === 'lastPrice') return options.lastPrice() ?? center;
    return center;
  };

  // Unlike the time scale, the price scale applies a new range at once, so every event in a
  // frame builds on the previous one without help.
  const scalePrice = (tuning: GestureTuning, dy: number, y: number) => {
    const scale = series.priceScale();
    const range = scale.getVisibleRange();
    if (!range || !(range.to > range.from)) return;
    const notches = wheelZoomScale(tuning.priceReversed ? -dy : dy);
    const factor = 1 + notches * tuning.priceStep;
    scale.setVisibleRange(scalePriceRange(range, factor, anchorPrice(tuning, range, y)));
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault(); // no page scroll and no browser pinch-zoom over the chart
    const tuning = options.tuning();
    const { dx, dy } = normalizeWheel(event, window.devicePixelRatio, windowsChromium);
    const box = element.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;

    let zoomTime = dy !== 0;
    if (zoomTime && isOverPriceAxis(x, y, chart.paneSize())) {
      scalePrice(tuning, dy, y);
      options.onGesture?.('priceStep');
      zoomTime = false;
    }
    if (!zoomTime && dx === 0) return;

    const width = viewport.width();
    let range = viewport.range();
    if (!range || width <= 0) return;
    if (zoomTime) {
      const anchorX = event.ctrlKey || event.metaKey ? x : null;
      const step = event.ctrlKey ? tuning.pinchStep : tuning.zoomStep;
      range = zoomRange(range, width, wheelZoomScale(dy), anchorX, spacingLimits(chart), step);
      options.onGesture?.(event.ctrlKey ? 'pinchStep' : 'zoomStep');
    }
    if (dx !== 0) {
      range = panRange(range, width, dx * tuning.panFactor);
      options.onGesture?.('panFactor');
    }
    viewport.set(range);
  };

  // Safari reports pinches as non-standard gesture events; keep them from zooming the page.
  const stopGesture = (event: Event) => event.preventDefault();

  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('gesturestart', stopGesture);
  element.addEventListener('gesturechange', stopGesture);
  return () => {
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('gesturestart', stopGesture);
    element.removeEventListener('gesturechange', stopGesture);
  };
}
