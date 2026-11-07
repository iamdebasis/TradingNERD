import { describe, expect, it } from 'vitest';
import { arrowOutline, arrowWidth, autoSize, type DrawnMark, textSize } from './MarksPrimitive';

/**
 * The marks' provisional sizes (docs/SPEC.md §11), measured from the Pine manual's figures:
 * plotshape's arrows 0.39 of the bar spacing ("Lift text"), plotarrow's heads 0.85 of it with
 * shafts 0.58 of the head (Figures 288 and 289).
 */

const arrow = (length: number, direction: -1 | 1, size = 20): DrawnMark => ({
  id: 'plot_0',
  kind: 'arrow',
  shape: null,
  char: null,
  x: 100,
  y: 50,
  size,
  color: '#00E676',
  text: '',
  textColor: null,
  font: 12,
  textSide: 1,
  length,
  direction,
});

describe('Mark sizes', () => {
  it('follow the bar spacing at size.auto, within bounds', () => {
    expect(autoSize(6)).toBe(6);
    expect(autoSize(50)).toBeCloseTo(19.5);
    expect(autoSize(200)).toBe(32);
    expect(textSize(6)).toBe(11);
    expect(textSize(50)).toBe(19);
    expect(textSize(200)).toBe(24);
    expect(arrowWidth(30)).toBeCloseTo(25.5);
    expect(arrowWidth(1)).toBe(3);
  });
});

describe('plotarrow’s outline', () => {
  it('points up from its tip, a head half as tall as wide, then a shaft 0.58 as wide', () => {
    const points = arrowOutline(arrow(40, -1));
    expect(points[0]).toEqual([100, 50]);
    // The head's corners: 10 px down, 10 px either side.
    expect(points[1]).toEqual([110, 60]);
    expect(points[6]).toEqual([90, 60]);
    // The shaft reaches the arrow's length below the tip.
    expect(points[3]?.[1]).toBe(90);
    expect(points[3]?.[0]).toBeCloseTo(105.8);
  });

  it('points down from its tip for a negative value', () => {
    const points = arrowOutline(arrow(40, 1));
    expect(points[1]).toEqual([110, 40]);
    expect(points[3]?.[1]).toBe(10);
  });

  it('is all head, flattened, when shorter than its head', () => {
    const points = arrowOutline(arrow(5, -1));
    expect(points).toEqual([
      [100, 50],
      [110, 55],
      [90, 55],
    ]);
  });
});
