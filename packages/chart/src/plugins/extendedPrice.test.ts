import { describe, expect, it } from 'vitest';
import { labelClearOf, TAG } from './ExtendedPricePrimitive';

describe("the pre/post-market price's label", () => {
  const last = { top: 100, bottom: 117 }; // a one-row last price label centered at 108.5

  it('stays at its price when it clears the last price', () => {
    expect(labelClearOf(80, true, last)).toBe(80);
    expect(labelClearOf(140, false, last)).toBe(140);
    expect(labelClearOf(110, true, null)).toBe(110);
  });

  it("steps above or below the last price's label, on its price's side", () => {
    expect(labelClearOf(112, true, last)).toBe(100 - TAG.height / 2);
    expect(labelClearOf(105, false, last)).toBe(117 + TAG.height / 2);
  });
});
