import { describe, expect, it } from 'vitest';
import { clampWidth, WATCHLIST_LIMITS, watchlistMaxWidth } from './watchlistWidth';

describe('watchlistMaxWidth', () => {
  it('leaves room for the splitter and the minimum chart width', () => {
    // 1634 px window minus 2 × 4 px workspace padding = 1626 px available.
    expect(watchlistMaxWidth(1626)).toBe(1626 - 4 - 320);
  });

  it('never drops below the watchlist minimum in a tiny window', () => {
    expect(watchlistMaxWidth(400)).toBe(WATCHLIST_LIMITS.min);
  });

  it('rounds down so the chart keeps its full minimum', () => {
    expect(watchlistMaxWidth(1000.7)).toBe(676);
  });
});

describe('clampWidth', () => {
  it.each([
    [100, 240],
    [315, 315],
    [5000, 1302],
    [315.6, 316],
  ])('clamps %d into [240, 1302] → %d', (value, expected) => {
    expect(clampWidth(value, 240, 1302)).toBe(expected);
  });

  it('works with an unbounded maximum before the workspace is measured', () => {
    expect(clampWidth(800, 240, Number.POSITIVE_INFINITY)).toBe(800);
  });
});
