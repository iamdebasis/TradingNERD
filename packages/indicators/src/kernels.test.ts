import { describe, expect, it } from 'vitest';
import { Change, Ema, type Kernel, Rma, Sma, Stdev, Vwma, Wma } from './kernels.ts';

/**
 * Tulip Indicators' published test rows (third-party, tests/untest.txt): 15 closes and the outputs
 * at 3 decimals. Its sma, wilders (= ta.rma), stddev (population), wma and vwma follow Pine's
 * conventions; its ema starts from the first value, so ours is checked by hand instead.
 */
const CLOSES = [
  81.59, 81.06, 82.87, 83.0, 83.61, 83.15, 82.84, 83.99, 84.55, 84.36, 85.53, 86.54, 86.89, 87.77,
  87.29,
];
const VOLUMES = [
  5653100, 6447400, 7690900, 3831400, 4455100, 3798000, 3936200, 4732000, 4841300, 3915300, 6830800,
  6694100, 5293600, 7985800, 4807900,
];

/** Runs a kernel over values, committing each one. */
function run(kernel: Kernel, values: readonly number[]): number[] {
  return values.map((value) => kernel.next(value, true));
}

function expectRow(actual: number[], firstIndex: number, expected: number[]): void {
  for (let i = 0; i < firstIndex; i++) expect(actual[i]).toBeNaN();
  expect(actual.slice(firstIndex)).toHaveLength(expected.length);
  expected.forEach((value, i) => {
    expect(actual[firstIndex + i]).toBeCloseTo(value, 3);
  });
}

describe('ta.sma', () => {
  it('matches the reference row, na until it has its length', () => {
    expectRow(
      run(new Sma(5), CLOSES),
      4,
      [82.426, 82.738, 83.094, 83.318, 83.628, 83.778, 84.254, 84.994, 85.574, 86.218, 86.804],
    );
  });

  it('ignores na values and counts its length in the others', () => {
    const sma = new Sma(3);
    expect(run(sma, [1, Number.NaN, 2, 3])).toEqual([Number.NaN, Number.NaN, Number.NaN, 2]);
  });

  it('a tentative step leaves the committed window as it was', () => {
    const sma = new Sma(2);
    run(sma, [1, 3]);
    expect(sma.next(100, false)).toBe(51.5);
    expect(sma.next(5, false)).toBe(4);
    expect(sma.next(7, true)).toBe(5);
  });

  it('stays exact over 20,000 values (sums are taken afresh)', () => {
    const sma = new Sma(20);
    const values = Array.from(
      { length: 20_000 },
      (_, i) => 1e5 * (1 + Math.sin(i * 12.9898) * 0.3),
    );
    const out = run(sma, values);
    const last = values.slice(-20).reduce((sum, v) => sum + v, 0) / 20;
    expect(Math.abs((out.at(-1) as number) - last) / last).toBeLessThan(1e-12);
  });
});

describe('ta.rma', () => {
  it("matches Wilder's reference row: seeded with the SMA of its first length values", () => {
    expectRow(
      run(new Rma(5), CLOSES),
      4,
      [82.426, 82.571, 82.625, 82.898, 83.228, 83.455, 83.87, 84.404, 84.901, 85.475, 85.838],
    );
  });
});

describe('ta.ema', () => {
  it("is seeded with the SMA, as TradingView's Help Center works its 5-period example", () => {
    // SMA of 5…9 is 7; then 7 + (10 − 7)/3 = 8, and 8 + (11 − 8)/3 = 9.
    const out = run(new Ema(5), [5, 6, 7, 8, 9, 10, 11]);
    expect(out.slice(0, 4).every(Number.isNaN)).toBe(true);
    expect(out[4]).toBe(7);
    expect(out[5]).toBeCloseTo(8, 12);
    expect(out[6]).toBeCloseTo(9, 12);
  });
});

describe('ta.wma', () => {
  it('matches the reference row', () => {
    expectRow(
      run(new Wma(5), CLOSES),
      4,
      [82.825, 83.066, 83.1, 83.399, 83.809, 84.053, 84.637, 85.399, 86.031, 86.763, 87.121],
    );
  });

  it('keeps its weighted sum exact over 20,000 values', () => {
    const wma = new Wma(30);
    const values = Array.from({ length: 20_000 }, (_, i) => 50 + Math.sin(i * 0.7) * 20);
    const out = run(wma, values);
    const tail = values.slice(-30);
    let weighted = 0;
    tail.forEach((v, i) => {
      weighted += (i + 1) * v;
    });
    const expected = weighted / ((30 * 31) / 2);
    expect(Math.abs((out.at(-1) as number) - expected)).toBeLessThan(1e-9);
  });

  it('a tentative step on a full window leaves it as it was', () => {
    const wma = new Wma(3);
    run(wma, [1, 2, 3]);
    const tentative = wma.next(10, false);
    expect(tentative).toBeCloseTo((2 * 1 + 3 * 2 + 10 * 3) / 6, 12);
    expect(wma.next(4, true)).toBeCloseTo((2 + 3 * 2 + 4 * 3) / 6, 12);
  });
});

describe('ta.vwma', () => {
  it('matches the reference row', () => {
    const vwma = new Vwma(5);
    const out = CLOSES.map((close, i) => vwma.next(close, VOLUMES[i] as number, true));
    expectRow(
      out,
      4,
      [82.332, 82.61, 83.07, 83.354, 83.682, 83.822, 84.409, 85.165, 85.698, 86.418, 86.805],
    );
  });
});

describe('ta.stdev', () => {
  it('matches the reference row: the population standard deviation', () => {
    expectRow(
      run(new Stdev(5), CLOSES),
      4,
      [0.948, 0.875, 0.28, 0.423, 0.605, 0.671, 0.871, 0.926, 1.019, 1.174, 0.758],
    );
  });

  it('is zero for a flat window', () => {
    expect(run(new Stdev(3), [2, 2, 2]).at(-1)).toBe(0);
  });
});

describe('ta.change', () => {
  it('is na on the first value, then the difference from the one before', () => {
    expect(run(new Change(), [5, 7, 4])).toEqual([Number.NaN, 2, -3]);
  });
});

describe('save and restore', () => {
  it('go back one commit, so a corrected bar gives what it would have first time', () => {
    for (const make of [
      () => new Sma(3),
      () => new Rma(3),
      () => new Ema(3),
      () => new Wma(3),
      () => new Stdev(3),
    ]) {
      const straight = make();
      const corrected = make();
      run(straight, [1, 4, 2, 8, 5]);
      run(corrected, [1, 4, 2, 8]);
      const saved = corrected.save();
      corrected.next(99, true); // the bar as first seen
      corrected.restore(saved);
      corrected.next(5, true); // the exchange's final word on it
      expect(corrected.next(6, true)).toBe(straight.next(6, true));
    }
  });
});
