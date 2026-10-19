import { readFileSync } from 'node:fs';
import { parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetNames } from '../src/catalog/names.ts';
import { KrakenExchange } from '../src/exchanges/kraken/KrakenExchange.ts';
import {
  parseKrakenInstruments,
  parseKrakenOhlc,
  parseKrakenOhlcUpdate,
  parseKrakenTicker,
  parseKrakenTrade,
} from '../src/exchanges/kraken/parse.ts';
import { krakenProtocol } from '../src/exchanges/kraken/stream.ts';
import { pageBack } from '../src/market/history.ts';
import { MarketService } from '../src/market/MarketService.ts';
import type { BookTop, CandleUpdate, Trade } from '../src/market/types.ts';
import { fixture as catalogFixture, fixtureFetch } from './helpers/FakeCatalog.ts';
import { mockStreamServer } from './helpers/MockStreamServer.ts';

/** Kraken spot, against responses and stream messages recorded on 2026-10-19. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/exchanges/${name}.json`, import.meta.url), 'utf8'));
const ws = fixture('kraken-ws');
const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
};

const DAY = 86_400;
const TODAY = Date.UTC(2026, 9, 19) / 1000;
/** Kraken's OHLC: the live bar and the 720 before it, oldest first, whatever `since` asks. */
function krakenOhlc(url: URL) {
  const pair = url.searchParams.get('pair') ?? '';
  const since = Number(url.searchParams.get('since') ?? 0);
  const rows = Array.from({ length: 721 }, (_, i) => {
    const time = TODAY - (720 - i) * DAY;
    const p = String(1 + i / 1_000);
    return [time, p, p, p, p, p, '12.5', 3];
  }).filter((row) => Number(row[0]) > since);
  return { error: [], result: { [pair]: rows, last: TODAY - DAY } };
}

describe('Kraken parsing', () => {
  it('reads OHLC rows, oldest first, with volume from its seventh column', () => {
    const bars = parseKrakenOhlc(fixture('kraken-ohlc'), 'XXRPZUSD');
    expect(bars.map((bar) => bar.time)).toEqual([1792195200, 1792281600, 1792368000]);
    expect(bars.at(-1)).toEqual({
      time: 1792368000,
      open: 1.30554,
      high: 1.31515,
      low: 1.30023,
      close: 1.31396,
      volume: 3260912.49656411,
    });
  });

  it('knows each pair by its three names; XBT and XDG are BTC and DOGE on the stream', () => {
    const instruments = parseKrakenInstruments(catalogFixture('kraken-assetpairs'));
    const byTicker = new Map(instruments.map((instrument) => [instrument.ticker, instrument]));
    expect(byTicker.get('XBTUSD')).toEqual({
      ticker: 'XBTUSD',
      restId: 'XXBTZUSD',
      streamId: 'BTC/USD',
      base: 'BTC',
      quote: 'USD',
      tickSize: 0.1,
    });
    expect(byTicker.get('XDGUSD')?.streamId).toBe('DOGE/USD');
    expect(byTicker.has('ACAEUR')).toBe(false); // cancel-only
  });

  it('reads stream candles (as of the message time), trades and the best bid and ask', () => {
    const [ohlc] = krakenProtocol().route(JSON.stringify(ws.ohlc), () => {});
    if (!ohlc) throw new Error('the candle message was not routed');
    expect(ohlc.topic).toBe(`ohlc:1:${ws.ohlc.data[0].symbol}`);
    const { item, timestamp } = ohlc.data as { item: unknown; timestamp: unknown };
    const update = parseKrakenOhlcUpdate(item, timestamp);
    expect(update?.eventTime).toBe(Date.parse(String(ws.ohlc.timestamp)));
    expect(update?.bar.time).toBe(Date.parse(String(ws.ohlc.data[0].interval_begin)) / 1000);
    const trade = ws.trade.data[0];
    expect(parseKrakenTrade(trade)).toEqual({
      price: trade.price,
      quantity: trade.qty,
      time: Date.parse(trade.timestamp),
    });
    const ticker = ws.ticker.data[0];
    expect(parseKrakenTicker(ticker)).toEqual({ bid: ticker.bid, ask: ticker.ask });
  });

  it('subscribes per channel and interval, without snapshots, the ticker on bid and ask', () => {
    const frames = krakenProtocol()
      .subscribe(['ohlc:1440:XRP/USD', 'ohlc:1440:BTC/USD', 'trade:XRP/USD', 'ticker:XRP/USD'], 7)
      .map((frame) => JSON.parse(frame));
    expect(frames).toEqual([
      {
        method: 'subscribe',
        params: {
          channel: 'ohlc',
          interval: 1440,
          symbol: ['XRP/USD', 'BTC/USD'],
          snapshot: false,
        },
        req_id: 7,
      },
      {
        method: 'subscribe',
        params: { channel: 'trade', symbol: ['XRP/USD'], snapshot: false },
        req_id: 7,
      },
      {
        method: 'subscribe',
        params: { channel: 'ticker', symbol: ['XRP/USD'], event_trigger: 'bbo' },
        req_id: 7,
      },
    ]);
    const warnings: string[] = [];
    const route = (frame: unknown) =>
      krakenProtocol().route(JSON.stringify(frame), (w) => warnings.push(w));
    expect(route(ws.subscribed)).toEqual([]);
    expect(route(ws.heartbeat)).toEqual([]);
    expect(
      route({ method: 'subscribe', success: false, error: 'Currency pair not supported' }),
    ).toEqual([]);
    expect(warnings).toEqual(['Kraken rejected a request: Currency pair not supported']);
  });
});

describe('KrakenExchange', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((TODAY + DAY / 2) * 1000);
    const server = await mockStreamServer();
    const { fetch, requested } = fixtureFetch({
      '/0/public/AssetPairs': catalogFixture('kraken-assetpairs'),
      '/0/public/OHLC': krakenOhlc,
    });
    const names = new AssetNames();
    names.update(
      new Map([
        ['BTC', 'Bitcoin'],
        ['USD', 'US Dollar'],
      ]),
    );
    const kraken = new KrakenExchange({
      fetch,
      names,
      streamUrl: server.url,
      stream: { controlIntervalMs: 10, reconnectDelayMs: () => 10 },
    });
    cleanups.push(
      () => server.close(),
      () => kraken.close(),
    );
    expect(await kraken.resolveSymbol('XBTUSD')).toMatchObject({
      id: 'KRAKEN:XBTUSD',
      base: 'BTC',
      description: 'Bitcoin / US Dollar',
      pricePrecision: 1,
    });
    return { server, kraken, requested };
  }

  it('serves its latest 720 bars and the live one, and history ends there', async () => {
    const { kraken } = await setup();
    const latest = await kraken.fetchBars('XBTUSD', r('1D'), null, 300);
    expect(latest).toHaveLength(300);
    expect(latest.at(-1)?.time).toBe(TODAY);
    const older = await kraken.fetchBars('XBTUSD', r('1D'), TODAY * 1000, 300);
    expect(older.at(-1)?.time).toBe(TODAY - DAY);
    const all = await pageBack(kraken, 'XBTUSD', r('1D'), null, 5_000);
    expect(all).toMatchObject({ hasMore: false });
    expect(all.bars).toHaveLength(721);
  });

  it('never asks for bars older than the ones it keeps', async () => {
    const { kraken, requested } = await setup();
    const asked = requested.length;
    const before = (TODAY - 721 * DAY) * 1000;
    expect(await kraken.fetchRange('XBTUSD', r('1D'), before - 300 * DAY * 1000, before)).toEqual(
      [],
    );
    expect(await kraken.fetchBars('XBTUSD', r('1D'), before, 300)).toEqual([]);
    expect(requested.length).toBe(asked);
    // A weekly chart takes three requests, not one for each of its ten 720-day slices.
    const weeks = await new MarketService([kraken]).getBars('KRAKEN:XBTUSD', '1W', null, 1_000);
    // 721 days, Tuesday 2024-10-29 to Monday 2026-10-19: 104 weeks, the first from Tuesday on.
    expect(weeks.bars).toHaveLength(104);
    expect(weeks.hasMore).toBe(false);
    expect(requested.length - asked).toBe(3);
  });

  it('asks for a range by its start, and builds weeks from days rather than its Thursday weeks', async () => {
    const { kraken, requested } = await setup();
    const range = await kraken.fetchRange(
      'XBTUSD',
      r('1D'),
      (TODAY - 10 * DAY) * 1000,
      TODAY * 1000,
    );
    expect(range).toHaveLength(10);
    expect(new URL(requested.at(-1) ?? '').searchParams.get('since')).toBe(
      String(TODAY - 10 * DAY - 1),
    );
    await expect(kraken.fetchBars('XBTUSD', r('1W'), null, 10)).rejects.toMatchObject({
      code: 'unsupported_resolution',
    });
  });

  it('streams under the v2 names: BTC/USD for XBTUSD', async () => {
    const { server, kraken } = await setup();
    const candles: CandleUpdate[] = [];
    const trades: Trade[] = [];
    const books: BookTop[] = [];
    kraken.subscribeCandles('XBTUSD', r('1'), (update) => candles.push(update));
    kraken.subscribeTrades('XBTUSD', (trade) => trades.push(trade));
    kraken.subscribeBook('XBTUSD', (top) => books.push(top));
    await vi.waitFor(() =>
      expect(
        server.received.map(
          (frame) => (frame as { params: { channel: string; symbol: string[] } }).params,
        ),
      ).toEqual([
        { channel: 'ohlc', interval: 1, symbol: ['BTC/USD'], snapshot: false },
        { channel: 'trade', symbol: ['BTC/USD'], snapshot: false },
        { channel: 'ticker', symbol: ['BTC/USD'], event_trigger: 'bbo' },
      ]),
    );
    const btc = (frame: { data: { symbol: string }[] }) => ({
      ...frame,
      data: frame.data.map((item) => ({ ...item, symbol: 'BTC/USD' })),
    });
    server.push(btc(ws.ohlc));
    server.push(btc(ws.trade));
    server.push(btc(ws.ticker));
    await vi.waitFor(() => expect(books).toHaveLength(1));
    expect(candles).toHaveLength(1);
    expect(trades).toHaveLength(ws.trade.data.length);
  });
});
