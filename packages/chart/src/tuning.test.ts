import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GESTURE_TUNING,
  type GestureTuning,
  sanitizeTuning,
  TUNING_LIMITS,
} from './tuning';

describe('gesture tuning', () => {
  it('defaults to the library speeds, with the provisional price-axis choices', () => {
    expect(DEFAULT_GESTURE_TUNING).toEqual({
      zoomStep: 0.1,
      pinchStep: 0.1,
      panFactor: 0.8,
      priceStep: 0.1,
      priceAnchor: 'center',
      priceReversed: false,
    });
    expect(Object.isFrozen(DEFAULT_GESTURE_TUNING)).toBe(true);
  });

  it('keeps every default inside its limits', () => {
    for (const [key, { min, max }] of Object.entries(TUNING_LIMITS)) {
      const value = DEFAULT_GESTURE_TUNING[key as keyof typeof TUNING_LIMITS];
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
    }
  });

  it('accepts a complete, valid tuning as is', () => {
    const tuning: GestureTuning = {
      zoomStep: 0.15,
      pinchStep: 0.05,
      panFactor: 1.2,
      priceStep: 0.3,
      priceAnchor: 'pointer',
      priceReversed: true,
    };
    expect(sanitizeTuning(tuning)).toEqual(tuning);
  });

  it('falls back to the defaults for anything that is not a tuning', () => {
    for (const input of [null, undefined, 42, 'fast', [], {}]) {
      expect(sanitizeTuning(input)).toEqual(DEFAULT_GESTURE_TUNING);
    }
  });

  it('clamps numbers to their limits and ignores malformed fields', () => {
    expect(
      sanitizeTuning({
        zoomStep: 9,
        pinchStep: -1,
        panFactor: Number.NaN,
        priceStep: '0.2',
        priceAnchor: 'cursor',
        priceReversed: 'yes',
      }),
    ).toEqual({ ...DEFAULT_GESTURE_TUNING, zoomStep: 0.5, pinchStep: 0.01 });
  });

  it('takes omitted fields from the base, so partial updates keep the rest', () => {
    const base = sanitizeTuning({ priceStep: 0.25, priceAnchor: 'lastPrice' });
    expect(sanitizeTuning({ zoomStep: 0.2 }, base)).toEqual({
      ...DEFAULT_GESTURE_TUNING,
      zoomStep: 0.2,
      priceStep: 0.25,
      priceAnchor: 'lastPrice',
    });
  });
});
