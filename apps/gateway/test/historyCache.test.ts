import { type Bar, type BarsResponse, parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FINAL_AFTER_MS,
  HistoryCache,
  LATEST_TTL_MS,
  MAX_PAGES,
  OLDER_TTL_MS,
} from '../src/market/historyCache.ts';
import { MarketService } from '../src/market/MarketService.ts';
import { dailyBars, FakeExchange } from './helpers/FakeExchange.ts';

const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
};
const MINUTE = 60_000;
const NOON = Date.UTC(2026, 9, 19, 12, 0);

/** Minute bars opening every minute up to `lastOpen`, their close tagged with `version`. */
const minutes = (lastOpen: number, n: number, version = 1): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const time = (lastOpen - (n - 1 - i) * MINUTE) / 1000;
    return { time, open: 1, high: 2, low: 0.5, close: version, volume: 1 };
  });

/** A clock the test moves, and a loader of the latest minute bars as of that clock. */
function setup(start: number) {
  let now = start;
  let version = 1;
  const loads: number[] = [];
  const cache = new HistoryCache({ now: () => now });
  const load = async (n: number): Promise<BarsResponse> => {
    loads.push(n);
    return {
      bars: minutes(Math.floor(now / MINUTE) * MINUTE, n, version),
      hasMore: true,
      fromListing: false,
    };
  };
  return {
    cache,
    load,
    loads,
    at: (ms: number) => {
      now = ms;
    },
    newData: () => {
      version++;
    },
  };
}

describe('HistoryCache, latest pages', () => {
  it('answers a page again while only its live bar is out of date', async () => {
    const { cache, load, loads, at } = setup(NOON + 30_000);
    const first = await cache.latest('k', r('1'), 10, load);
    at(NOON + 55_000);
    expect(await cache.latest('k', r('1'), 10, load)).toBe(first);
    expect(loads).toEqual([10]);
  });

  it('fetches just the newer bars once the page falls behind, keeping the count', async () => {
    const { cache, load, loads, at, newData } = setup(NOON + 30_000);
    await cache.latest('k', r('1'), 10, load);
    at(NOON + 3 * MINUTE + 30_000);
    newData();
    const page = await cache.latest('k', r('1'), 10, load);
    // From 12:00, which may have changed since, to the live 12:03: 4 bars, and 2 to spare.
    expect(loads).toEqual([10, 6]);
    expect(page.bars.map((bar) => (bar.time * 1000 - NOON) / MINUTE)).toEqual([
      -6, -5, -4, -3, -2, -1, 0, 1, 2, 3,
    ]);
    // The 6 bars fetched again replace the kept ones; older ones are kept as they were.
    expect(page.bars.map((bar) => bar.close)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(page.hasMore).toBe(true);
  });

  it('a page that starts at the listing says so until newer bars push its first bar out', async () => {
    let now = NOON + 30_000;
    const cache = new HistoryCache({ now: () => now });
    const LISTED = NOON - 5 * MINUTE; // a pair listed at 11:55
    const load = async (n: number): Promise<BarsResponse> => {
      const liveOpen = Math.floor(now / MINUTE) * MINUTE;
      const all = minutes(liveOpen, (liveOpen - LISTED) / MINUTE + 1);
      const bars = all.slice(-n);
      const hasMore = bars.length < all.length;
      return { bars, hasMore, fromListing: !hasMore };
    };
    const first = await cache.latest('k', r('1'), 8, load);
    expect(first.bars).toHaveLength(6);
    expect(first).toMatchObject({ hasMore: false, fromListing: true });
    now = NOON + MINUTE + 30_000; // 12:01: seven bars, the page still holds them all
    const caughtUp = await cache.latest('k', r('1'), 8, load);
    expect(caughtUp.bars).toHaveLength(7);
    expect(caughtUp).toMatchObject({ hasMore: false, fromListing: true });
    now = NOON + 3 * MINUTE + 30_000; // 12:03: nine bars, one more than the page holds
    const trimmed = await cache.latest('k', r('1'), 8, load);
    expect(trimmed.bars).toHaveLength(8);
    expect(trimmed).toMatchObject({ hasMore: true, fromListing: false });
  });

  it('fetches the bar before the live one again if the page came moments after it closed', async () => {
    const { cache, load, loads, at } = setup(NOON + 5_000); // 12:00:05: 11:59 may still change
    await cache.latest('k', r('1'), 10, load);
    at(NOON + 40_000);
    await cache.latest('k', r('1'), 10, load);
    expect(loads).toEqual([10, 4]);
    // Fetched again at 12:00:40, every bar but the live one is final: answered as it is.
    at(NOON + 50_000);
    await cache.latest('k', r('1'), 10, load);
    expect(loads).toEqual([10, 4]);
    expect(FINAL_AFTER_MS).toBeLessThan(40_000 - 5_000);
  });

  it('fetches a page that fell far behind whole, and one past its lifetime', async () => {
    const { cache, load, loads, at } = setup(NOON + 30_000);
    await cache.latest('k', r('1'), 10, load);
    at(NOON + 600 * MINUTE + 30_000);
    await cache.latest('k', r('1'), 10, load);
    expect(loads).toEqual([10, 10]);

    const daily = setup(NOON);
    await daily.cache.latest('d', r('1D'), 10, daily.load);
    daily.at(NOON + LATEST_TTL_MS);
    await daily.cache.latest('d', r('1D'), 10, daily.load);
    expect(daily.loads).toEqual([10, 10]);
  });

  it('counts calendar months when catching up', async () => {
    const loads: number[] = [];
    let now = Date.UTC(2026, 3, 30, 23, 55); // April's last minutes
    const months = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const date = new Date(now);
        const time = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - (n - 1 - i), 1) / 1000;
        return { time, open: 1, high: 1, low: 1, close: 1, volume: 1 };
      });
    const cache = new HistoryCache({ now: () => now });
    const load = async (n: number) => {
      loads.push(n);
      return { bars: months(n), hasMore: true, fromListing: false };
    };
    await cache.latest('m', r('1M'), 12, load);
    now = Date.UTC(2026, 4, 1, 0, 2); // May has begun: April and May are fetched again
    const page = await cache.latest('m', r('1M'), 12, load);
    expect(loads).toEqual([12, 4]);
    expect(page.bars.at(-1)?.time).toBe(Date.UTC(2026, 4, 1) / 1000);
    expect(page.bars).toHaveLength(12);
  });
});

describe('HistoryCache, older pages and housekeeping', () => {
  it('keeps pages of final bars for a while, but not ones that end moments ago', async () => {
    let now = NOON;
    const cache = new HistoryCache({ now: () => now });
    let loads = 0;
    const page = (lastOpen: number) => async () => {
      loads++;
      return { bars: minutes(lastOpen, 5), hasMore: true, fromListing: false };
    };
    await cache.older('old', r('1'), page(NOON - 60 * MINUTE));
    await cache.older('old', r('1'), page(NOON - 60 * MINUTE));
    expect(loads).toBe(1);
    now += OLDER_TTL_MS;
    await cache.older('old', r('1'), page(NOON - 60 * MINUTE));
    expect(loads).toBe(2);

    // Its last bar closed 5 s before: it could still change, so it isn't kept.
    now = NOON + 5_000;
    await cache.older('recent', r('1'), page(NOON - MINUTE));
    await cache.older('recent', r('1'), page(NOON - MINUTE));
    expect(loads).toBe(4);
  });

  it('shares a fetch between identical requests, and keeps no failure', async () => {
    const cache = new HistoryCache({ now: () => NOON });
    let calls = 0;
    let fail = true;
    const load = async (n: number) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) throw new Error('unreachable');
      return { bars: minutes(NOON, n), hasMore: true, fromListing: false };
    };
    const both = [cache.latest('k', r('1'), 3, load), cache.latest('k', r('1'), 3, load)];
    await expect(Promise.all(both)).rejects.toThrow('unreachable');
    expect(calls).toBe(1);
    fail = false;
    expect((await cache.latest('k', r('1'), 3, load)).bars).toHaveLength(3);
    expect(calls).toBe(2);
  });

  it(`keeps ${MAX_PAGES} pages, dropping the least recently used`, async () => {
    const cache = new HistoryCache({ now: () => NOON - 60 * MINUTE });
    let loads = 0;
    const load = async () => {
      loads++;
      return { bars: minutes(NOON - 120 * MINUTE, 2), hasMore: true, fromListing: false };
    };
    for (let i = 0; i < MAX_PAGES; i++) await cache.older(`p${i}`, r('1'), load);
    await cache.older('p0', r('1'), load); // used again: now the most recent
    await cache.older('extra', r('1'), load); // drops p1
    expect(loads).toBe(MAX_PAGES + 1);
    await cache.older('p0', r('1'), load);
    expect(loads).toBe(MAX_PAGES + 1);
    await cache.older('p1', r('1'), load);
    expect(loads).toBe(MAX_PAGES + 2);
  });
});

describe('MarketService history cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const LAST = Date.UTC(2026, 9, 18) / 1000;

  it('answers a chart opened again from memory, unless turned off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((LAST + 43_200) * 1000);
    for (const cacheHistory of [true, false]) {
      const fake = new FakeExchange();
      fake.bars = dailyBars(10, LAST);
      const market = new MarketService([fake], { cacheHistory });
      const first = await market.getBars('FAKE:XRPUSDT', '1D', null, 5);
      const again = await market.getBars('FAKE:XRPUSDT', '1D', null, 5);
      expect(again).toEqual(first);
      expect(fake.fetchCalls).toHaveLength(cacheHistory ? 1 : 2);
    }
  });
});
