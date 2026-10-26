import { describe, expect, it } from 'vitest';
import {
  DATASET_END_SEC,
  entityDays,
  matchDataset,
  rollingMedian,
} from '../src/cryptocap/olderBook.ts';

const DAY = 86_400;
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
/** Days from `from` for `count` days: [day, cap, price] with the price and supply given. */
const days = (
  from: number,
  count: number,
  price: (i: number) => number,
  supply: (i: number) => number,
): [number, number, number][] =>
  Array.from({ length: count }, (_, i) => [from + i * DAY, price(i) * supply(i), price(i)]);

describe('older coins: the book', () => {
  it("takes the week's median, so one day's odd figure doesn't move a supply, while a real step does", () => {
    const blip = [100, 100, 100, 130, 100, 100, 100];
    expect(rollingMedian(blip)).toEqual([100, 100, 100, 100, 100, 100, 100]);
    const step = [100, 100, 100, 100, 200, 200, 200, 200, 200];
    expect(rollingMedian(step)).toEqual([100, 100, 100, 100, 200, 200, 200, 200, 200]);
    expect(rollingMedian([1, Number.NaN, 3])[1]).toBeNaN();
  });

  it("matches the dataset's coins to Live Coin Watch's by price over the week both have, not by name", () => {
    const week = day(2018, 2, 1);
    const dataset = [
      {
        slug: 'binance-coin',
        points: days(
          week,
          7,
          () => 10,
          () => 1e8,
        ),
      },
      {
        slug: 'tether',
        points: days(
          week,
          7,
          () => 1,
          () => 2.2e9,
        ),
      },
      {
        slug: 'true-usd',
        points: days(
          week,
          7,
          () => 1,
          () => 4e7,
        ),
      },
      {
        slug: 'gone-coin',
        points: days(
          week,
          7,
          () => 3,
          () => 1e6,
        ),
      },
    ];
    const lcw = new Map([
      [
        'BNB',
        days(
          week,
          7,
          () => 10.1,
          () => 0.95e8,
        ),
      ],
      // Both cost a dollar: their market caps tell them apart.
      [
        'TUSD',
        days(
          week,
          7,
          () => 1,
          () => 4.5e7,
        ),
      ],
      [
        'USDT',
        days(
          week,
          7,
          () => 1.001,
          () => 2.3e9,
        ),
      ],
      // Same price as gone-coin, a thousand times the market cap: another coin.
      [
        'OTHER',
        days(
          week,
          7,
          () => 3,
          () => 1e9,
        ),
      ],
    ]);
    expect(Object.fromEntries(matchDataset(dataset, lcw))).toEqual({
      'binance-coin': 'BNB',
      tether: 'USDT',
      'true-usd': 'TUSD',
    });
  });

  it("scales Live Coin Watch's supplies to meet the dataset's and CoinGecko's, so neither change shows a step", () => {
    const dataset = days(
      day(2017, 12, 1),
      69,
      () => 2,
      () => 1_000,
    );
    // Live Coin Watch counts 10% fewer coins in 2018 and 20% more by the join.
    const lcwFrom = day(2018, 2, 1);
    const ownDay = lcwFrom + 400 * DAY;
    const lcw = days(
      lcwFrom,
      407,
      (i) => 2 + i / 100,
      (i) => (i < 200 ? 900 : 1_200),
    );
    const out = entityDays({ dataset, lcw, own: { day: ownDay, supply: 1_000 } });
    const at = (sec: number) => out.find(([d]) => d === sec) as [number, number, number, number];
    const datasetLast = at(DATASET_END_SEC);
    const lcwFirst = at(DATASET_END_SEC + DAY);
    // Across 7/8 February 2018: the price's move only.
    expect(lcwFirst[3]).toBeCloseTo(datasetLast[3], 6);
    expect(lcwFirst[1] / lcwFirst[2]).toBeCloseTo(datasetLast[1] / datasetLast[2], 6);
    // At CoinGecko's first day, its supply.
    const own = at(ownDay);
    expect(own[3]).toBeCloseTo(1_000, 6);
    expect(own[1] / own[2]).toBeCloseTo(1_000, 6);
    // Between, Live Coin Watch's own moves (its step from 900 to 1,200) carry through.
    const before = at(lcwFrom + 198 * DAY);
    const after = at(lcwFrom + 202 * DAY);
    expect(after[1] / after[2] / (before[1] / before[2])).toBeGreaterThan(1.3);
    // Every day's price is the source's own.
    expect(
      out.every(
        ([d, , price]) => price === (d <= DATASET_END_SEC ? 2 : 2 + (d - lcwFrom) / DAY / 100),
      ),
    ).toBe(true);
  });

  it("keeps a source's own market cap when its price is off for days, where a supply from it would be absurd", () => {
    // A small coin whose price reads a millionth of what it was for a week.
    const dataset = days(
      day(2017, 1, 1),
      20,
      (i) => (i >= 5 && i < 12 ? 1e-6 : 1),
      () => 1e6,
    ).map(([d, , price]): [number, number, number] => [d, 1e6, price]);
    const out = entityDays({ dataset });
    expect(out.every(([, cap]) => cap === 1e6)).toBe(true);
    expect(out.find(([d]) => d === day(2017, 1, 20))?.[3]).toBe(1e6);
  });

  it('keeps a coin found in only one of the two as it is', () => {
    const dataset = days(
      day(2017, 1, 1),
      10,
      () => 5,
      () => 100,
    );
    expect(entityDays({ dataset }).map(([, cap]) => cap)).toEqual(dataset.map(([, cap]) => cap));
    const lcw = days(
      day(2019, 1, 1),
      10,
      () => 5,
      () => 100,
    );
    expect(entityDays({ lcw }).map(([, cap]) => cap)).toEqual(lcw.map(([, cap]) => cap));
  });
});
