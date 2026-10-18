import { describe, expect, it } from 'vitest';
import { isOverPriceAxis } from './wheel';

describe('isOverPriceAxis', () => {
  const pane = { width: 1200, height: 900 };

  it('is true right of the pane, beside it', () => {
    expect(isOverPriceAxis(1200, 0, pane)).toBe(true);
    expect(isOverPriceAxis(1236, 450, pane)).toBe(true);
    expect(isOverPriceAxis(1271, 899, pane)).toBe(true);
  });

  it('is false over the pane, the time axis and the corner below the price axis', () => {
    expect(isOverPriceAxis(1199, 450, pane)).toBe(false);
    expect(isOverPriceAxis(600, 450, pane)).toBe(false);
    expect(isOverPriceAxis(600, 910, pane)).toBe(false);
    expect(isOverPriceAxis(1236, 900, pane)).toBe(false);
    expect(isOverPriceAxis(1236, -1, pane)).toBe(false);
  });
});
