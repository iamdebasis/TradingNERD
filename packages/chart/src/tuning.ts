import { WHEEL_PAN_FACTOR, ZOOM_STEP } from './zoom';

/**
 * Gesture constants that TradingView doesn't publish. The defaults are provisional until they've
 * been calibrated side by side with TradingView (docs/SPEC.md §11); anyone can set their own in
 * the top bar's Gestures popup (apps/web/src/gestures/).
 */

/** The price that keeps its place while a wheel over the price axis stretches the scale. */
export type PriceAnchor = 'center' | 'pointer' | 'lastPrice';

export const PRICE_ANCHORS: readonly PriceAnchor[] = ['center', 'pointer', 'lastPrice'];

export interface GestureTuning {
  /** Zoom per wheel notch (100 px of delta) for a plain wheel or two-finger vertical swipe: 0.1 = 10%. */
  zoomStep: number;
  /** The same for Ctrl + wheel, which is how browsers report a trackpad pinch. */
  pinchStep: number;
  /** Pixels panned per pixel of horizontal wheel delta. */
  panFactor: number;
  /** Price-scale stretch per wheel notch over the price axis. */
  priceStep: number;
  priceAnchor: PriceAnchor;
  /** Flips which way a wheel over the price axis stretches the scale. */
  priceReversed: boolean;
}

export const DEFAULT_GESTURE_TUNING: Readonly<GestureTuning> = Object.freeze({
  zoomStep: ZOOM_STEP,
  pinchStep: ZOOM_STEP,
  panFactor: WHEEL_PAN_FACTOR,
  // Provisional: the same speed as the time zoom, and the fixed point Lightweight Charts uses
  // when the price axis is dragged (the middle of the price range).
  priceStep: ZOOM_STEP,
  priceAnchor: 'center',
  priceReversed: false,
});

export type TuningNumber = 'zoomStep' | 'pinchStep' | 'panFactor' | 'priceStep';

/** The allowed range of each number, which is also the tuning panel's slider range. */
export const TUNING_LIMITS: Readonly<
  Record<TuningNumber, { min: number; max: number; step: number }>
> = {
  zoomStep: { min: 0.01, max: 0.5, step: 0.01 },
  pinchStep: { min: 0.01, max: 0.5, step: 0.01 },
  panFactor: { min: 0.1, max: 3, step: 0.05 },
  priceStep: { min: 0.01, max: 0.5, step: 0.01 },
};

/**
 * A complete tuning from anything, e.g. JSON read back from storage. Numbers are clamped to
 * their limits; missing or malformed fields keep their value from `base`.
 */
export function sanitizeTuning(
  input: unknown,
  base: Readonly<GestureTuning> = DEFAULT_GESTURE_TUNING,
): GestureTuning {
  const source =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const number = (key: TuningNumber): number => {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return base[key];
    const { min, max } = TUNING_LIMITS[key];
    return Math.min(Math.max(value, min), max);
  };
  const anchor = PRICE_ANCHORS.find((name) => name === source.priceAnchor);
  return {
    zoomStep: number('zoomStep'),
    pinchStep: number('pinchStep'),
    panFactor: number('panFactor'),
    priceStep: number('priceStep'),
    priceAnchor: anchor ?? base.priceAnchor,
    priceReversed:
      typeof source.priceReversed === 'boolean' ? source.priceReversed : base.priceReversed,
  };
}
