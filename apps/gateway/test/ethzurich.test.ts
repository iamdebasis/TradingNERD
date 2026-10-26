import { describe, expect, it } from 'vitest';
import { parseEthZurich } from '../src/cryptocap/ethzurich.ts';

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

const CAPS = [
  'Date,bitcoin,ethereum,tinycoin,bigonce',
  '2017-09-14,,,,',
  '2017-09-15,52500000000,2.8E10,1000,',
  '2017-09-16,6.08e10,,900,5e10',
  '2017-09-17,60000000000.0,2.9e10,nan,',
].join('\n');
const CLOSES = [
  'Date,bitcoin,ethereum,tinycoin,bigonce',
  '2017-09-14,3154.95,212,0.5,',
  '2017-09-15,3637.52,247,0.45,0.9',
  '2017-09-16,3625.04,248,0.44,1',
  '2017-09-17,3582.88,255,0.40,2',
].join('\n');

describe("ETH Zurich's dataset", () => {
  it("pairs each day's market cap, at its opening, with the close the day before", () => {
    const coins = parseEthZurich(CAPS, CLOSES, 2);
    const bitcoin = coins.find((coin) => coin.slug === 'bitcoin');
    expect(bitcoin?.points).toEqual([
      [day('2017-09-15'), 52_500_000_000, 3154.95],
      [day('2017-09-16'), 60_800_000_000, 3637.52],
      [day('2017-09-17'), 60_000_000_000, 3625.04],
    ]);
    // So market cap ÷ price is the supply at midnight: 16.6M on 15 September 2017.
    const [, cap, price] = bitcoin?.points[0] ?? [0, 0, 1];
    expect(cap / price / 1e6).toBeCloseTo(16.64, 2);
    // Days without a market cap, or without the close before, are left out.
    expect(coins.find((coin) => coin.slug === 'ethereum')?.points.map(([t]) => t)).toEqual([
      day('2017-09-15'),
      day('2017-09-17'),
    ]);
  });

  it('keeps the coins ranked in the top N on some day, and no others', () => {
    // Top 2: bitcoin and ethereum, then bitcoin and bigonce on the 16th; tinycoin never. A coin
    // without a day it has both figures for (a market cap and the close before) isn't kept.
    expect(parseEthZurich(CAPS, CLOSES, 2).map((coin) => coin.slug)).toEqual([
      'bigonce',
      'bitcoin',
      'ethereum',
    ]);
    expect(parseEthZurich(CAPS, CLOSES, 4).map((coin) => coin.slug)).toContain('tinycoin');
  });
});
