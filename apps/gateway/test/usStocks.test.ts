import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bar } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BarListener, MarketService } from '../src/market/MarketService.ts';
import type { MarketError } from '../src/market/types.ts';
import { UsListings } from '../src/stocks/UsListings.ts';
import { UsStocksMarket } from '../src/stocks/UsStocksMarket.ts';
import { SecretStore } from '../src/storage/secrets.ts';
import { NASDAQ_LISTED, OTHER_LISTED } from './fixtures/usDirectory.ts';
import { createFakeAlpaca } from './helpers/fakeAlpaca.ts';
import { type MockStreamServer, mockStreamServer } from './helpers/MockStreamServer.ts';

const at = (iso: string) => Date.parse(iso);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(':00.000Z', 'Z');
const KEY = { keyId: 'PKTESTKEYID123456789', secret: 'testsecret0000000000000000000000000000000' };

const streams: MockStreamServer[] = [];

/** Alpaca's stream on the free plan, signing in whoever asks and confirming subscriptions. */
async function alpacaStream() {
  const subscribed = new Set<string>();
  const server = await mockStreamServer(
    (frame, send) => {
      const {
        action,
        trades = [],
        quotes = [],
      } = frame as {
        action?: string;
        trades?: string[];
        quotes?: string[];
      };
      if (action === 'auth') send([{ T: 'success', msg: 'authenticated' }]);
      if (action === 'subscribe') {
        for (const symbol of [...trades, ...quotes]) subscribed.add(symbol);
        send([{ T: 'subscription', trades, quotes }]);
      }
    },
    [{ T: 'success', msg: 'connected' }],
  );
  streams.push(server);
  return { server, subscribed };
}

/** A gateway's US stocks against a fake Alpaca, with the clock at `start`. */
async function setup(start: string, { key = true, cache = false } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at(start));
  const dataDir = mkdtempSync(join(tmpdir(), 'tn-us-stocks-'));
  const alpaca = createFakeAlpaca({ now: () => Date.now() });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('nasdaqtrader.com')) {
      return new Response(url.includes('nasdaqlisted') ? NASDAQ_LISTED : OTHER_LISTED);
    }
    return alpaca.fetch(input, init);
  }) as typeof globalThis.fetch;
  const secrets = new SecretStore(dataDir, {});
  if (key) await secrets.saveAlpaca(KEY.keyId, KEY.secret, 'delayed');
  const listings = new UsListings({ dataDir, fetch });
  const stream = await alpacaStream();
  const stocks = new UsStocksMarket({
    dataDir,
    secrets,
    listings,
    fetch,
    streamUrl: stream.server.url,
    now: () => Date.now(),
    sleep: async () => {},
  });
  const market = new MarketService([...stocks.exchanges()], {
    emitIntervalMs: 0,
    quoteIntervalMs: 0,
    retryDelayMs: () => 5,
    cacheHistory: cache,
  });
  await stocks.ready();
  return { stocks, market, alpaca, listings, stream };
}

function recorder() {
  const bars: Bar[] = [];
  const errors: string[] = [];
  const states: string[] = [];
  const listener: BarListener = {
    onBar: (bar) => bars.push(bar),
    onState: (state) => states.push(state),
    onError: (error: MarketError) => errors.push(error.code),
  };
  return { listener, bars, errors, states };
}

/** Lets pending promises settle (the poller's gather timer is real time). */
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  vi.useRealTimers();
  for (const server of streams.splice(0)) await server.close();
});

/** Waits (in real time) until `check` holds. */
async function until(check: () => boolean, ms = 2_000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('US stock symbols', () => {
  it('resolve with their exchange, kind, New York hours and the data delay', async () => {
    const { market, stocks } = await setup('2026-10-19T15:00:05Z');
    const info = await market.resolveSymbol('NASDAQ:AAPL');
    expect(info).toMatchObject({
      id: 'NASDAQ:AAPL',
      exchange: 'NASDAQ',
      exchangeName: 'NASDAQ',
      ticker: 'AAPL',
      base: 'AAPL',
      quote: 'USD',
      description: 'Apple Inc.',
      type: 'stock',
      tickSize: 0.01,
      pricePrecision: 2,
      timezone: 'America/New_York',
      delayMs: 900_000,
      hasBook: true,
    });
    expect(info.schedule?.holidays).toContain('2026-11-26');
    expect((await market.resolveSymbol('AMEX:SPY')).exchangeName).toBe('NYSE Arca');
    await expect(market.resolveSymbol('NYSE:AAPL')).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
    // Alpaca's list has no preferreds, so JPM/PD has no data.
    await expect(market.resolveSymbol('NYSE:JPM/PD')).rejects.toMatchObject({
      code: 'unknown_symbol',
    });
    stocks.close();
  });

  it('need the Alpaca key', async () => {
    const { market, stocks } = await setup('2026-10-19T15:00:05Z', { key: false });
    await expect(market.resolveSymbol('NASDAQ:AAPL')).rejects.toMatchObject({ code: 'needs_key' });
    expect((await stocks.status()).configured).toBe(false);
    stocks.close();
  });
});

describe('US stock history', () => {
  it('pages minute bars in regular hours only, up to 15 minutes ago', async () => {
    const { market, stocks } = await setup('2026-10-19T15:00:05Z'); // 11:00 New York
    const { bars } = await market.getBars('NASDAQ:AAPL', '1', null, 120);
    expect(bars).toHaveLength(120);
    // The last whole minute 15 minutes back: 10:44 New York.
    expect(iso(bars.at(-1)?.time ?? 0)).toBe('2026-10-19T14:44Z');
    // Monday's first bar is the 09:30 open; before it, Friday's last minute (15:59).
    const open = bars.findIndex((bar) => bar.time === at('2026-10-19T13:30:00Z') / 1000);
    expect(iso(bars[open - 1]?.time ?? 0)).toBe('2026-10-16T19:59Z');
    for (const bar of bars) {
      const minutes =
        new Date(bar.time * 1000).getUTCHours() * 60 + new Date(bar.time * 1000).getUTCMinutes();
      expect(minutes >= 13 * 60 + 30 && minutes < 20 * 60).toBe(true);
    }
    stocks.close();
  });

  it('times day bars at the open, with the official close, the day still trading left out', async () => {
    const live = await setup('2026-10-19T15:00:05Z');
    const days = (await live.market.getBars('NASDAQ:AAPL', '1D', null, 3)).bars;
    expect(days.map((bar) => iso(bar.time))).toEqual([
      '2026-10-14T13:30Z',
      '2026-10-15T13:30Z',
      '2026-10-16T13:30Z',
    ]);
    live.stocks.close();

    const after = await setup('2026-10-19T20:30:00Z'); // 16:30 New York: Monday is history
    const monday = (await after.market.getBars('NASDAQ:AAPL', '1D', null, 1)).bars[0];
    expect(iso(monday?.time ?? 0)).toBe('2026-10-19T13:30Z');
    const lastMinute = after.alpaca.minutes('AAPL', at('2026-10-19T20:00:00Z')).at(-1);
    expect(monday?.close).toBe(Math.round(((lastMinute?.close ?? 0) + 0.5) * 100) / 100);
    after.stocks.close();
  });

  it('builds hours from the session open, as TradingView does', async () => {
    const { market, stocks } = await setup('2026-10-19T15:00:05Z', { cache: true });
    const { bars } = await market.getBars('NASDAQ:AAPL', '60', null, 5);
    // The 10:30 hour is still forming (data reaches 10:45): the live feed brings it.
    expect(bars.map((bar) => iso(bar.time))).toEqual([
      '2026-10-16T16:30Z',
      '2026-10-16T17:30Z',
      '2026-10-16T18:30Z',
      '2026-10-16T19:30Z',
      '2026-10-19T13:30Z',
    ]);
    // Friday's last hour is half an hour: 15:30–16:00 New York.
    const lastFriday = bars[3];
    const minutes = (await market.getBars('NASDAQ:AAPL', '30', null, 20)).bars.filter(
      (bar) => bar.time === lastFriday?.time,
    );
    expect(lastFriday?.volume).toBe(minutes[0]?.volume);
    stocks.close();
  });

  it('leaves a bar still forming to the live feed, which builds it from the minutes there are', async () => {
    // 11:02 New York: the data reaches 10:47, inside the 10:45 five-minute bar. Alpaca would
    // hand that bar back whole, with minutes from after 10:47.
    const { market, stocks } = await setup('2026-10-19T15:02:05Z');
    const { bars } = await market.getBars('NASDAQ:AAPL', '5', null, 3);
    expect(bars.map((bar) => iso(bar.time))).toEqual([
      '2026-10-19T14:30Z',
      '2026-10-19T14:35Z',
      '2026-10-19T14:40Z',
    ]);
    const live = recorder();
    const stop = market.subscribeBars('NASDAQ:AAPL', '5', live.listener);
    await settle();
    await stocks.poller.pollNow();
    // Only 10:45 and 10:46 are 15 minutes old.
    expect(live.bars.at(-1)).toMatchObject({
      time: at('2026-10-19T14:45:00Z') / 1000,
      volume: 200,
    });
    stop();
    stocks.close();
  });
});

describe('US stock extended hours', () => {
  it('give intraday bars from the 04:00 pre-market to the 20:00 post-market close', async () => {
    const { market, stocks } = await setup('2026-10-19T15:02:05Z'); // 11:02 New York
    const extended = (await market.getBars('NASDAQ:AAPL', '30', null, 30, 'extended')).bars;
    const times = extended.map((bar) => iso(bar.time));
    // Monday's pre-market from 04:00 (08:00Z), after Friday's post-market up to 19:30 New York.
    const monday = times.indexOf('2026-10-19T08:00Z');
    expect(times[monday - 1]).toBe('2026-10-16T23:30Z');
    expect(times.at(-1)).toBe('2026-10-19T14:00Z'); // 10:00; the 10:30 bar is still forming
    // Regular hours leave both out.
    const regular = (await market.getBars('NASDAQ:AAPL', '30', null, 30)).bars;
    expect(regular.some((bar) => bar.time === at('2026-10-19T08:00:00Z') / 1000)).toBe(false);
    stocks.close();
  });

  it('leave day bars to the regular sessions, as TradingView does', async () => {
    const { market, stocks } = await setup('2026-10-19T15:02:05Z');
    const regular = await market.getBars('NASDAQ:AAPL', '1D', null, 3);
    const extended = await market.getBars('NASDAQ:AAPL', '1D', null, 3, 'extended');
    expect(extended).toEqual(regular);
    stocks.close();
  });

  it('stream pre-market bars live, while regular-hours bars wait for the open', async () => {
    const { market, stocks } = await setup('2026-10-19T12:30:05Z'); // 08:30 New York
    const extended = recorder();
    const regular = recorder();
    const stopExtended = market.subscribeBars('NASDAQ:AAPL', '5', extended.listener, 'extended');
    const stopRegular = market.subscribeBars('NASDAQ:AAPL', '5', regular.listener);
    await settle();
    await stocks.poller.pollNow();
    // The data reaches 08:15: the 08:10 bar is the latest, whole.
    expect(extended.bars.at(-1)).toMatchObject({
      time: at('2026-10-19T12:10:00Z') / 1000,
      volume: 500,
    });
    // Regular hours still end with Friday's 15:55 bar.
    expect(iso(regular.bars.at(-1)?.time ?? 0)).toBe('2026-10-16T19:55Z');
    stopExtended();
    stopRegular();
    stocks.close();
  });

  it("keep the day's official bar while post-market minutes come in", async () => {
    const { market, stocks, alpaca } = await setup('2026-10-19T20:16:05Z'); // 16:16 New York
    const daily = recorder();
    const minutes = recorder();
    const stopDaily = market.subscribeBars('NASDAQ:AAPL', '1D', daily.listener);
    const stopMinutes = market.subscribeBars('NASDAQ:AAPL', '1', minutes.listener, 'extended');
    await settle();
    await stocks.poller.pollNow();
    const official =
      Math.round(
        ((alpaca.minutes('AAPL', at('2026-10-19T20:00:00Z')).at(-1)?.close ?? 0) + 0.5) * 100,
      ) / 100;
    expect(daily.bars.at(-1)?.close).toBe(official);
    expect(iso(minutes.bars.at(-1)?.time ?? 0)).toBe('2026-10-19T20:00Z'); // 16:00, after hours

    vi.setSystemTime(at('2026-10-19T20:17:05Z'));
    await stocks.poller.pollNow();
    expect(iso(minutes.bars.at(-1)?.time ?? 0)).toBe('2026-10-19T20:01Z');
    expect(daily.bars.at(-1)?.close).toBe(official);
    stopDaily();
    stopMinutes();
    stocks.close();
  });
});

describe("live US stock data from Alpaca's stream", () => {
  it('moves the live bar with each trade between the minute polls', async () => {
    const { market, stocks, stream } = await setup('2026-10-19T15:02:05Z'); // 11:02 New York
    const live = recorder();
    const stop = market.subscribeBars('NASDAQ:AAPL', '5', live.listener);
    await settle();
    await stocks.poller.pollNow();
    await until(() => stream.subscribed.has('AAPL'));
    const polled = live.bars.at(-1);
    expect(polled?.time).toBe(at('2026-10-19T14:45:00Z') / 1000);

    // A trade 15 minutes old, after the last polled minute (10:46): a new high and close.
    const price = (polled?.high ?? 0) + 1;
    stream.server.push([
      { T: 't', S: 'AAPL', p: price, s: 50, c: ['@'], z: 'C', t: '2026-10-19T14:47:30.5Z' },
    ]);
    await until(() => live.bars.at(-1)?.close === price);
    expect(live.bars.at(-1)).toMatchObject({
      time: at('2026-10-19T14:45:00Z') / 1000,
      high: price,
      volume: (polled?.volume ?? 0) + 50,
    });
    // An odd lot doesn't move it, as it doesn't Alpaca's bars.
    stream.server.push([
      { T: 't', S: 'AAPL', p: price + 5, s: 3, c: ['@', 'I'], z: 'C', t: '2026-10-19T14:47:31Z' },
    ]);
    await settle(100);
    expect(live.bars.at(-1)?.close).toBe(price);
    stop();
    stocks.close();
  });

  it("gives the best bid and ask, for the legend's Sell and Buy", async () => {
    const { market, stocks, stream } = await setup('2026-10-19T15:02:05Z');
    const tops: { bid: number; ask: number }[] = [];
    const stop = market.subscribeBook('NASDAQ:AAPL', {
      onBook: (top) => tops.push(top),
      onState: () => {},
      onError: () => {},
    });
    await until(() => stream.subscribed.has('AAPL'));
    stream.server.push([{ T: 'q', S: 'AAPL', bp: 231.4, ap: 231.45, t: '2026-10-19T14:47:30Z' }]);
    await until(() => tops.length > 0);
    expect(tops.at(-1)).toEqual({ bid: 231.4, ask: 231.45 });
    stop();
    stocks.close();
  });
});

describe('live US stock bars', () => {
  it('step forward a minute at a time, 15 minutes behind', async () => {
    const { market, stocks } = await setup('2026-10-19T15:00:05Z');
    const live = recorder();
    const stop = market.subscribeBars('NASDAQ:AAPL', '5', live.listener);
    await settle();
    await stocks.poller.pollNow();
    expect(live.states.at(-1)).toBe('live');
    // The 10:40 bar from its first five minutes, up to 10:44.
    const first = live.bars.at(-1);
    expect(iso(first?.time ?? 0)).toBe('2026-10-19T14:40Z');
    expect(first?.volume).toBe(500);

    vi.setSystemTime(at('2026-10-19T15:01:05Z'));
    await stocks.poller.pollNow();
    expect(iso(live.bars.at(-1)?.time ?? 0)).toBe('2026-10-19T14:45Z');
    expect(live.bars.at(-1)?.volume).toBe(100);
    stop();
    stocks.close();
  });

  it("give watchlist quotes against the last session's official close", async () => {
    const { market, stocks, alpaca } = await setup('2026-10-19T15:00:05Z');
    const quotes: [number, number | null][] = [];
    const stop = market.subscribeQuote('NASDAQ:AAPL', {
      onQuote: (last, prevClose) => quotes.push([last, prevClose]),
      onState: () => {},
      onError: () => {},
    });
    await settle();
    await stocks.poller.pollNow();
    await settle(50);
    const friday = alpaca.minutes('AAPL', at('2026-10-16T20:00:00Z')).at(-1)?.close ?? 0;
    const lastMinute = alpaca.minutes('AAPL', at('2026-10-19T14:45:00Z')).at(-1)?.close ?? 0;
    expect(quotes.at(-1)).toEqual([lastMinute, Math.round((friday + 0.5) * 100) / 100]);
    stop();
    stocks.close();
  });

  it("take each day's official bar once the session is over", async () => {
    const { market, stocks, alpaca } = await setup('2026-10-19T19:50:00Z'); // 15:50 New York
    const daily = recorder();
    const stop = market.subscribeBars('NASDAQ:AAPL', '1D', daily.listener);
    await settle();
    await stocks.poller.pollNow();
    const official =
      Math.round(
        ((alpaca.minutes('AAPL', at('2026-10-19T20:00:00Z')).at(-1)?.close ?? 0) + 0.5) * 100,
      ) / 100;
    expect(daily.bars.at(-1)?.close).not.toBe(official);

    vi.setSystemTime(at('2026-10-19T20:16:05Z')); // the close is 15 minutes old
    await stocks.poller.pollNow();
    expect(daily.bars.at(-1)).toMatchObject({
      time: at('2026-10-19T13:30:00Z') / 1000,
      close: official,
    });
    stop();
    stocks.close();
  });

  it('report the feed down after two failed polls, and back up after one that works', async () => {
    const { market, stocks, alpaca } = await setup('2026-10-19T15:00:05Z');
    const live = recorder();
    const stop = market.subscribeBars('NASDAQ:AAPL', '1', live.listener);
    await settle();
    await stocks.poller.pollNow();
    alpaca.setFailing(true);
    vi.setSystemTime(at('2026-10-19T15:01:05Z'));
    await stocks.poller.pollNow();
    expect(stocks.poller.isUp()).toBe(true);
    await stocks.poller.pollNow();
    expect(stocks.poller.isUp()).toBe(false);
    expect(live.states.at(-1)).toBe('reconnecting');
    alpaca.setFailing(false);
    await stocks.poller.pollNow();
    expect(stocks.poller.isUp()).toBe(true);
    await settle(100);
    expect(live.states.at(-1)).toBe('live');
    stop();
    stocks.close();
  });
});
