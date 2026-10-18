/**
 * Time-axis math, mirroring Lightweight Charts' own model so our gestures behave exactly like
 * its built-in ones. A visible logical range {from, to} covers a pane `width` px wide with
 * `barSpacing = width / (to - from + 1)`, and pixel x shows the (fractional) bar index
 * `to + 0.5 - (width - 1 - x) / barSpacing`.
 */
export interface LogicalRange {
  from: number;
  to: number;
}

export interface SpacingLimits {
  /** Narrowest bar spacing (px). */
  min: number;
  /** Widest bar spacing (px). */
  max: number;
}

export function barSpacingOf(range: LogicalRange, width: number): number {
  return width / (range.to - range.from + 1);
}

/** Fractional bar index under pixel `x`. */
export function indexAtX(range: LogicalRange, width: number, x: number): number {
  return range.to + 0.5 - (width - 1 - x) / barSpacingOf(range, width);
}

/** One mouse-wheel notch in Lightweight Charts changes the bar spacing by 10%. */
export const ZOOM_STEP = 0.1;

/**
 * Zooms by `scale` notches: +1 widens bars by `step` (10% by default), -1 narrows them by as
 * much, like one mouse-wheel step in Lightweight Charts. With `anchorX` the bar under that pixel
 * stays put (TradingView's Ctrl/⌘ + wheel and pinch); with null the right edge stays put (plain
 * wheel).
 */
export function zoomRange(
  range: LogicalRange,
  width: number,
  scale: number,
  anchorX: number | null,
  limits: SpacingLimits,
  step = ZOOM_STEP,
): LogicalRange {
  const spacing = barSpacingOf(range, width);
  const target = Math.min(Math.max(spacing * (1 + scale * step), limits.min), limits.max);
  const to =
    anchorX === null ? range.to : range.to + (width - 1 - anchorX) * (1 / target - 1 / spacing);
  return { from: to - width / target + 1, to };
}

/** Shifts the view by `pixels`; positive moves toward newer bars. */
export function panRange(range: LogicalRange, width: number, pixels: number): LogicalRange {
  const bars = pixels / barSpacingOf(range, width);
  return { from: range.from + bars, to: range.to + bars };
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/**
 * Wheel deltas in pixels, normalized the way Lightweight Charts does it (line and page modes,
 * and Chromium on Windows reporting device pixels). Shift + wheel scrolls sideways, as on
 * TradingView, when the browser hasn't already turned it into a horizontal delta.
 */
export function normalizeWheel(
  event: WheelInput,
  devicePixelRatio = 1,
  windowsChromium = false,
): { dx: number; dy: number } {
  let factor = 1;
  if (event.deltaMode === 1) factor = 32;
  else if (event.deltaMode === 2) factor = 120;
  else if (windowsChromium) factor = 1 / devicePixelRatio;
  let dx = event.deltaX * factor;
  let dy = event.deltaY * factor;
  if (event.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  return { dx, dy };
}

/** Zoom notches for a vertical wheel delta: up zooms in, at most one notch per event. */
export function wheelZoomScale(dy: number): number {
  if (dy === 0) return 0;
  return Math.sign(-dy) * Math.min(1, Math.abs(dy) / 100);
}

/** Lightweight Charts scrolls 0.8 px per pixel of horizontal wheel delta. */
export const WHEEL_PAN_FACTOR = 0.8;
