import { describe, expect, it } from 'vitest';
import {
  angleOf,
  dashOf,
  distanceToSegment,
  formatAngle,
  formatDuration,
  lineSegment,
  rectOf,
  segmentTouchesRect,
  snap45,
} from './geometry';

const pane = { width: 800, height: 400 };

describe('lineSegment', () => {
  it('keeps a line inside the pane as drawn', () => {
    expect(lineSegment({ x: 100, y: 100 }, { x: 300, y: 200 }, false, false, pane)).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 200 },
    ]);
  });

  it('carries a ray on past its second point to the pane’s edge, whichever way it runs', () => {
    const right = lineSegment({ x: 100, y: 100 }, { x: 200, y: 100 }, false, true, pane);
    expect(right?.[0]).toEqual({ x: 100, y: 100 });
    expect(right?.[1].x).toBe(804);
    // Drawn from right to left, it runs on to the left edge.
    const left = lineSegment({ x: 300, y: 100 }, { x: 200, y: 100 }, false, true, pane);
    expect(left?.[0]).toEqual({ x: 300, y: 100 });
    expect(left?.[1].x).toBe(-4);
  });

  it('carries an extended line along its slope to the edges it reaches first', () => {
    const line = lineSegment({ x: 100, y: 100 }, { x: 200, y: 150 }, true, true, pane);
    // Left out through the left edge, right out through the bottom one.
    expect(line?.[0]).toEqual({ x: -4, y: 48 });
    expect(line?.[1]).toEqual({ x: 708, y: 404 });
  });

  it('gives nothing for a line wholly off the pane', () => {
    expect(lineSegment({ x: 900, y: 100 }, { x: 1_000, y: 200 }, false, false, pane)).toBeNull();
    expect(lineSegment({ x: 900, y: 100 }, { x: 1_000, y: 200 }, false, true, pane)).toBeNull();
  });

  it('clips a line that leaves the pane at the edge it crosses', () => {
    const line = lineSegment({ x: 700, y: 200 }, { x: 900, y: 200 }, false, false, pane);
    expect(line).toEqual([
      { x: 700, y: 200 },
      { x: 804, y: 200 },
    ]);
  });
});

describe('distanceToSegment', () => {
  it('is the distance to the nearest point of the segment, its ends included', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    expect(distanceToSegment({ x: 50, y: 4 }, a, b)).toBe(4);
    expect(distanceToSegment({ x: 103, y: 4 }, a, b)).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, a, a)).toBe(5);
  });
});

describe('snap45', () => {
  const from = { x: 100, y: 100 };

  it('turns a near-flat line flat and a near-upright one upright', () => {
    expect(snap45(from, { x: 200, y: 110 })).toEqual({ x: 200, y: 100 });
    expect(snap45(from, { x: 105, y: 20 })).toEqual({ x: 100, y: 20 });
  });

  it('keeps the bar and sets the height for 45°', () => {
    expect(snap45(from, { x: 160, y: 50 })).toEqual({ x: 160, y: 40 });
    expect(snap45(from, { x: 40, y: 150 })).toEqual({ x: 40, y: 160 });
  });
});

describe('angleOf', () => {
  it('measures up from the right, as the eye reads the screen', () => {
    expect(angleOf({ x: 0, y: 0 }, { x: 10, y: -10 })).toBeCloseTo(45, 12);
    expect(angleOf({ x: 0, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(-45, 12);
  });
});

describe('dashOf', () => {
  it('is the capture’s dashes at 2 px, in step with the width', () => {
    expect(dashOf('solid', 2)).toEqual([]);
    expect(dashOf('dotted', 2)).toEqual([2, 3]);
    expect(dashOf('dashed', 2)).toEqual([6, 4]);
    expect(dashOf('dashed', 1)).toEqual([3, 2]);
  });
});

describe('formatDuration', () => {
  it('writes days, hours, minutes and seconds, leaving out those that are zero', () => {
    expect(formatDuration(163_800)).toBe('1d 21h 30m');
    expect(formatDuration(86_400 + 5)).toBe('1d 5s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-7_200)).toBe('-2h');
  });
});

describe('formatAngle', () => {
  it('writes up to two decimals and the capture’s º', () => {
    expect(formatAngle(45)).toBe('45º');
    expect(formatAngle(45.5)).toBe('45.5º');
    expect(formatAngle(-12.345_6)).toBe('-12.35º');
    expect(formatAngle(-0.001)).toBe('0º');
  });
});

describe('a selecting box (D3a)', () => {
  const box = rectOf({ x: 300, y: 200 }, { x: 100, y: 100 });

  it('is the same box whichever corner it’s drawn from', () => {
    expect(box).toEqual({ left: 100, top: 100, right: 300, bottom: 200 });
  });

  it('touches a segment inside it, through it or with one end in it, not one beside it', () => {
    expect(segmentTouchesRect({ x: 150, y: 150 }, { x: 160, y: 160 }, box)).toBe(true);
    expect(segmentTouchesRect({ x: 0, y: 150 }, { x: 400, y: 150 }, box)).toBe(true);
    expect(segmentTouchesRect({ x: 50, y: 50 }, { x: 150, y: 150 }, box)).toBe(true);
    expect(segmentTouchesRect({ x: 0, y: 0 }, { x: 400, y: 50 }, box)).toBe(false);
    // Cutting across the box's corner, and passing it by just outside.
    expect(segmentTouchesRect({ x: 0, y: 220 }, { x: 220, y: 0 }, box)).toBe(true);
    expect(segmentTouchesRect({ x: 0, y: 150 }, { x: 150, y: 0 }, box)).toBe(false);
  });
});
