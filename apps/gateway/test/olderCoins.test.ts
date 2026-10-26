import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ListedCoin, LiveCoinWatchClient } from '../src/cryptocap/livecoinwatch.ts';
import {
  addPoints,
  CHOSEN_RANK,
  COINS_FROM_MS,
  type CoinDays,
  chooseCoins,
  coinWindows,
  GIVE_UP_AFTER,
  isDerivative,
  lookAtGroups,
  MonthRanks,
  matchCoins,
  monthCaps,
  monthOf,
  OlderCoins,
  PEAK_MIN,
  parseCoinDays,
  peakOf,
  type StoredListed,
  WINDOW_DAYS,
} from '../src/cryptocap/olderCoins.ts';
import { SecretStore } from '../src/storage/secrets.ts';
import { type FakeListedCoin, fakeLiveCoinWatch } from './helpers/FakeLiveCoinWatch.ts';

const DAY = 86_400_000;
const KEY = 'lcw-test-key-0000';
/** Our first day in these tests: the download reaches a week past it, 2018-06-08. */
const JOIN = Date.UTC(2018, 5, 1);
const SPAN_END = JOIN + 7 * DAY;

const listedCoin = (overrides: Partial<ListedCoin>): ListedCoin => ({
  code: 'X',
  name: 'X',
  rate: 1,
  cap: 0,
  allTimeHighUSD: 0,
  circulatingSupply: 0,
  totalSupply: 0,
  maxSupply: 0,
  categories: [],
  markets: 1,
  ...overrides,
});
const kept = (
  code: string,
  peak: number,
  markets = 1,
  extra: { name?: string; price?: number; categories?: string[] } = {},
): StoredListed => [
  code,
  extra.name ?? code,
  peak,
  extra.price ?? 1,
  extra.categories ?? [],
  markets,
];

describe('older coins: which coins', () => {
  it("puts a coin's peak at its highest price times its circulating or total supply", () => {
    expect(
      peakOf(listedCoin({ allTimeHighUSD: 2, circulatingSupply: 5e6, totalSupply: 8e6 })),
    ).toBe(1.6e7);
    // A maximum supply can be any number: it isn't counted.
    expect(peakOf(listedCoin({ allTimeHighUSD: 2, maxSupply: 1e15 }))).toBe(0);
  });

  it('tells tokens standing for other coins, which TradingView leaves out', () => {
    expect(isDerivative('Wrapped Bitcoin', [])).toBe(true);
    expect(isDerivative('Lido Staked ETH', [])).toBe(true);
    expect(isDerivative('Some token', ['liquid_staking'])).toBe(true);
    expect(isDerivative('Bitcoin', ['smart_contract_platforms'])).toBe(false);
  });

  it("finds CoinGecko's coins by symbol and price, not symbol alone", () => {
    const listed = [
      kept('BTM', 1e8, 1, { name: 'Bitmark', price: 0.01 }),
      kept('__BTM', 1e9, 1, { name: 'Bytom', price: 0.005 }),
      kept('XRP', 1e11, 1, { name: 'XRP', price: 2 }),
      kept('OLDNAME', 1e8, 0, { name: 'Same Name', price: 0 }),
    ];
    const matched = matchCoins(listed, [
      { id: 'bytom', symbol: 'btm', name: 'Bytom', price: 0.0051 },
      { id: 'ripple', symbol: 'xrp', name: 'XRP', price: 2.1 },
      // Without a price to compare, the same name will do.
      { id: 'same-name', symbol: 'oldname', name: 'Same name', price: 1 },
      // A price 40% off is another coin.
      { id: 'other', symbol: 'btm', name: 'Other', price: 0.014 },
    ]);
    expect(matched).toEqual({ __BTM: 'bytom', XRP: 'ripple', OLDNAME: 'same-name' });
  });

  it('looks at coins most likely to have counted first, in groups, and leaves out dead ones without a believable peak', () => {
    const listed = [
      kept('JUNK', 6.3e25, 0),
      kept('DEAD', 6e8, 0),
      kept('DEADER', 3e7, 0),
      kept('TINY', 1e6, 0),
      kept('BIG', 5e10),
      kept('MID', 1e9),
      kept('LUNC', 8e14, 56),
      kept('FTM', 0, 13),
      kept('BTC', 2.6e12),
    ];
    expect(lookAtGroups(listed, { BTC: 'bitcoin' })).toEqual([
      ['BTC'],
      ['BIG', 'MID'],
      ['LUNC', 'FTM'],
      ['DEAD', 'DEADER'],
    ]);
  });

  it("tells whether a coin comes within each month's 250 largest of those so far", () => {
    const ranks = new MonthRanks();
    for (let i = 0; i < 250; i++) expect(ranks.add([[3, 1_000 + i]])).toBe(true);
    expect(ranks.add([[3, 999]])).toBe(false);
    expect(
      ranks.add([
        [3, 999],
        [4, 1],
      ]),
    ).toBe(true);
    expect(ranks.add([[3, 1_100]])).toBe(true);
    // 1,100 pushed 1,000 out: 1,001 is now the 250th.
    expect(ranks.add([[3, 1_000.5]])).toBe(false);
    expect(ranks.add([[3, 1_001.5]])).toBe(true);
  });

  it("chooses each month's 200 largest, the 60 largest stablecoins, and CoinGecko's coins", () => {
    const listed: StoredListed[] = [];
    const months: Record<string, [number, number][]> = {};
    for (let i = 0; i < CHOSEN_RANK + 5; i++) {
      const code = `C${String(i).padStart(3, '0')}`;
      listed.push(kept(code, 1e9));
      months[code] = [[0, 1e9 - i * 1e6]];
    }
    // A wrapped coin larger than all: it neither counts nor takes a place.
    listed.push(kept('WBTC', 1e10, 1, { name: 'Wrapped Bitcoin' }));
    months.WBTC = [[0, 2e9]];
    // A small stablecoin, one of the largest stablecoins.
    listed.push(kept('USDX', 1e8, 1, { categories: ['stablecoins'] }));
    months.USDX = [[0, 1e5]];
    // A coin CoinGecko has today that never counted.
    listed.push(kept('NEW', 1e8));
    months.NEW = [];
    const chosen = chooseCoins(listed, months, { NEW: 'new-coin' });
    expect(chosen.slice(0, 3)).toEqual(['C000', 'C001', 'C002']);
    expect(chosen).toContain('C199');
    expect(chosen).not.toContain('C200');
    expect(chosen).not.toContain('WBTC');
    expect(chosen.slice(-2)).toEqual(['USDX', 'NEW']);
  });
});

describe("older coins: each coin's days", () => {
  const span: [number, number] = [COINS_FROM_MS, SPAN_END];

  it('asks for 100 days at a time, from a month before its first market cap, carrying on where it stopped', () => {
    const all = coinWindows(span, [[monthOf(Date.UTC(2018, 3, 15)), 1e9]], 0);
    // From 1 March, a month before April; the 100 days reach past the span's end, so they stop there.
    expect(all).toEqual([[Date.UTC(2018, 3, 1) - 31 * DAY, SPAN_END]]);
    const long = coinWindows([COINS_FROM_MS, Date.UTC(2019, 0, 1)], undefined, 0);
    expect(long[0]).toEqual([COINS_FROM_MS, COINS_FROM_MS + 100 * DAY]);
    expect(long.at(-1)?.[1]).toBe(Date.UTC(2019, 0, 1));
    expect(long.every(([from, to]) => to - from <= WINDOW_DAYS * DAY)).toBe(true);
    // Without market caps by month, from the span's start; once some came, from there.
    expect(coinWindows(span, undefined, 0)[0]?.[0]).toBe(COINS_FROM_MS);
    expect(coinWindows(span, undefined, COINS_FROM_MS + 100 * DAY)[0]?.[0]).toBe(
      COINS_FROM_MS + 100 * DAY,
    );
  });

  it("keeps a day's last point as that day's, earlier days put in front", () => {
    const empty: CoinDays = { version: 1, code: 'X', start: 0, caps: [], prices: [], fetched: 0 };
    const d = (day: number, hour = 0) => Date.UTC(2019, 0, day, hour);
    let days = addPoints(empty, [
      { date: d(5), cap: 10, rate: 1 },
      { date: d(5, 23), cap: 12, rate: 1.2 },
      { date: d(7), cap: 14, rate: 1.4 },
    ]);
    expect(days.start).toBe(d(5) / 1000);
    expect(days.caps).toEqual([12, null, 14]);
    days = addPoints(days, [{ date: d(3), cap: 8, rate: 0.8 }]);
    expect(days.start).toBe(d(3) / 1000);
    expect(days.caps).toEqual([8, null, 12, null, 14]);
    expect(days.prices).toEqual([0.8, null, 1.2, null, 1.4]);
  });

  it("puts a coin's points into months, each its highest market cap", () => {
    expect(
      monthCaps([
        { date: Date.UTC(2018, 1, 2), cap: 1_234_567, rate: 1 },
        { date: Date.UTC(2018, 1, 20), cap: 2_000_000, rate: 1 },
        { date: Date.UTC(2019, 0, 1), cap: 5, rate: 1 },
      ]),
    ).toEqual([
      [1, 2_000_000],
      [12, 5],
    ]);
  });
});

/** A coin worth `cap` at price 2 between `from` and `to` (epoch ms), nothing outside. */
function coin(
  code: string,
  cap: number,
  {
    from = 0,
    to = Number.POSITIVE_INFINITY,
    ...extra
  }: Partial<FakeListedCoin> & {
    from?: number;
    to?: number;
  } = {},
): FakeListedCoin {
  return {
    code,
    name: code,
    ath: (cap / 1e6) * 4,
    supply: 1e6,
    rate: 2,
    at: (ms) => (ms >= from && ms < to ? { cap, rate: 2 } : null),
    ...extra,
  };
}

/** A request for a coin's months: its whole span at once; the others are 100-day windows. */
const isCoarse = ({ path, body }: { path: string; body: Record<string, unknown> }) =>
  path === '/coins/single/history' && body.start === COINS_FROM_MS && body.end === SPAN_END - 1;
const isDaily = (request: { path: string; body: Record<string, unknown> }) =>
  request.path === '/coins/single/history' && !isCoarse(request);

interface Setup {
  coins: FakeListedCoin[];
  key?: boolean;
  dataDir?: string;
  status?: (path: string) => number | null;
  credits?: () => number;
  onRequest?: (path: string, body: Record<string, unknown>) => void;
}

async function setup({ coins, key = true, dataDir, status, credits, onRequest }: Setup) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'tn-older-coins-'));
  const secrets = new SecretStore(dir, {});
  if (key) await secrets.saveLiveCoinWatch(KEY);
  const fake = fakeLiveCoinWatch({
    cap: () => 0,
    coins,
    ...(status ? { status } : {}),
    ...(credits ? { credits } : {}),
    ...(onRequest ? { onRequest } : {}),
  });
  const waits: number[] = [];
  const older = new OlderCoins({
    secrets,
    dataDir: dir,
    joinMs: () => JOIN,
    universe: () => [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', price: 2 }],
    client: new LiveCoinWatchClient({ url: 'http://lcw.test', fetch: fake.fetch }),
    gapMs: 0,
    sleep: async (ms) => {
      waits.push(ms);
    },
    now: () => JOIN + 400 * DAY,
  });
  return { older, fake, waits, dataDir: dir };
}

const daysOf = async (older: OlderCoins, code: string): Promise<CoinDays | null> => {
  const path = older.coinPath(code);
  return path ? parseCoinDays(JSON.parse(readFileSync(path, 'utf8'))) : null;
};

describe('older coins: the download', () => {
  it('does nothing without a Live Coin Watch key', async () => {
    const { older, fake } = await setup({ coins: [coin('BTC', 1e12)], key: false });
    await older.start();
    await older.idle();
    expect(fake.requests).toEqual([]);
    expect(await older.status()).toEqual({ state: 'none', progress: 0, message: null });
  });

  it('reads the list, looks at each coin that may have counted, and downloads every day of those that did', async () => {
    const { older, fake } = await setup({
      coins: [
        coin('BTC', 1e12),
        // Dead since 2018-04-01, no longer traded, but worth a look by its peak.
        coin('OLD', 5e8, { markets: 0, to: Date.UTC(2018, 3, 1) }),
        // Never worth PEAK_MIN, and no longer traded: not even looked at.
        coin('JUNK', 1e5, { markets: 0, ath: 1e-3, supply: 1e9 }),
        // Gone from Live Coin Watch's history: looked at, nothing comes.
        coin('GONE', 1e9, { at: () => null }),
      ],
    });
    expect(peakOf(listedCoin({ allTimeHighUSD: 1e-3, circulatingSupply: 1e9 }))).toBeLessThan(
      PEAK_MIN,
    );
    await older.start();
    await older.idle();
    expect(await older.status()).toMatchObject({ state: 'done', progress: 1 });
    const contents = await older.contents();
    expect(contents.matched).toEqual({ BTC: 'bitcoin' });
    expect(contents.chosen).toEqual(['BTC', 'OLD']);

    const btc = await daysOf(older, 'BTC');
    expect(btc?.start).toBe(COINS_FROM_MS / 1000);
    expect(btc?.caps.length).toBe((SPAN_END - COINS_FROM_MS) / DAY);
    expect(btc?.caps.every((cap) => cap === 1e12)).toBe(true);
    expect(btc?.prices.every((price) => price === 2)).toBe(true);
    const old = await daysOf(older, 'OLD');
    expect(old?.caps.filter((cap) => cap !== null).length).toBe(
      (Date.UTC(2018, 3, 1) - COINS_FROM_MS) / DAY,
    );

    const paths = fake.requests.map(({ path, body }) => `${path} ${body.code ?? body.offset}`);
    expect(paths.filter((p) => p.startsWith('/coins/list'))).toEqual(['/coins/list 0']);
    const coarse = (code: string) =>
      fake.requests.filter((request) => isCoarse(request) && request.body.code === code).length;
    expect([coarse('BTC'), coarse('OLD'), coarse('GONE'), coarse('JUNK')]).toEqual([1, 1, 1, 0]);
    // Each chosen coin's days, 100 at a time: 2 requests each over these 127 days.
    expect(fake.requests.filter(isDaily).map(({ body }) => body.code)).toEqual([
      'BTC',
      'BTC',
      'OLD',
      'OLD',
    ]);
  });

  it('carries on after a stop where it was, asking nothing twice', async () => {
    const coins = [coin('BTC', 1e12), coin('ETH', 3e11), coin('XRP', 5e10)];
    const dataDir = mkdtempSync(join(tmpdir(), 'tn-older-coins-'));
    let made = 0;
    let closing: Promise<void> = Promise.resolve();
    const first = await setup({
      coins,
      dataDir,
      onRequest: () => {
        if (++made === 4) closing = first.older.close();
      },
    });
    await first.older.start();
    await first.older.idle();
    // As the gateway does on a restart: its close saves what came in.
    await closing;
    expect((await first.older.status()).state).not.toBe('done');

    const second = await setup({ coins, dataDir });
    await second.older.start();
    await second.older.idle();
    expect(await second.older.status()).toMatchObject({ state: 'done', progress: 1 });
    const all = [...first.fake.requests, ...second.fake.requests].map(
      ({ path, body }) =>
        `${path} ${body.code ?? ''} ${body.offset ?? ''} ${body.start ?? ''} ${body.end ?? ''}`,
    );
    expect(new Set(all).size).toBe(all.length);
    expect((await second.older.contents()).chosen).toEqual(['BTC', 'ETH', 'XRP']);
    expect((await daysOf(second.older, 'XRP'))?.caps.every((cap) => cap === 5e10)).toBe(true);
  });

  it("stops at a list page Live Coin Watch can't give, rather than take it for the end", async () => {
    let refuse = true;
    const { older, fake } = await setup({
      coins: [coin('BTC', 1e12)],
      status: (path) => (path === '/coins/list' && refuse ? 400 : null),
    });
    await older.start();
    await older.idle();
    expect(await older.status()).toMatchObject({
      state: 'error',
      message: "Live Coin Watch's list couldn't be read",
    });
    expect(fake.requests.filter(isCoarse)).toEqual([]);
    refuse = false;
    await older.restart();
    await older.idle();
    expect((await older.contents()).chosen).toEqual(['BTC']);
  });

  it('reads the list page after page', async () => {
    const coins = Array.from({ length: 230 }, (_, i) =>
      coin(`Z${String(i).padStart(3, '0')}`, 1e3, { markets: 0, ath: 0 }),
    );
    const { older, fake } = await setup({ coins: [...coins, coin('BTC', 1e12)] });
    await older.start();
    await older.idle();
    expect(
      fake.requests.filter(({ path }) => path === '/coins/list').map(({ body }) => body.offset),
    ).toEqual([0, 100, 200]);
    expect((await older.contents()).listed.map(([code]) => code)).toEqual(['BTC']);
  });

  it(`stops looking at a group once ${GIVE_UP_AFTER} in a row never came near the largest`, async () => {
    const big = Array.from({ length: 250 }, (_, i) =>
      coin(`B${String(i).padStart(3, '0')}`, 1e10 - i * 1e6),
    );
    const small = Array.from({ length: GIVE_UP_AFTER + 50 }, (_, i) =>
      coin(`S${String(i).padStart(4, '0')}`, 1e3, { ath: 1e3, supply: 1e6 - i }),
    );
    const { older, fake } = await setup({ coins: [...big, ...small] });
    await older.start();
    await older.idle();
    // Every big coin, then the small ones until 1,000 in a row came nowhere near.
    expect(fake.requests.filter(isCoarse).length).toBe(250 + GIVE_UP_AFTER);
  });

  it('waits when asked to slow down, and for the day when its requests are used up', async () => {
    let limited = 2;
    let credits = 10;
    const { older, waits } = await setup({
      coins: [coin('BTC', 1e12)],
      status: (path) => (path === '/coins/single/history' && limited-- > 0 ? 429 : null),
      credits: () => (limited === 0 ? credits-- && 0 : credits),
    });
    await older.start();
    await older.idle();
    expect(waits).toContain(30_000);
    expect(waits.some((ms) => ms > 30_000)).toBe(true);
    expect((await older.status()).state).toBe('done');
  });
});
