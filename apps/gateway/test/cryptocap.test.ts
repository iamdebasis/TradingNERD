import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Bar, type CatalogEntry, parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoCapExchange } from '../src/cryptocap/CryptoCapExchange.ts';
import { CoinGeckoClient } from '../src/logos/coingecko.ts';
import { CoinGeckoUsage } from '../src/logos/usage.ts';
import { type BarListener, type BookListener, MarketService } from '../src/market/MarketService.ts';
import { MarketError } from '../src/market/types.ts';
import { SecretStore } from '../src/storage/secrets.ts';
import { type FakeMarketRow, fakeCoinGecko } from './helpers/FakeCoinGecko.ts';
import { FakePairsExchange } from './helpers/FakePairsExchange.ts';

const KEY = 'CG-demo-key-3f9a';
const DAY_MS = 86_400_000;
/** Tuesday 2026-10-20, noon UTC. */
const NOW = Date.UTC(2026, 9, 20, 12);
const TODAY = Date.UTC(2026, 9, 20);
/** Ten daily bars: nine past days and today's. */
const DAYS = Array.from({ length: 10 }, (_, i) => TODAY - (9 - i) * DAY_MS);

/** Coins as CoinGecko lists them; supply = cap / price. */
const MARKETS: FakeMarketRow[] = [
  { id: 'bitcoin', symbol: 'BTC', price: 80_000, cap: 1.6e12 },
  { id: 'ethereum', symbol: 'ETH', price: 2_000, cap: 2.4e11 },
  { id: 'tether', symbol: 'USDT', price: 1, cap: 1.8e11 },
  { id: 'ripple', symbol: 'XRP', price: 1.25, cap: 7.5e10 },
  { id: 'usd-coin', symbol: 'USDC', price: 1, cap: 7e10 },
  // Ranked by CoinGecko but left out by TradingView (EXCLUDED_COINS).
  { id: 'figure-heloc', symbol: 'FIGR_HELOC', price: 1, cap: 2.6e10 },
  // No exchange of ours trades it: CoinGecko's market cap is used.
  { id: 'leo-token', symbol: 'LEO', price: 9, cap: 8.1e9 },
  { id: 'alpha', symbol: 'ALP', price: 1, cap: 6e9 },
  { id: 'beta', symbol: 'BET', price: 1, cap: 5e9 },
  { id: 'gamma', symbol: 'GAM', price: 1, cap: 4e9 },
  { id: 'delta', symbol: 'DEL', price: 1, cap: 3e9 },
  { id: 'epsilon', symbol: 'EPS', price: 1, cap: 2e9 },
  { id: 'zeta', symbol: 'ZET', price: 1, cap: 1e9 },
];
const supplyOf = (id: string) => {
  const row = MARKETS.find((coin) => coin.id === id) as FakeMarketRow;
  return row.cap / row.price;
};

/** Each coin's year of history: flat at its price and cap, a point a day. */
const CHARTS = Object.fromEntries(
  MARKETS.map((coin) => [
    coin.id,
    {
      prices: DAYS.map((ms) => [ms, coin.price] as [number, number]),
      caps: DAYS.map((ms) => [ms, coin.cap] as [number, number]),
    },
  ]),
);

const flat = (time: number, price: number): Bar => ({
  time,
  open: price,
  high: price,
  low: price,
  close: price,
  volume: 10,
});

/** Daily bars at `price`, today's closing at `today` (its high and low around both). */
function dailies(price: number, today = price): Bar[] {
  return DAYS.map((ms, i) =>
    i < DAYS.length - 1
      ? flat(ms / 1000, price)
      : {
          time: ms / 1000,
          open: price,
          high: Math.max(price, today),
          low: Math.min(price, today),
          close: today,
          volume: 10,
        },
  );
}

const pairEntry = (
  exchange: string,
  ticker: string,
  base: string,
  quote: string,
): CatalogEntry => ({
  exchange,
  ticker,
  base,
  quote,
  description: '',
  volumeUsd: 1e9,
  live: true,
  kind: 'spot',
});

const PAIRS: CatalogEntry[] = [
  pairEntry('BINANCE', 'BTCUSDT', 'BTC', 'USDT'),
  pairEntry('BINANCE', 'ETHUSDT', 'ETH', 'USDT'),
  pairEntry('BINANCE', 'XRPUSDT', 'XRP', 'USDT'),
  pairEntry('BINANCE', 'USDCUSDT', 'USDC', 'USDT'),
  pairEntry('COINBASE', 'USDTUSD', 'USDT', 'USD'),
];

interface SetupOptions {
  key?: boolean;
  xrpPrice?: number;
  /** False: the history stops loading after its first coin. */
  history?: boolean;
  /** Another instance's data folder, as after a restart. */
  dataDir?: string;
  /** The exchanges' pair lists, as they stand (all of them by default). */
  pairs?: () => readonly CatalogEntry[];
  waitForPairs?: () => Promise<void>;
}

async function setup({
  key = true,
  xrpPrice = 1.25,
  history = true,
  dataDir = join(mkdtempSync(join(tmpdir(), 'tradingnerd-cryptocap-')), 'data'),
  pairs = () => PAIRS,
  waitForPairs,
}: SetupOptions = {}) {
  const fake = fakeCoinGecko({
    markets: MARKETS,
    stablecoins: ['tether', 'usd-coin'],
    charts: CHARTS,
  });
  const secrets = new SecretStore(dataDir, {});
  if (key) await secrets.saveCoingecko(KEY, 'demo');
  const usage = new CoinGeckoUsage(dataDir);
  const binance = new FakePairsExchange('BINANCE');
  binance.setBars('BTCUSDT', '1D', dailies(80_000, 84_000));
  binance.setBars('ETHUSDT', '1D', dailies(2_000));
  binance.setBars('XRPUSDT', '1D', dailies(xrpPrice));
  binance.setBars('USDCUSDT', '1D', dailies(1));
  const coinbase = new FakePairsExchange('COINBASE');
  coinbase.setBars('USDTUSD', '1D', dailies(1));
  const warnings: string[] = [];
  const cryptocap = new CryptoCapExchange({
    client: new CoinGeckoClient({ fetch: fake.fetch, onCall: () => usage.record() }),
    secrets,
    usage,
    dataDir,
    adapters: [binance, coinbase],
    pairs,
    ...(waitForPairs ? { waitForPairs } : {}),
    // Without history, the backfill stops after its first coin, as if it were still loading.
    sleep: history ? async () => {} : () => new Promise<void>(() => {}),
    tickMs: 5,
    onWarning: (message) => warnings.push(message),
  });
  const market = new MarketService([binance, coinbase, cryptocap], { emitIntervalMs: 0 });
  if (key && history) {
    // The coins and their year of history, before the test asks for bars.
    await market.resolveSymbol('CRYPTOCAP:TOTAL');
    await cryptocap.historyIdle();
  }
  return { cryptocap, market, binance, coinbase, fake, usage, warnings, dataDir };
}

const D1 = parseResolution('1D') as Resolution;

/** A data folder keeping every coin's daily point from `oldest` (ms) to 10 days ago. */
function keptSince(oldest: number): string {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'tradingnerd-cryptocap-')), 'data');
  const days = Array.from(
    { length: (TODAY - 9 * DAY_MS - oldest) / DAY_MS },
    (_, i) => (oldest + i * DAY_MS) / 1000,
  );
  mkdirSync(join(dataDir, 'cryptocap'), { recursive: true });
  writeFileSync(
    join(dataDir, 'cryptocap', 'anchors.json'),
    JSON.stringify({
      version: 1,
      coins: Object.fromEntries(
        MARKETS.map((coin) => [coin.id, days.map((sec) => [sec, coin.cap, coin.price])]),
      ),
      history: {},
    }),
  );
  return dataDir;
}

/** TOTAL today: Bitcoin at 84,000, the rest at their prices, the excluded coin left out. */
const BTC_TODAY = 84_000 * supplyOf('bitcoin');
const TOTAL_TODAY =
  BTC_TODAY + 2.4e11 + 1.8e11 + 7.5e10 + 7e10 + 8.1e9 + 6e9 + 5e9 + 4e9 + 3e9 + 2e9 + 1e9;

describe('CRYPTOCAP', () => {
  let open: { market: MarketService }[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    for (const { market } of open) await market.close();
    open = [];
    vi.useRealTimers();
  });
  const track = <T extends { market: MarketService }>(made: T) => {
    open.push(made);
    return made;
  };

  it("describes TOTAL2 as TradingView does: an index in trillions, with CRYPTOCAP's badge", async () => {
    const { market } = track(await setup());
    const info = await market.resolveSymbol('CRYPTOCAP:TOTAL2');
    expect(info).toMatchObject({
      id: 'CRYPTOCAP:TOTAL2',
      exchange: 'CRYPTOCAP',
      exchangeName: 'CRYPTOCAP',
      ticker: 'TOTAL2',
      base: 'CRYPTOCAP',
      quote: 'USD',
      description: 'Crypto Total Market Cap Excluding BTC, $',
      type: 'index',
      format: 'volume',
      pricePrecision: 0,
      tickSize: 1,
      hasBook: true,
      delayMs: 0,
    });
  });

  it("shows a coin's dominance to four significant digits, with the coin's logo", async () => {
    const { market } = track(await setup());
    const info = await market.resolveSymbol('CRYPTOCAP:XRP.D');
    expect(info).toMatchObject({
      ticker: 'XRP.D',
      base: 'XRP',
      quote: '%',
      description: 'Market Cap XRP Dominance, %',
      format: 'price',
      // 75B of 2.27T is 3.3%: three decimals.
      pricePrecision: 3,
    });
  });

  it.each(['FIGR_HELOC', 'NOPE', 'TOTAL.D'])("doesn't have %s", async (ticker) => {
    const { market } = track(await setup());
    await expect(market.resolveSymbol(`CRYPTOCAP:${ticker}`)).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
  });

  it('asks for a CoinGecko key when there is none', async () => {
    const { market } = track(await setup({ key: false }));
    const error = await market.resolveSymbol('CRYPTOCAP:TOTAL').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketError);
    expect((error as MarketError).message).toMatch(/CoinGecko key/);
  });

  it("adds up the coins' market caps: exchange price × supply, CoinGecko's where none", async () => {
    const { market } = track(await setup());
    const { bars, hasMore } = await market.getBars('CRYPTOCAP:TOTAL', '1D', null, 3);
    expect(bars.map((bar) => bar.time)).toEqual(DAYS.slice(-3).map((ms) => ms / 1000));
    const today = bars.at(-1) as Bar;
    expect(today.close).toBeCloseTo(TOTAL_TODAY, -3);
    expect(today.open).toBeCloseTo(TOTAL_TODAY - BTC_TODAY + 1.6e12, -3);
    // A year back is further than these coins' points go, so there's more of it to ask for.
    expect(hasMore).toBe(true);
  });

  it('leaves Bitcoin out of TOTAL2, the top 10 out of OTHERS, and stablecoins out of TOTALES', async () => {
    const { market } = track(await setup());
    const close = async (ticker: string) =>
      ((await market.getBars(`CRYPTOCAP:${ticker}`, '1D', null, 1)).bars[0] as Bar).close;
    expect(await close('TOTAL2')).toBeCloseTo(TOTAL_TODAY - BTC_TODAY, -3);
    expect(await close('TOTAL3')).toBeCloseTo(TOTAL_TODAY - BTC_TODAY - 2.4e11, -3);
    // The 11th and 12th largest eligible coins: EPS and ZET.
    expect(await close('OTHERS')).toBeCloseTo(3e9, -3);
    expect(await close('TOTALES')).toBeCloseTo(TOTAL_TODAY - 1.8e11 - 7e10, -3);
    expect(await close('STABLE.C')).toBeCloseTo(1.8e11 + 7e10, -3);
    expect(await close('XRP')).toBeCloseTo(7.5e10, -3);
    expect(await close('LEO')).toBeCloseTo(8.1e9, -3);
  });

  it('gives dominance in percent and ratios against Bitcoin', async () => {
    const { market } = track(await setup());
    const close = async (ticker: string) =>
      ((await market.getBars(`CRYPTOCAP:${ticker}`, '1D', null, 1)).bars[0] as Bar).close;
    expect(await close('BTC.D')).toBeCloseTo((BTC_TODAY / TOTAL_TODAY) * 100, 9);
    expect(await close('OTHERS.D')).toBeCloseTo((3e9 / TOTAL_TODAY) * 100, 9);
    expect(await close('OTHERSBTC')).toBeCloseTo(3e9 / BTC_TODAY, 12);
  });

  it("uses CoinGecko's market cap for a coin whose pair is priced like another coin", async () => {
    const { market, warnings } = track(await setup({ xrpPrice: 125 }));
    const { bars } = await market.getBars('CRYPTOCAP:XRP', '1D', null, 1);
    expect((bars[0] as Bar).close).toBeCloseTo(7.5e10, -3);
    expect(warnings.some((w) => w.includes('BINANCE:XRPUSDT is priced unlike'))).toBe(true);
  });

  it('estimates with the latest market caps while the history is loading', async () => {
    const { market } = track(await setup({ history: false }));
    const { bars } = await market.getBars('CRYPTOCAP:TOTAL', '1D', null, 3);
    // Coins without a pair (LEO and the small ones) keep their market cap of now meanwhile.
    expect((bars.at(-1) as Bar).close).toBeCloseTo(TOTAL_TODAY, -3);
    expect((bars[0] as Bar).close).toBeCloseTo(TOTAL_TODAY - BTC_TODAY + 1.6e12, -3);
  });

  it("waits for the exchanges' pair lists, and doesn't keep what it built without them", async () => {
    let lists: readonly CatalogEntry[] = [];
    const made = track(
      await setup({
        pairs: () => lists,
        // The lists are still loading when the first symbol is looked up…
        waitForPairs: async () => {},
      }),
    );
    const day = (await made.cryptocap.fetchBars('TOTAL', D1, null, 1))[0] as Bar;
    // …so Bitcoin counts at CoinGecko's own market cap (1.6T), not today's 84,000.
    expect(day.close).toBeCloseTo(TOTAL_TODAY - BTC_TODAY + 1.6e12, -3);
    lists = PAIRS;
    vi.setSystemTime(NOW + 61_000);
    const again = (await made.cryptocap.fetchBars('TOTAL', D1, null, 1))[0] as Bar;
    expect(again.close).toBeCloseTo(TOTAL_TODAY, -3);
  });

  it('looks a symbol up once the pair lists are in', async () => {
    let lists: readonly CatalogEntry[] = [];
    const made = track(
      await setup({
        pairs: () => lists,
        waitForPairs: async () => {
          lists = PAIRS;
        },
      }),
    );
    const day = (await made.cryptocap.fetchBars('TOTAL', D1, null, 1))[0] as Bar;
    expect(day.close).toBeCloseTo(TOTAL_TODAY, -3);
  });

  it('carries on with the history a restart cut short, without waiting for the next refresh', async () => {
    const first = track(await setup({ history: false }));
    await first.market.resolveSymbol('CRYPTOCAP:TOTAL');
    await first.market.close();
    const second = track(await setup({ dataDir: first.dataDir, history: false }));
    await second.market.resolveSymbol('CRYPTOCAP:TOTAL');
    // The saved coins were fresh: no refresh, but the coins' history goes on loading.
    await vi.waitFor(() =>
      expect(
        second.fake.calls.some((call) => call.url.includes('/coins/ethereum/market_chart')),
      ).toBe(true),
    );
    expect(second.fake.calls.some((call) => call.url.includes('/coins/markets'))).toBe(false);
  });

  it("reaches back as far as Bitcoin's kept points, past CoinGecko's free year", async () => {
    // Days kept from earlier years: every coin's point a day back to 500 days ago, with no
    // history fetched yet, so this run's backfill fetches its (shorter) history on top of them.
    const oldest = TODAY - 500 * DAY_MS;
    const { market, fake } = track(await setup({ dataDir: keptSince(oldest) }));
    expect(fake.calls.some((call) => call.url.includes('/coins/bitcoin/market_chart'))).toBe(true);
    const { bars, hasMore } = await market.getBars('CRYPTOCAP:TOTAL', '1D', null, 1_000);
    // From the day after the oldest kept point to today: 500 days, not 365.
    expect(bars[0]?.time).toBe((oldest + DAY_MS) / 1000);
    expect(bars).toHaveLength(500);
    expect(hasMore).toBe(false);
    // Before the pairs' first bars, each coin counts at its kept market cap.
    const keptTotal =
      1.6e12 + 2.4e11 + 1.8e11 + 7.5e10 + 7e10 + 8.1e9 + 6e9 + 5e9 + 4e9 + 3e9 + 2e9 + 1e9;
    expect((bars[0] as Bar).close).toBeCloseTo(keptTotal, -3);
    expect((bars.at(-1) as Bar).close).toBeCloseTo(TOTAL_TODAY, -3);
  });

  it('starts weeks, months and quarters with the first one its days cover whole', async () => {
    // Our first day is Sunday 8 June 2025 (the day after the oldest kept point).
    const { market } = track(await setup({ dataDir: keptSince(TODAY - 500 * DAY_MS) }));
    const first = async (interval: string) =>
      (await market.getBars('CRYPTOCAP:TOTAL', interval, null, 500)).bars[0]?.time;
    expect(await first('1D')).toBe(Date.UTC(2025, 5, 8) / 1000);
    // The week of 2 June, the month of June and the quarter from April would be part-built.
    expect(await first('1W')).toBe(Date.UTC(2025, 5, 9) / 1000);
    expect(await first('1M')).toBe(Date.UTC(2025, 6, 1) / 1000);
    expect(await first('3M')).toBe(Date.UTC(2025, 6, 1) / 1000);
  });

  it('weekly bars are built from the daily ones', async () => {
    const { market } = track(await setup());
    const { bars } = await market.getBars('CRYPTOCAP:TOTAL', '1W', null, 2);
    expect((bars.at(-1) as Bar).close).toBeCloseTo(TOTAL_TODAY, -3);
  });

  it('fetches each eligible coin its year of history once, and never the excluded one', async () => {
    const { fake } = track(await setup());
    const charts = fake.calls
      .map((call) => /\/coins\/([a-z0-9-]+)\/market_chart/.exec(call.url)?.[1])
      .filter((id): id is string => !!id);
    expect(charts).toContain('bitcoin');
    expect(charts).toContain('leo-token');
    expect(charts).not.toContain('figure-heloc');
    expect(new Set(charts).size).toBe(charts.length);
    expect(fake.calls.every((call) => call.headers['x-cg-demo-api-key'] === KEY)).toBe(true);
  });

  it("moves the live bar with the coins' prices, a tick at a time", async () => {
    const { market, binance } = track(await setup());
    const updates: Bar[] = [];
    const states: string[] = [];
    const listener: BarListener = {
      onBar: (bar) => updates.push(bar),
      onState: (state) => states.push(state),
      onError: (error) => states.push(`error ${error.code}`),
    };
    const stop = market.subscribeBars('CRYPTOCAP:TOTAL', '1D', listener);
    await vi.waitFor(() => expect(binance.followed()).toContain('BTCUSDT'));
    await vi.waitFor(() => expect(states).toContain('live'));
    binance.emitPrice('BTCUSDT', 88_000, NOW);
    const expected = TOTAL_TODAY - BTC_TODAY + 88_000 * supplyOf('bitcoin');
    await vi.waitFor(() => expect((updates.at(-1) as Bar).close).toBeCloseTo(expected, -3));
    const bar = updates.at(-1) as Bar;
    expect(bar.time).toBe(TODAY / 1000);
    // Today's history opened at 1.6T for Bitcoin and its high reached 84,000 (now 88,000).
    expect(bar.open).toBeCloseTo(TOTAL_TODAY - BTC_TODAY + 1.6e12, -3);
    expect(bar.high).toBeCloseTo(expected, -3);
    stop();
  });

  it('gives the value as both Sell and Buy', async () => {
    const { market, binance } = track(await setup());
    const books: { bid: number; ask: number }[] = [];
    const listener: BookListener = {
      onBook: (top) => books.push(top),
      onState: () => {},
      onError: () => {},
    };
    await market.resolveSymbol('CRYPTOCAP:BTC.D');
    const stop = market.subscribeBook('CRYPTOCAP:BTC.D', listener);
    await vi.waitFor(() => expect(binance.followed()).toContain('BTCUSDT'));
    binance.emitPrice('BTCUSDT', 84_000, NOW);
    const dominance = (BTC_TODAY / TOTAL_TODAY) * 100;
    await vi.waitFor(() => expect(books.at(-1)?.bid).toBeCloseTo(dominance, 6));
    const top = books.at(-1) as { bid: number; ask: number };
    expect(top.bid).toBe(top.ask);
    stop();
  });

  it('lists its symbols for search, without the coins TradingView leaves out', async () => {
    const { market, cryptocap } = track(await setup());
    await market.resolveSymbol('CRYPTOCAP:TOTAL');
    const tickers = cryptocap.entries().map((entry) => entry.ticker);
    expect(tickers).toEqual(
      expect.arrayContaining([
        'TOTAL',
        'TOTAL2',
        'OTHERS.D',
        'STABLE.C',
        'OTHERSBTC',
        'XRP',
        'XRP.D',
      ]),
    );
    expect(tickers).not.toContain('TOTAL.D');
    expect(tickers).not.toContain('FIGR_HELOC');
    const total = cryptocap.entries().find((entry) => entry.ticker === 'TOTAL');
    expect(total).toMatchObject({ exchange: 'CRYPTOCAP', kind: 'index', base: 'CRYPTOCAP' });
  });

  it("counts every CoinGecko call against the month's allowance", async () => {
    const { market, usage, fake } = track(await setup());
    await market.resolveSymbol('CRYPTOCAP:TOTAL');
    expect(usage.used()).toBe(fake.calls.length);
    expect(usage.used()).toBeGreaterThan(0);
  });
});
