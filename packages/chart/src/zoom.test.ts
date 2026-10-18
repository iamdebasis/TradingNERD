import { describe, expect, it } from 'vitest';
import {
  barSpacingOf,
  indexAtX,
  normalizeWheel,
  panRange,
  WHEEL_PAN_FACTOR,
  wheelZoomScale,
  zoomRange,
} from './zoom';

const WIDTH = 1200;
const LIMITS = { min: 0.5, max: WIDTH / 2 };
/** 200 bars visible at 6 px each, the last one at index 2999. */
const RANGE = { from: 2800, to: 2999 };

describe('time-axis geometry', () => {
  it('derives bar spacing from the visible range', () => {
    expect(barSpacingOf(RANGE, WIDTH)).toBe(6);
  });

  it('maps the rightmost pixel to half a bar past the last visible index', () => {
    expect(indexAtX(RANGE, WIDTH, WIDTH - 1)).toBeCloseTo(2999.5);
    expect(indexAtX(RANGE, WIDTH, WIDTH - 1 - 6)).toBeCloseTo(2998.5);
  });
});

describe('zoomRange', () => {
  it('widens bars by 10% per notch in and narrows them by 10% per notch out', () => {
    expect(barSpacingOf(zoomRange(RANGE, WIDTH, 1, null, LIMITS), WIDTH)).toBeCloseTo(6.6);
    expect(barSpacingOf(zoomRange(RANGE, WIDTH, -1, null, LIMITS), WIDTH)).toBeCloseTo(5.4);
    expect(barSpacingOf(zoomRange(RANGE, WIDTH, 0.25, null, LIMITS), WIDTH)).toBeCloseTo(6.15);
  });

  it('takes a different step per notch, for tuning', () => {
    expect(barSpacingOf(zoomRange(RANGE, WIDTH, 1, null, LIMITS, 0.2), WIDTH)).toBeCloseTo(7.2);
    expect(barSpacingOf(zoomRange(RANGE, WIDTH, -0.5, 600, LIMITS, 0.3), WIDTH)).toBeCloseTo(5.1);
  });

  it('keeps the right edge fixed without an anchor (plain wheel)', () => {
    for (const scale of [1, -1, 0.3]) {
      expect(zoomRange(RANGE, WIDTH, scale, null, LIMITS).to).toBe(RANGE.to);
    }
  });

  it('keeps the bar under the cursor fixed with an anchor (Ctrl/⌘ + wheel, pinch)', () => {
    for (const x of [0, 137, 600, 1199]) {
      for (const scale of [1, -1, 0.5, -0.2]) {
        const zoomed = zoomRange(RANGE, WIDTH, scale, x, LIMITS);
        expect(indexAtX(zoomed, WIDTH, x)).toBeCloseTo(indexAtX(RANGE, WIDTH, x), 9);
      }
    }
  });

  it('stays anchored over many steps, like a long pinch', () => {
    let range = RANGE;
    const before = indexAtX(range, WIDTH, 300);
    for (let i = 0; i < 40; i++)
      range = zoomRange(range, WIDTH, i % 3 === 0 ? -0.7 : 0.4, 300, LIMITS);
    expect(indexAtX(range, WIDTH, 300)).toBeCloseTo(before, 6);
  });

  it('respects the bar spacing limits', () => {
    let range = RANGE;
    for (let i = 0; i < 200; i++) range = zoomRange(range, WIDTH, -1, null, LIMITS);
    expect(barSpacingOf(range, WIDTH)).toBeCloseTo(LIMITS.min);
    for (let i = 0; i < 200; i++) range = zoomRange(range, WIDTH, 1, null, LIMITS);
    expect(barSpacingOf(range, WIDTH)).toBeCloseTo(LIMITS.max);
  });
});

describe('panRange', () => {
  it('shifts by pixels / bar spacing, positive toward newer bars', () => {
    expect(panRange(RANGE, WIDTH, 60)).toEqual({ from: 2810, to: 3009 });
    expect(panRange(RANGE, WIDTH, -12)).toEqual({ from: 2798, to: 2997 });
  });

  it('pans 0.8 px per pixel of horizontal wheel delta', () => {
    expect(WHEEL_PAN_FACTOR).toBe(0.8);
  });
});

describe('wheel normalization', () => {
  const wheel = (deltaX: number, deltaY: number, deltaMode = 0, shiftKey = false) => ({
    deltaX,
    deltaY,
    deltaMode,
    shiftKey,
  });

  it('passes pixel deltas through', () => {
    expect(normalizeWheel(wheel(3, -40))).toEqual({ dx: 3, dy: -40 });
  });

  it('scales line and page deltas like Lightweight Charts', () => {
    expect(normalizeWheel(wheel(0, 3, 1))).toEqual({ dx: 0, dy: 96 });
    expect(normalizeWheel(wheel(0, 1, 2))).toEqual({ dx: 0, dy: 120 });
  });

  it('undoes device pixels on Windows Chromium', () => {
    expect(normalizeWheel(wheel(0, 200), 2, true)).toEqual({ dx: 0, dy: 100 });
  });

  it('turns Shift + wheel into a horizontal pan', () => {
    expect(normalizeWheel(wheel(0, 50, 0, true))).toEqual({ dx: 50, dy: 0 });
    expect(normalizeWheel(wheel(20, 5, 0, true))).toEqual({ dx: 20, dy: 5 });
  });

  it('zooms in on wheel up and at most one notch per event', () => {
    expect(wheelZoomScale(-100)).toBe(1);
    expect(wheelZoomScale(-25)).toBe(0.25);
    expect(wheelZoomScale(300)).toBe(-1);
    expect(wheelZoomScale(0)).toBe(0);
  });
});
