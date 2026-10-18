import { describe, expect, it } from 'vitest';
import { type PriceRange, scalePriceRange } from './priceZoom';

const RANGE: PriceRange = { from: 1.0, to: 1.6 };
const span = (range: PriceRange) => range.to - range.from;

/**
 * Lightweight Charts' price-to-y mapping: linear, with the range filling the pane between the
 * 10% top and 8% bottom margins.
 */
function yOf(range: PriceRange, price: number, height = 900): number {
  const top = height * 0.1;
  const inner = height * (1 - 0.1 - 0.08);
  return top + ((range.to - price) / span(range)) * inner;
}

describe('scalePriceRange', () => {
  it('zooms in above 1 and out below 1', () => {
    expect(span(scalePriceRange(RANGE, 1.1, 1.3))).toBeCloseTo(0.6 / 1.1, 12);
    expect(span(scalePriceRange(RANGE, 0.9, 1.3))).toBeCloseTo(0.6 / 0.9, 12);
    expect(scalePriceRange(RANGE, 1, 1.45)).toEqual(RANGE);
  });

  it('keeps the middle of the range in the middle', () => {
    const scaled = scalePriceRange(RANGE, 1.25, 1.3);
    expect((scaled.from + scaled.to) / 2).toBeCloseTo(1.3, 12);
  });

  it('keeps any anchor at the same height on screen, inside the range or not', () => {
    for (const anchor of [1.0, 1.123, 1.3, 1.6, 0.8, 2.4]) {
      for (const factor of [1.1, 0.9, 1.005, 3, 0.25]) {
        const scaled = scalePriceRange(RANGE, factor, anchor);
        expect(yOf(scaled, anchor)).toBeCloseTo(yOf(RANGE, anchor), 9);
        expect(span(scaled)).toBeCloseTo(span(RANGE) / factor, 12);
      }
    }
  });

  it('stays anchored over many small steps, like a long trackpad swipe', () => {
    let range = RANGE;
    for (let i = 0; i < 60; i++) range = scalePriceRange(range, i % 4 === 0 ? 0.97 : 1.02, 1.21);
    expect(yOf(range, 1.21)).toBeCloseTo(yOf(RANGE, 1.21), 9);
  });
});
