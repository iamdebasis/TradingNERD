import { readFileSync } from 'node:fs';
import { parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetNames } from '../src/catalog/names.ts';
import { OkxExchange } from '../src/exchanges/okx/OkxExchange.ts';
import {
  parseOkxBbo,
  parseOkxCandles,
  parseOkxCandleUpdates,
  parseOkxInstruments,
  parseOkxTrades,
} from '../src/exchanges/okx/parse.ts';
import { okxProtocol } from '../src/exchanges/okx/stream.ts';
import { pageBack } from '../src/market/history.ts';
import type { BookTop, CandleUpdate, FeedState, Trade } from '../src/market/types.ts';
import { fixture as catalogFixture, fixtureFetch } from './helpers/FakeCatalog.ts';
import { mockStreamServer } from './helpers/MockStreamServer.ts';

/** OKX spot, against responses and stream messages recorded on 2026-10-19. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/exchanges/${name}.json`, import.meta.url), 'utf8'));
const ws = fixture('okx-ws');
const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
};

const DAY_MS = 86_400_000;
const TODAY_MS = Date.UTC(2026, 9, 19);
/** 2,000 daily bars up to today, newest first, as OKX lists them. */
const HISTORY = Array.from({ length: 2_000 }, (_, i) => {
  const ts = TODAY_MS - i * DAY_MS;
  const price = String(1 + (i % 50) / 100);
  return [String(ts), price, price, price, price, '10', '10', '10', '1'];
});

/** OKX's two candle endpoints: the recent one reaches back 1,440 bars, 300 a page; history 100. */
function okxCandles(url: URL, window: number, max: number) {
  const after = Number(url.searchParams.get('after') ?? Number.POSITIVE_INFINITY);
  const before = Number(url.searchParams.get('before') ?? Number.NEGATIVE_INFINITY);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? max), max);
  const rows = HISTORY.slice(0, window)
    .filter((row) => Number(row[0]) < after && Number(row[0]) > before)
    .slice(0, limit);
  return { code: '0', msg: '', data: rows };
}

describe('OKX parsing', () => {
  it('reads candles, which OKX lists newest first, into ascending bars', () => {
    const bars = parseOkxCandles(fixture('okx-candles'));
    expect(bars.map((bar) => bar.time)).toEqual([1792195200, 1792281600, 1792368000]);
    expect(bars.at(-1)).toMatchObject({ open: 1.3074, high: 1.3169, low: 1.3017, close: 1.3155 });
  });

  it("reads instruments: TradingView's XRPUSDT is OKX's XRP-USDT", () => {
    const instruments = parseOkxInstruments(catalogFixture('okx-instruments'));
    expect(instruments.find((instrument) => instrument.ticker === 'XRPUSDT')).toEqual({
      ticker: 'XRPUSDT',
      restId: 'XRP-USDT',
      streamId: 'XRP-USDT',
      base: 'XRP',
      quote: 'USDT',
      tickSize: 0.0001,
    });
    expect(instruments.map((instrument) => instrument.ticker)).not.toContain('OLDUSDT');
  });

  it('reads stream candles, trades and the best bid and ask', () => {
    expect(parseOkxCandleUpdates(ws.candle, 42)).toEqual([
      {
        bar: {
          time: 1792394580,
          open: 1.3169,
          high: 1.3169,
          low: 1.3169,
          close: 1.3169,
          volume: 1.5,
        },
        eventTime: 42,
      },
    ]);
    expect(parseOkxTrades(ws.trades)).toEqual([
      { price: 1.3169, quantity: 1997.325284, time: 1792394584237 },
    ]);
    expect(parseOkxBbo(ws.bbo)).toEqual({ bid: 1.3168, ask: 1.3169 });
  });

  it('routes pushes by channel and instrument, and keeps replies and pongs out', () => {
    const warnings: string[] = [];
    const protocol = okxProtocol();
    const route = (frame: unknown) =>
      protocol.route(typeof frame === 'string' ? frame : JSON.stringify(frame), (w) =>
        warnings.push(w),
      );
    expect(route(ws.trades).map((update) => update.topic)).toEqual(['trades:XRP-USDT']);
    expect(route(ws.subscribed)).toEqual([]);
    expect(route('pong')).toEqual([]);
    expect(route({ event: 'error', msg: 'Wrong URL or channel', code: '60018' })).toEqual([]);
    expect(warnings).toEqual(['OKX rejected a request: Wrong URL or channel']);
  });
});

describe('OkxExchange', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    const publicServer = await mockStreamServer((frame, send) => {
      if (frame === 'ping') send('pong');
    });
    const businessServer = await mockStreamServer((frame, send) => {
      if (frame === 'ping') send('pong');
    });
    const { fetch, requested } = fixtureFetch({
      '/public/instruments': catalogFixture('okx-instruments'),
      '/market/history-candles': (url: URL) => okxCandles(url, HISTORY.length, 100),
      '/market/candles': (url: URL) => okxCandles(url, 1_440, 300),
    });
    const names = new AssetNames();
    names.update(new Map([['USDT', 'TetherUS']]));
    const okx = new OkxExchange({
      fetch,
      names,
      streamUrl: publicServer.url,
      businessStreamUrl: businessServer.url,
      stream: {
        controlIntervalMs: 10,
        reconnectDelayMs: () => 10,
        pingIntervalMs: 40,
        idleCloseMs: 40,
      },
    });
    cleanups.push(
      () => publicServer.close(),
      () => businessServer.close(),
      () => okx.close(),
    );
    await okx.resolveSymbol('XRPUSDT');
    return { publicServer, businessServer, okx, requested };
  }

  it('pages back through all of history, the recent endpoint first and then the history one', async () => {
    const { okx, requested } = await setup();
    const latest = await okx.fetchBars('XRPUSDT', r('1D'), null, 300);
    expect(latest).toHaveLength(300);
    expect(latest.at(-1)?.time).toBe(TODAY_MS / 1000);
    expect(requested.filter((url) => url.includes('history-candles'))).toEqual([]);

    const all = await pageBack(okx, 'XRPUSDT', r('1D'), null, 5_000);
    expect(all.hasMore).toBe(false);
    expect(all.bars).toHaveLength(2_000);
    const gaps = all.bars
      .slice(1)
      .filter((bar, i) => bar.time - (all.bars[i]?.time ?? 0) !== 86_400);
    expect(gaps).toEqual([]);
    expect(requested.some((url) => url.includes('/market/history-candles'))).toBe(true);
  });

  it('fetches a range past the recent window from the history endpoint', async () => {
    const { okx } = await setup();
    const end = TODAY_MS - 1_500 * DAY_MS;
    const bars = await okx.fetchRange('XRPUSDT', r('1D'), end - 250 * DAY_MS, end);
    expect(bars).toHaveLength(250);
    expect(bars[0]?.time).toBe((end - 250 * DAY_MS) / 1000);
    expect(bars.at(-1)?.time).toBe((end - DAY_MS) / 1000);
  });

  it('streams candles on the business connection, trades and quotes on the public one', async () => {
    const { publicServer, businessServer, okx } = await setup();
    const candles: CandleUpdate[] = [];
    const trades: Trade[] = [];
    const books: BookTop[] = [];
    okx.subscribeCandles('XRPUSDT', r('1D'), (update) => candles.push(update));
    okx.subscribeTrades('XRPUSDT', (trade) => trades.push(trade));
    okx.subscribeBook('XRPUSDT', (top) => books.push(top));
    await vi.waitFor(() => {
      expect(businessServer.received).toContainEqual({
        op: 'subscribe',
        args: [{ channel: 'candle1Dutc', instId: 'XRP-USDT' }],
      });
      expect(
        publicServer.received.flatMap((frame) => (frame as { args?: unknown[] }).args ?? []),
      ).toEqual([
        { channel: 'trades', instId: 'XRP-USDT' },
        { channel: 'bbo-tbt', instId: 'XRP-USDT' },
      ]);
    });
    businessServer.push({ ...ws.candle, arg: { channel: 'candle1Dutc', instId: 'XRP-USDT' } });
    publicServer.push(ws.trades);
    publicServer.push(ws.bbo);
    await vi.waitFor(() => expect(books).toHaveLength(1));
    expect(candles.map((c) => c.bar.close)).toEqual([1.3169]);
    expect(trades.map((t) => t.price)).toEqual([1.3169]);
    // It pings with the text "ping", and OKX's "pong" is no stray message.
    await vi.waitFor(() => expect(publicServer.received).toContain('ping'));
  });

  it('is down while a connection in use is down, but an idle one closing is no outage', async () => {
    const { businessServer, okx } = await setup();
    const states: FeedState[] = [];
    okx.onFeedState((state) => states.push(state));
    const candles = okx.subscribeCandles('XRPUSDT', r('1'), () => {});
    okx.subscribeTrades('XRPUSDT', () => {});
    await vi.waitFor(() => expect(okx.isFeedUp()).toBe(true));
    await vi.waitFor(() => expect(businessServer.connections).toHaveLength(1));

    businessServer.dropAll();
    await vi.waitFor(() => expect(states).toContain('down'));
    await vi.waitFor(() => expect(states.at(-1)).toBe('up'));

    const before = states.length;
    candles(); // the business connection now goes idle and closes
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(states.slice(before)).toEqual([]);
    expect(okx.isFeedUp()).toBe(true);
  });
});
