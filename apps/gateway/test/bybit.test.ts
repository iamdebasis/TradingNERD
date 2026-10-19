import { readFileSync } from 'node:fs';
import { parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetNames } from '../src/catalog/names.ts';
import { BybitExchange } from '../src/exchanges/bybit/BybitExchange.ts';
import {
  parseBybitBook,
  parseBybitInstruments,
  parseBybitKlines,
  parseBybitKlineUpdates,
  parseBybitTrades,
} from '../src/exchanges/bybit/parse.ts';
import type { BookTop, CandleUpdate, FeedState, Trade } from '../src/market/types.ts';
import { fixtureFetch } from './helpers/FakeCatalog.ts';
import { type MockStreamServer, mockStreamServer } from './helpers/MockStreamServer.ts';

/** Bybit spot, against responses and stream messages recorded on 2026-10-19. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/exchanges/${name}.json`, import.meta.url), 'utf8'));
const ws = fixture('bybit-ws');
const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
};

describe('Bybit parsing', () => {
  it('reads klines, which Bybit lists newest first, into ascending bars', () => {
    const bars = parseBybitKlines(fixture('bybit-kline'));
    expect(bars.map((bar) => bar.time)).toEqual([1792195200, 1792281600, 1792368000]);
    expect(bars.at(-1)).toEqual({
      time: 1792368000,
      open: 1.3071,
      high: 1.3166,
      low: 1.3016,
      close: 1.3153,
      volume: 3334821.05,
    });
  });

  it('reads instruments with their tick sizes', () => {
    expect(parseBybitInstruments(fixture('bybit-instrument'))).toEqual([
      {
        ticker: 'XRPUSDT',
        restId: 'XRPUSDT',
        streamId: 'XRPUSDT',
        base: 'XRP',
        quote: 'USDT',
        tickSize: 0.0001,
      },
    ]);
  });

  it('reads stream candles, trades and the best bid and ask', () => {
    expect(parseBybitKlineUpdates(ws.kline)).toEqual([
      {
        bar: {
          time: 1792394580,
          open: 1.3168,
          high: 1.3168,
          low: 1.3168,
          close: 1.3168,
          volume: 0,
        },
        eventTime: 1792394580292,
      },
    ]);
    expect(parseBybitTrades(ws.trade)).toEqual([
      { price: 1.3167, quantity: 380.07, time: 1792394582120 },
      { price: 1.3167, quantity: 0.24, time: 1792394582120 },
    ]);
    expect(parseBybitBook(ws.book)).toEqual({ snapshot: true, bid: 1.3167, ask: 1.3168 });
    expect(parseBybitKlineUpdates({ data: [{ start: 'x' }] })).toBeNull();
  });
});

describe('BybitExchange', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    const server: MockStreamServer = await mockStreamServer();
    const { fetch, requested } = fixtureFetch({
      'instruments-info': fixture('bybit-instrument'),
      '/v5/market/kline': fixture('bybit-kline'),
    });
    const names = new AssetNames();
    names.update(new Map([['USDT', 'TetherUS']]));
    const bybit = new BybitExchange({
      fetch,
      names,
      streamUrl: server.url,
      stream: { controlIntervalMs: 10, reconnectDelayMs: () => 10, pingIntervalMs: 40 },
    });
    cleanups.push(
      () => server.close(),
      () => bybit.close(),
    );
    return { server, bybit, requested };
  }

  it('resolves a symbol with the shared names, and refuses one Bybit does not list', async () => {
    const { bybit } = await setup();
    expect(await bybit.resolveSymbol('XRPUSDT')).toMatchObject({
      id: 'BYBIT:XRPUSDT',
      exchangeName: 'Bybit',
      description: 'XRP / TetherUS',
      tickSize: 0.0001,
      pricePrecision: 4,
    });
    await expect(bybit.resolveSymbol('NOPEUSDT')).rejects.toMatchObject({ code: 'unknown_symbol' });
  });

  it('asks for bars before an end time, or within a range', async () => {
    const { bybit, requested } = await setup();
    const bars = await bybit.fetchBars('XRPUSDT', r('1D'), 1792368000000, 300);
    expect(bars).toHaveLength(3);
    const before = new URL(requested.at(-1) ?? '').searchParams;
    expect(Object.fromEntries(before)).toEqual({
      category: 'spot',
      symbol: 'XRPUSDT',
      interval: 'D',
      limit: '300',
      end: '1792367999999',
    });
    await bybit.fetchRange('XRPUSDT', r('60'), 1_000, 2_000);
    const range = new URL(requested.at(-1) ?? '').searchParams;
    expect([range.get('interval'), range.get('start'), range.get('end')]).toEqual([
      '60',
      '1000',
      '1999',
    ]);
    await expect(bybit.fetchBars('XRPUSDT', r('1S'), null, 10)).rejects.toMatchObject({
      code: 'unsupported_resolution',
    });
  });

  it('streams candles, trades and the book over one connection, pinging to stay alive', async () => {
    const { server, bybit } = await setup();
    const candles: CandleUpdate[] = [];
    const trades: Trade[] = [];
    const books: BookTop[] = [];
    const states: FeedState[] = [];
    bybit.onFeedState((state) => states.push(state));
    bybit.subscribeCandles('XRPUSDT', r('1'), (update) => candles.push(update));
    bybit.subscribeTrades('XRPUSDT', (trade) => trades.push(trade));
    bybit.subscribeBook('XRPUSDT', (top) => books.push(top));
    await vi.waitFor(() =>
      expect(
        server.received.flatMap((frame) => (frame as { args?: string[] }).args ?? []).sort(),
      ).toEqual(['kline.1.XRPUSDT', 'orderbook.1.XRPUSDT', 'publicTrade.XRPUSDT']),
    );
    expect(states).toEqual(['up']);

    server.push(ws.kline);
    server.push(ws.trade);
    server.push(ws.book);
    // A delta changing only the ask.
    server.push({
      ...ws.book,
      type: 'delta',
      data: { ...ws.book.data, b: [], a: [['1.3158', '9']] },
    });
    await vi.waitFor(() => expect(books).toHaveLength(2));
    expect(candles.map((c) => c.bar.close)).toEqual([1.3168]);
    expect(trades.map((t) => t.quantity)).toEqual([380.07, 0.24]);
    expect(books).toEqual([
      { bid: 1.3167, ask: 1.3168 },
      { bid: 1.3167, ask: 1.3158 },
    ]);
    await vi.waitFor(() => expect(server.received).toContainEqual({ op: 'ping' }));
  });

  it('reconnects after a drop and subscribes again', async () => {
    const { server, bybit } = await setup();
    const states: FeedState[] = [];
    bybit.onFeedState((state) => states.push(state));
    bybit.subscribeTrades('XRPUSDT', () => {});
    await vi.waitFor(() => expect(bybit.isFeedUp()).toBe(true));
    server.dropAll();
    await vi.waitFor(() => expect(states).toEqual(['up', 'down', 'up']));
    await vi.waitFor(() =>
      expect(
        server.received.filter((frame) => (frame as { op?: string }).op === 'subscribe'),
      ).toHaveLength(2),
    );
  });
});
