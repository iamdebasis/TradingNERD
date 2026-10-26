import { readFileSync } from 'node:fs';
import { barOpenTime, parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitstampExchange } from '../src/exchanges/bitstamp/BitstampExchange.ts';
import {
  parseBitstampBook,
  parseBitstampInstruments,
  parseBitstampOhlc,
  parseBitstampTrade,
} from '../src/exchanges/bitstamp/parse.ts';
import { BitstampRest, patientFetch } from '../src/exchanges/bitstamp/rest.ts';
import { bitstampProtocol } from '../src/exchanges/bitstamp/stream.ts';
import { CANDLE_POLL_MS } from '../src/exchanges/shared.ts';
import { pageBack } from '../src/market/history.ts';
import { MarketService } from '../src/market/MarketService.ts';
import { type BookTop, type CandleUpdate, MarketError, type Trade } from '../src/market/types.ts';
import { fixture as catalogFixture, fixtureFetch } from './helpers/FakeCatalog.ts';
import { mockStreamServer } from './helpers/MockStreamServer.ts';

/** Bitstamp spot, against responses and stream messages recorded on 2026-10-25. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/exchanges/${name}.json`, import.meta.url), 'utf8'));
const ws = fixture('bitstamp-ws');
const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
};

const MIN = 60_000;
/** The bar in progress opens here: the tests' clock stands 30 s into it. */
const NOW_BAR = Date.UTC(2026, 9, 25, 12, 0);
/** XRPUSD's first trade on Bitstamp, in this test: 3,000 minutes before NOW_BAR. */
const FIRST = NOW_BAR - 3_000 * MIN;
const priceAt = (t: number) => 1 + (t - FIRST) / MIN / 10_000;

/**
 * Bitstamp's OHLC as measured on 2026-10-25: every period from the bar holding the first trade
 * to the bar in progress (quiet ones flat); `end` gives the `limit` bars up to the one opening at
 * or before it, `start` those from the bar holding it on, the latest without either; at most
 * 1,000 bars a request.
 */
function bitstampOhlc(url: URL) {
  const stepMs = Number(url.searchParams.get('step')) * 1000;
  const limit = Number(url.searchParams.get('limit'));
  if (!(limit >= 1 && limit <= 1_000)) throw new Error(`limit ${limit}`);
  const end = url.searchParams.get('end');
  const start = url.searchParams.get('start');
  const live = Math.floor(Date.now() / stepMs) * stepMs;
  const first = Math.floor(FIRST / stepMs) * stepMs;
  let from: number;
  if (end !== null) {
    from = Math.floor((Number(end) * 1000) / stepMs) * stepMs - (limit - 1) * stepMs;
  } else if (start !== null) {
    from = Math.floor((Number(start) * 1000) / stepMs) * stepMs;
  } else {
    from = live - (limit - 1) * stepMs;
  }
  const ohlc = [];
  for (let t = from, n = 0; n < limit; t += stepMs, n++) {
    if (t < first || t > live) continue;
    const p = String(priceAt(t));
    ohlc.push({ timestamp: String(t / 1000), open: p, high: p, low: p, close: p, volume: '5' });
  }
  return { data: { pair: 'XRP/USD', market: 'XRP/USD', ohlc } };
}

describe('Bitstamp parsing', () => {
  it('reads its spot pairs with their decimals and descriptions', () => {
    const instruments = parseBitstampInstruments(catalogFixture('bitstamp-markets'));
    expect(instruments.find((instrument) => instrument.ticker === 'XRPUSD')).toEqual({
      ticker: 'XRPUSD',
      restId: 'xrpusd',
      streamId: 'xrpusd',
      base: 'XRP',
      quote: 'USD',
      tickSize: 0.00001,
      description: 'XRP / U.S. dollar',
    });
    expect(instruments.find((instrument) => instrument.ticker === 'XRPBTC')?.tickSize).toBe(1e-8);
    expect(instruments.find((instrument) => instrument.ticker === 'BTCUSD')?.tickSize).toBe(0.01);
    // ZK/EUR's trading is disabled; BTC/USD-PERP is a perpetual.
    expect(instruments.map((instrument) => instrument.ticker).sort()).toEqual([
      'BTCUSD',
      'EURUSD',
      'USDTUSD',
      'XRPBTC',
      'XRPEUR',
      'XRPUSD',
    ]);
  });

  it('reads bars, ascending, and refuses anything else', () => {
    const bars = parseBitstampOhlc(fixture('bitstamp-ohlc'));
    expect(bars.map((bar) => [bar.time, bar.close])).toEqual([
      [1792627200, 1.30793],
      [1792713600, 1.2933],
      [1792800000, 1.29786],
    ]);
    expect(() => parseBitstampOhlc({ data: {} })).toThrow(MarketError);
  });

  it('routes trades and order books to their channels, and nothing else', () => {
    const route = (frame: unknown) => bitstampProtocol().route(JSON.stringify(frame), () => {});
    const [trade] = route(ws.trade);
    expect(trade?.topic).toBe('live_trades_btcusd');
    expect(parseBitstampTrade(trade?.data)).toEqual({
      price: 80302.52,
      quantity: 0.0000075,
      time: 1792926238022,
    });
    const [book] = route(ws.order_book);
    expect(book?.topic).toBe('order_book_xrpusd');
    expect(parseBitstampBook(book?.data)).toEqual({ bid: 1.29352, ask: 1.29359 });
    for (const reply of [ws.subscribed, ws.heartbeat, ws.unsubscribed]) {
      expect(route(reply)).toEqual([]);
    }
  });

  it('says when Bitstamp refuses a request or asks for a reconnect', () => {
    const warnings: string[] = [];
    const route = (frame: unknown) =>
      bitstampProtocol().route(JSON.stringify(frame), (message) => warnings.push(message));
    // As Bitstamp's documentation words them; neither has been seen live.
    expect(route({ event: 'bts:request_reconnect', channel: '', data: '' })).toEqual([]);
    expect(
      route({ event: 'bts:error', channel: '', data: { message: 'Bad subscription string.' } }),
    ).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('Bad subscription string.');
  });
});

describe("Bitstamp's front door", () => {
  const ok = () => new Response('{"data":{"ohlc":[]}}', { status: 200 });
  const turnedAway = () => new Response('<html>busy</html>', { status: 503 });

  it('is asked again after turning a request away, and says who is asking', async () => {
    const answers = [turnedAway(), turnedAway(), ok()];
    const sent: RequestInit[] = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      sent.push(init ?? {});
      return answers.shift() ?? ok();
    }) as typeof fetch;
    const response = await patientFetch(base, [0, 0, 0])('https://www.bitstamp.net/api/v2/x/');
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(new Headers(sent[0]?.headers).get('User-Agent')).toMatch(/^tradingNerd/);
    // Past the last wait, the refusal stands, and the caller sees it.
    const refused = await patientFetch((async () => turnedAway()) as typeof fetch, [0, 0])('x');
    expect(refused.status).toBe(503);
    const rest = new BitstampRest({
      baseUrl: 'https://www.bitstamp.net',
      fetch: (async () => turnedAway()) as typeof fetch,
      retryDelaysMs: [0],
      gapMs: 0,
    });
    await expect(rest.markets()).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Bitstamp answered HTTP 503',
    });
  });

  it('gets one request at a time, a breath apart, however many are asked for at once', async () => {
    let inFlight = 0;
    let most = 0;
    const spans: [number, number][] = [];
    const base = (async () => {
      const start = performance.now();
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      spans.push([start, performance.now()]);
      return ok();
    }) as typeof fetch;
    const rest = new BitstampRest({ baseUrl: 'https://x', fetch: base, gapMs: 20 });
    await Promise.all(Array.from({ length: 4 }, () => rest.barsBefore('xrpusd', '60', 2, null)));
    expect(most).toBe(1);
    for (let i = 1; i < spans.length; i++) {
      expect((spans[i]?.[0] ?? 0) - (spans[i - 1]?.[1] ?? 0)).toBeGreaterThanOrEqual(18);
    }
  });
});

describe('BitstampExchange', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_BAR + 30_000);
    const server = await mockStreamServer();
    const { fetch, requested } = fixtureFetch({
      '/api/v2/ohlc/': bitstampOhlc,
      '/api/v2/markets/': catalogFixture('bitstamp-markets'),
    });
    const bitstamp = new BitstampExchange({
      fetch,
      streamUrl: server.url,
      stream: { controlIntervalMs: 10, reconnectDelayMs: () => 10 },
      rest: { retryDelaysMs: [], gapMs: 0 },
    });
    cleanups.push(
      () => server.close(),
      () => bitstamp.close(),
    );
    return { server, bitstamp, requested };
  }

  it("resolves its pairs, as Bitstamp describes them, and nothing it doesn't trade", async () => {
    const { bitstamp } = await setup();
    expect(await bitstamp.resolveSymbol('XRPUSD')).toMatchObject({
      id: 'BITSTAMP:XRPUSD',
      exchange: 'BITSTAMP',
      exchangeName: 'Bitstamp',
      description: 'XRP / U.S. dollar',
      pricePrecision: 5,
      type: 'spot',
      hasBook: true,
    });
    for (const ticker of ['ZKEUR', 'BTCUSDPERP', 'NOPEUSD']) {
      await expect(bitstamp.resolveSymbol(ticker)).rejects.toMatchObject({
        code: 'unknown_symbol',
      });
    }
  });

  it('serves the bars before a time, not the one opening at it, asking a second earlier', async () => {
    const { bitstamp, requested } = await setup();
    await bitstamp.resolveSymbol('XRPUSD');
    const end = NOW_BAR - 100 * MIN;
    const bars = await bitstamp.fetchBars('XRPUSD', r('1'), end, 300);
    expect(bars).toHaveLength(300);
    expect(bars.at(-1)?.time).toBe((end - MIN) / 1000);
    expect(bars.slice(1).every((bar, i) => bar.time - (bars[i]?.time ?? 0) === 60)).toBe(true);
    expect(requested.at(-1)).toContain(`end=${end / 1000 - 1}`);
    // The latest, up to the bar in progress.
    const latest = await bitstamp.fetchBars('XRPUSD', r('1'), null, 2);
    expect(latest.map((bar) => bar.time)).toEqual([(NOW_BAR - MIN) / 1000, NOW_BAR / 1000]);
  });

  it('pages back to the first trade and no further', async () => {
    const { bitstamp } = await setup();
    const all = await pageBack(bitstamp, 'XRPUSD', r('1'), NOW_BAR, 10_000);
    expect(all.hasMore).toBe(false);
    expect(all.bars[0]?.time).toBe(FIRST / 1000);
    expect(all.bars).toHaveLength(3_000);
  });

  it('serves a range from its first boundary, at most 1,000 bars', async () => {
    const { bitstamp } = await setup();
    // A start between boundaries: the bar holding it opened before it, so it isn't in range;
    // nine bars open from 49 to 41 minutes before NOW_BAR.
    const start = NOW_BAR - 50 * MIN + 30_000;
    const range = await bitstamp.fetchRange('XRPUSD', r('1'), start, NOW_BAR - 40 * MIN);
    expect(range.map((bar) => bar.time)).toEqual(
      Array.from({ length: 9 }, (_, i) => (NOW_BAR - 49 * MIN + i * MIN) / 1000),
    );
    const wide = await bitstamp.fetchRange('XRPUSD', r('1'), FIRST, NOW_BAR);
    expect(wide).toHaveLength(1_000);
    expect(wide[0]?.time).toBe(FIRST / 1000);
  });

  it("fetches a chart's windows side by side, with the bars paging one by one gives", async () => {
    const { bitstamp } = await setup();
    const market = new MarketService([bitstamp]);
    const compare = async (toMs: number, count: number) => {
      const { fromListing, ...sideBySide } = await market.getBars(
        'BITSTAMP:XRPUSD',
        '1',
        toMs / 1000,
        count,
      );
      expect(sideBySide).toEqual(await pageBack(bitstamp, 'XRPUSD', r('1'), toMs, count));
      return { ...sideBySide, fromListing };
    };
    expect(await compare(NOW_BAR - 100 * MIN, 1_500)).toMatchObject({ hasMore: true });
    const first = await compare(FIRST + 1_000 * MIN, 1_500);
    expect(first.hasMore).toBe(false);
    expect(first.bars).toHaveLength(1_000);
    expect(first.fromListing).toBe(true); // Bitstamp's bars reach back to each pair's listing
  }, 20_000);

  it('builds 3-day bars from its days, on the same boundaries as every exchange', async () => {
    const { bitstamp } = await setup();
    await expect(bitstamp.fetchBars('XRPUSD', r('3D'), null, 2)).rejects.toMatchObject({
      code: 'unsupported_resolution',
    });
    const market = new MarketService([bitstamp]);
    const { bars } = await market.getBars('BITSTAMP:XRPUSD', '3D', null, 1);
    expect(bars.map((bar) => bar.time)).toEqual([barOpenTime(r('3D'), Date.now()) / 1000]);
  });

  it('polls the live candle every 30 s, the previous bar too', async () => {
    const { bitstamp } = await setup();
    await bitstamp.resolveSymbol('XRPUSD');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW_BAR + 30_000);
    const updates: CandleUpdate[] = [];
    const stop = bitstamp.subscribeCandles('XRPUSD', r('1D'), (update) => updates.push(update));
    await vi.advanceTimersByTimeAsync(CANDLE_POLL_MS - 1);
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(CANDLE_POLL_MS * 2);
    expect(updates).toHaveLength(2);
  });

  it('streams trades and the best bid and ask, a channel a message', async () => {
    const { server, bitstamp } = await setup();
    await bitstamp.resolveSymbol('XRPUSD');
    const trades: Trade[] = [];
    const books: BookTop[] = [];
    const stopTrades = bitstamp.subscribeTrades('XRPUSD', (trade) => trades.push(trade));
    const stopBook = bitstamp.subscribeBook('XRPUSD', (top) => books.push(top));
    await vi.waitFor(() =>
      expect(server.received).toEqual([
        { event: 'bts:subscribe', data: { channel: 'live_trades_xrpusd' } },
        { event: 'bts:subscribe', data: { channel: 'order_book_xrpusd' } },
      ]),
    );
    server.push({ ...ws.trade, channel: 'live_trades_xrpusd' });
    server.push(ws.order_book);
    await vi.waitFor(() => expect(books).toEqual([{ bid: 1.29352, ask: 1.29359 }]));
    expect(trades.map((trade) => trade.price)).toEqual([80302.52]);
    stopTrades();
    stopBook();
    await vi.waitFor(() =>
      expect(server.received.slice(2)).toEqual([
        { event: 'bts:unsubscribe', data: { channel: 'live_trades_xrpusd' } },
        { event: 'bts:unsubscribe', data: { channel: 'order_book_xrpusd' } },
      ]),
    );
  });

  it("keeps a quiet link open with Bitstamp's own heartbeat", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_BAR + 30_000);
    const server = await mockStreamServer((frame, send) => {
      if ((frame as { event?: string }).event === 'bts:heartbeat') send(ws.heartbeat);
    });
    const { fetch } = fixtureFetch({ '/api/v2/markets/': catalogFixture('bitstamp-markets') });
    const bitstamp = new BitstampExchange({
      fetch,
      streamUrl: server.url,
      stream: { pingIntervalMs: 50, pongTimeoutMs: 40, controlIntervalMs: 10 },
      rest: { retryDelaysMs: [], gapMs: 0 },
    });
    cleanups.push(
      () => server.close(),
      () => bitstamp.close(),
    );
    await bitstamp.resolveSymbol('MANAUSD').catch(() => {}); // not in the trimmed list
    await bitstamp.resolveSymbol('XRPUSD');
    const stop = bitstamp.subscribeTrades('XRPUSD', () => {});
    await vi.waitFor(() =>
      expect(
        server.received.filter((frame) => (frame as { event?: string }).event === 'bts:heartbeat')
          .length,
      ).toBeGreaterThanOrEqual(3),
    );
    // Answered each time, the link stayed: one connection all along.
    expect(server.connections).toHaveLength(1);
    expect(bitstamp.isFeedUp()).toBe(true);
    stop();
  });
});
