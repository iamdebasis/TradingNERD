import { readFileSync } from 'node:fs';
import { type Bar, parseResolution, type Resolution } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetNames } from '../src/catalog/names.ts';
import { CoinbaseExchange, fillQuietPeriods } from '../src/exchanges/coinbase/CoinbaseExchange.ts';
import {
  parseCoinbaseCandles,
  parseCoinbaseInstruments,
  parseCoinbaseTicker,
  parseCoinbaseTrades,
} from '../src/exchanges/coinbase/parse.ts';
import { coinbaseProtocol } from '../src/exchanges/coinbase/stream.ts';
import { CANDLE_POLL_MS } from '../src/exchanges/shared.ts';
import { pageBack } from '../src/market/history.ts';
import { MarketService } from '../src/market/MarketService.ts';
import type { BookTop, CandleUpdate, Trade } from '../src/market/types.ts';
import { fixture as catalogFixture, fixtureFetch } from './helpers/FakeCatalog.ts';
import { mockStreamServer } from './helpers/MockStreamServer.ts';

/** Coinbase spot, against responses and stream messages recorded on 2026-10-19. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/exchanges/${name}.json`, import.meta.url), 'utf8'));
const ws = fixture('coinbase-ws');
const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
};

const MIN = 60_000;
const END = Date.UTC(2026, 9, 19, 12, 0);
/** A pair listed 3,000 minutes before END that trades in two minutes of three, then is quiet
 * for 500 minutes (longer than a 350-minute window) before trading again. */
const FIRST = END - 3_000 * MIN;
const QUIET = { from: END - 1_200 * MIN, to: END - 700 * MIN };
const tradedAt = (t: number) =>
  t >= FIRST && t < END && ((t - FIRST) / MIN) % 3 !== 1 && !(t >= QUIET.from && t < QUIET.to);
const priceAt = (t: number) => 1 + (t - FIRST) / MIN / 10_000;

function coinbaseCandles(url: URL) {
  const start = Number(url.searchParams.get('start')) * 1000;
  const end = Number(url.searchParams.get('end')) * 1000;
  const candles = [];
  for (let t = end - (end % MIN); t >= start; t -= MIN) {
    if (!tradedAt(t)) continue;
    const p = String(priceAt(t));
    candles.push({ start: String(t / 1000), low: p, high: p, open: p, close: p, volume: '5' });
  }
  return { candles };
}

describe('Coinbase parsing', () => {
  it('reads candles, newest first, into ascending bars', () => {
    expect(parseCoinbaseCandles(fixture('coinbase-candles')).map((bar) => bar.time)).toEqual([
      1792195200, 1792281600, 1792368000,
    ]);
  });

  it('reads each book once, with its price increment', () => {
    const instruments = parseCoinbaseInstruments(catalogFixture('coinbase-products'));
    expect(instruments.find((instrument) => instrument.ticker === 'XRPUSD')).toEqual({
      ticker: 'XRPUSD',
      restId: 'XRP-USD',
      streamId: 'XRP-USD',
      base: 'XRP',
      quote: 'USD',
      tickSize: 0.0001,
    });
    // XRP-USDC is XRP-USD's own book; DAI-USD is delisted.
    expect(instruments.map((instrument) => instrument.ticker).sort()).toEqual([
      'BTCUSD',
      'USDTUSD',
      'XRPEUR',
      'XRPUSD',
    ]);
  });

  it('takes live trades, not the snapshot of earlier ones the REST history already has', () => {
    const [update] = coinbaseProtocol().route(JSON.stringify(ws.trades_update), () => {});
    expect(parseCoinbaseTrades(update?.data)).toEqual([
      { price: 1.3153, quantity: 51.570606, time: Date.parse('2026-10-19T07:23:06.777216Z') },
    ]);
    const [snapshot] = coinbaseProtocol().route(JSON.stringify(ws.trades_snapshot), () => {});
    expect(parseCoinbaseTrades(snapshot?.data)).toEqual([]);
    const [ticker] = coinbaseProtocol().route(JSON.stringify(ws.ticker), () => {});
    expect(ticker?.topic).toBe('ticker:XRP-USD');
    expect(parseCoinbaseTicker(ticker?.data)).toEqual({ bid: 1.3153, ask: 1.3154 });
  });

  it("splits a frame's trades per product, and keeps heartbeats out", () => {
    const frame = {
      channel: 'market_trades',
      events: [
        {
          type: 'update',
          trades: [
            { product_id: 'XRP-USD', price: '1', size: '1', time: '2026-10-19T07:00:00Z' },
            { product_id: 'BTC-USD', price: '2', size: '1', time: '2026-10-19T07:00:00Z' },
          ],
        },
      ],
    };
    const updates = coinbaseProtocol().route(JSON.stringify(frame), () => {});
    expect(updates.map((update) => update.topic)).toEqual([
      'market_trades:XRP-USD',
      'market_trades:BTC-USD',
    ]);
    expect(coinbaseProtocol().route(JSON.stringify(ws.heartbeat), () => {})).toEqual([]);
  });
});

describe('quiet periods', () => {
  const bar = (minute: number, close: number): Bar => ({
    time: minute * 60,
    open: close,
    high: close,
    low: close,
    close,
    volume: 3,
  });

  it('are filled in as flat bars at the last price, as the other exchanges send them', () => {
    const filled = fillQuietPeriods([bar(1, 5), bar(4, 7)], 0, 6 * MIN, MIN, 4);
    expect(filled.map((b) => [b.time / 60, b.close, b.volume])).toEqual([
      [0, 4, 0],
      [1, 5, 3],
      [2, 5, 0],
      [3, 5, 0],
      [4, 7, 3],
      [5, 7, 0],
    ]);
  });

  it('are not invented before the first trade', () => {
    const filled = fillQuietPeriods([bar(2, 5)], 0, 4 * MIN, MIN, null);
    expect(filled.map((b) => b.time / 60)).toEqual([2, 3]);
  });
});

describe('CoinbaseExchange', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup() {
    const server = await mockStreamServer();
    const { fetch, requested } = fixtureFetch({
      '/candles': coinbaseCandles,
      '/market/products': catalogFixture('coinbase-products'),
    });
    const names = new AssetNames();
    names.update(new Map([['USD', 'US Dollar']]));
    const coinbase = new CoinbaseExchange({
      fetch,
      names,
      streamUrl: server.url,
      stream: { controlIntervalMs: 10, reconnectDelayMs: () => 10 },
    });
    cleanups.push(
      () => server.close(),
      () => coinbase.close(),
    );
    expect(await coinbase.resolveSymbol('XRPUSD')).toMatchObject({
      id: 'COINBASE:XRPUSD',
      description: 'XRP / US Dollar',
      pricePrecision: 4,
    });
    return { server, coinbase, requested };
  }

  it('serves every minute of a page, quiet ones filled in', async () => {
    const { coinbase } = await setup();
    const bars = await coinbase.fetchBars('XRPUSD', r('1'), END, 300);
    expect(bars).toHaveLength(300);
    expect(bars[0]?.time).toBe((END - 300 * MIN) / 1000);
    expect(bars.slice(1).every((b, i) => b.time - (bars[i]?.time ?? 0) === 60)).toBe(true);
    // In the long quiet stretch, a page starts from the last price before it.
    const quiet = await coinbase.fetchBars('XRPUSD', r('1'), QUIET.to, 300);
    expect(quiet).toHaveLength(300);
    expect(new Set(quiet.map((b) => b.close))).toEqual(new Set([priceAt(QUIET.from - MIN)]));
  });

  it('pages back to the first trade and no further, through quiet stretches', async () => {
    const { coinbase } = await setup();
    const all = await pageBack(coinbase, 'XRPUSD', r('1'), END, 10_000);
    expect(all.hasMore).toBe(false);
    expect(all.bars[0]?.time).toBe(FIRST / 1000);
    expect(all.bars).toHaveLength(3_000);
  });

  it("fetches a chart's windows side by side, with the bars paging one by one gives", async () => {
    const { coinbase } = await setup();
    const market = new MarketService([coinbase]);
    const compare = async (toMs: number, count: number) => {
      const sideBySide = await market.getBars('COINBASE:XRPUSD', '1', toMs / 1000, count);
      expect(sideBySide).toEqual(await pageBack(coinbase, 'XRPUSD', r('1'), toMs, count));
      return sideBySide;
    };
    // Through the long quiet stretch, and back to the first trade.
    expect(await compare(QUIET.to + 100 * MIN, 1_000)).toMatchObject({ hasMore: true });
    const first = await compare(FIRST + 1_000 * MIN, 1_500);
    expect(first.hasMore).toBe(false);
    expect(first.bars).toHaveLength(1_000);
  }, 20_000);

  it('asks for each past window once, though the look-backs from its neighbours ask too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(END + 1_440 * MIN); // every window here has closed
    const { coinbase, requested } = await setup();
    const market = new MarketService([coinbase]);
    const listed = await market.getBars(
      'COINBASE:XRPUSD',
      '1',
      (FIRST + 1_000 * MIN) / 1000,
      1_500,
    );
    expect(listed.bars).toHaveLength(1_000);
    // Five windows side by side; the oldest three look back two windows each, which takes only
    // the two windows behind them.
    expect(requested.filter((url) => url.includes('/candles'))).toHaveLength(7);
  }, 20_000);

  it('polls the live candle every 30 s, the previous bar too', async () => {
    const { coinbase } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const updates: CandleUpdate[] = [];
    const stop = coinbase.subscribeCandles('XRPUSD', r('1D'), (update) => updates.push(update));
    await vi.advanceTimersByTimeAsync(CANDLE_POLL_MS - 1);
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updates).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(CANDLE_POLL_MS * 2);
    expect(updates).toHaveLength(2);
  });

  it('streams trades and the best bid and ask, kept alive by the heartbeats channel', async () => {
    const { server, coinbase } = await setup();
    const trades: Trade[] = [];
    const books: BookTop[] = [];
    coinbase.subscribeTrades('XRPUSD', (trade) => trades.push(trade));
    coinbase.subscribeBook('XRPUSD', (top) => books.push(top));
    await vi.waitFor(() =>
      expect(server.received).toEqual([
        { type: 'subscribe', channel: 'heartbeats' },
        { type: 'subscribe', channel: 'market_trades', product_ids: ['XRP-USD'] },
        { type: 'subscribe', channel: 'ticker', product_ids: ['XRP-USD'] },
      ]),
    );
    server.push(ws.trades_snapshot);
    server.push(ws.trades_update);
    server.push(ws.ticker);
    await vi.waitFor(() => expect(books).toHaveLength(1));
    expect(trades.map((t) => t.price)).toEqual([1.3153]);
  });
});
