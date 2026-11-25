import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { magnetPrice, WEAK_MAGNET_PX } from './magnet';

const bar: Bar = { time: 0, open: 100, high: 120, low: 90, close: 110, volume: 1 };
// One price unit per pixel, prices growing upwards from y = 500.
const priceToY = (price: number) => 500 - price;

describe('magnetPrice', () => {
  it('strong mode takes the nearest of the open, high, low and close from anywhere', () => {
    expect(magnetPrice(bar, 500 - 300, priceToY, 'strong')).toBe(120);
    expect(magnetPrice(bar, 500 - 94, priceToY, 'strong')).toBe(90);
    expect(magnetPrice(bar, 500 - 106, priceToY, 'strong')).toBe(110);
  });

  it(`weak mode takes it only within ${WEAK_MAGNET_PX} px`, () => {
    expect(magnetPrice(bar, 500 - 132, priceToY, 'weak')).toBe(120);
    expect(magnetPrice(bar, 500 - 133, priceToY, 'weak')).toBeNull();
  });

  it('leaves out a price the pane can’t place', () => {
    const noHigh = (price: number) => (price === 120 ? null : priceToY(price));
    expect(magnetPrice(bar, 500 - 125, noHigh, 'strong')).toBe(110);
  });
});
