import type { Bar, BarsResponse, SymbolInfo } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type MarketApi } from '../data/api';
import type { BarHandlers, LiveFeed } from '../data/GatewayConnection';
import {
  currencyPath,
  REQUEST_PAGE_BARS,
  REQUEST_RETRY_MS,
  RequestLoader,
  WARMUP_BARS,
} from './requestLoader';

/** Daily bars from 2020, one a day, closes counting up. */
const DAY = 86_400;
const START = Date.UTC(2020, 0, 1) / 1000;
const days = (count: number, from = START): Bar[] =>
  Array.from({ length: count }, (_, i) => ({
    time: from + i * DAY,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10,
  }));

const info = (id: string): SymbolInfo => ({
  id,
  exchange: id.split(':')[0] as string,
  exchangeName: 'Binance',
  ticker: id.split(':')[1] as string,
  base: 'ETH',
  quote: 'USDT',
  description: 'ETH / TetherUS',
  type: 'spot',
  tickSize: 0.01,
  pricePrecision: 2,
  resolutions: ['1D'],
  timezone: 'Etc/UTC',
  delayMs: 0,
  hasBook: true,
});

/** The gateway's bars route as the real one pages: strictly before `to`, the latest first. */
function fakeApi(series: Record<string, Bar[]>, fail?: (symbol: string) => Error | null) {
  const calls: string[] = [];
  const api: MarketApi = {
    async resolveSymbol(symbol) {
      calls.push(`resolve ${symbol}`);
      const error = fail?.(symbol);
      if (error) throw error;
      if (!Object.keys(series).some((key) => key.startsWith(`${symbol}@`))) {
        throw new ApiError('unknown_symbol', `Unknown symbol ${symbol}`);
      }
      return info(symbol);
    },
    async getBars(symbol, resolution, to, countBack): Promise<BarsResponse> {
      calls.push(`bars ${symbol} ${resolution} ${to ?? 'latest'} ${countBack}`);
      const all = series[`${symbol}@${resolution}`] ?? [];
      const eligible = all.filter((bar) => to === null || bar.time < to);
      const hasMore = eligible.length > countBack;
      return { bars: eligible.slice(-countBack), hasMore, fromListing: !hasMore };
    },
  };
  return { api, calls };
}

function fakeFeed() {
  const subscriptions = new Map<string, BarHandlers>();
  const feed: LiveFeed = {
    subscribeBars(symbol, resolution, handlers) {
      const key = `${symbol}@${resolution}`;
      subscriptions.set(key, handlers);
      return () => subscriptions.delete(key);
    },
    subscribeBook: () => () => {},
  };
  return { feed, subscriptions };
}

/** Lets the loader's awaits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ETH = { symbol: 'BINANCE:ETHUSDT', timeframe: '1D' };

describe("RequestLoader: the data scripts' requests ask for (docs/SPEC.md §6.18)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads a context back past the chart’s first bar, then follows it live', async () => {
    const series = { 'BINANCE:ETHUSDT@1D': days(12_000) };
    const { api, calls } = fakeApi(series);
    const { feed, subscriptions } = fakeFeed();
    const history = vi.fn();
    const live = vi.fn();
    const loader = new RequestLoader({
      api,
      feed,
      background: '#0F0F0F',
      onHistory: history,
      onLive: live,
    });
    // The chart's first bar: 4,900 days before the last, so one page of 5,000 doesn't reach
    // WARMUP_BARS before it.
    const chartFirst = (series['BINANCE:ETHUSDT@1D'][7_100] as Bar).time;
    loader.want([ETH], [ETH], { firstBarTime: chartFirst, timeframe: '1D' });
    expect(loader.data(ETH)).toBeNull();
    await settle();
    const data = loader.data(ETH);
    if (!data || data === 'invalid') throw new Error('not loaded');
    // Pages of the gateway's most until WARMUP_BARS before the chart's first bar are in.
    expect(calls.filter((call) => call.startsWith('bars'))).toHaveLength(2);
    expect(data.bars[0]?.time).toBeLessThanOrEqual(chartFirst - WARMUP_BARS * DAY);
    expect(data.bars).toHaveLength(2 * REQUEST_PAGE_BARS);
    expect(data.symbol.tickerid).toBe('BINANCE:ETHUSDT');
    expect(data.symbol.timeframe).toBe('1D');
    expect(data.symbol.currency).toBe('USDT');
    expect(history).toHaveBeenCalledTimes(1);

    // A live update of the last bar: a new version of the same history.
    const handlers = subscriptions.get('BINANCE:ETHUSDT@1D');
    const last = data.bars.at(-1) as Bar;
    handlers?.onBar({ ...last, close: 1 }, false);
    const ticked = loader.data(ETH);
    if (!ticked || ticked === 'invalid') throw new Error('gone');
    expect(ticked.version).toBe(data.version + 1);
    expect(ticked.history).toBe(data.history);
    expect(ticked.bars.at(-1)?.close).toBe(1);
    expect(live).toHaveBeenCalledTimes(1);
    // A new bar opens after it.
    handlers?.onBar({ ...last, time: last.time + DAY }, false);
    const next = loader.data(ETH);
    if (!next || next === 'invalid') throw new Error('gone');
    expect(next.bars).toHaveLength(data.bars.length);
    expect(next.bars.at(-1)?.time).toBe(last.time + DAY);
  });

  it('calls the last bar forming again when the stream opens a new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const series = { 'BINANCE:ETHUSDT@1D': days(10) };
    const last = series['BINANCE:ETHUSDT@1D'].at(-1) as Bar;
    // A minute into the day after the last one: that bar has closed, the next isn't in yet.
    vi.setSystemTime((last.time + DAY) * 1000 + 60_000);
    const { api } = fakeApi(series);
    const { feed, subscriptions } = fakeFeed();
    const loader = new RequestLoader({
      api,
      feed,
      background: '#0F0F0F',
      onHistory: () => {},
      onLive: () => {},
    });
    loader.want([ETH], [ETH], { firstBarTime: START, timeframe: '1D' });
    await settle();
    const closed = loader.data(ETH);
    if (!closed || closed === 'invalid') throw new Error('not loaded');
    expect(closed.live).toBe(false);
    subscriptions.get('BINANCE:ETHUSDT@1D')?.onBar({ ...last, time: last.time + DAY }, false);
    const opened = loader.data(ETH);
    if (!opened || opened === 'invalid') throw new Error('gone');
    expect(opened.live).toBe(true);
  });

  it('pages back again when the chart reaches further back', async () => {
    const series = { 'BINANCE:ETHUSDT@1D': days(20_000) };
    const { api } = fakeApi(series);
    const { feed } = fakeFeed();
    const loader = new RequestLoader({
      api,
      feed,
      background: '#0F0F0F',
      onHistory: () => {},
      onLive: () => {},
    });
    const bars = series['BINANCE:ETHUSDT@1D'];
    loader.want([ETH], [ETH], { firstBarTime: (bars[19_500] as Bar).time, timeframe: '1D' });
    await settle();
    const first = loader.data(ETH);
    if (!first || first === 'invalid') throw new Error('not loaded');
    expect(first.bars).toHaveLength(REQUEST_PAGE_BARS);
    loader.want([], [ETH], { firstBarTime: (bars[10_000] as Bar).time, timeframe: '1D' });
    await settle();
    const deeper = loader.data(ETH);
    if (!deeper || deeper === 'invalid') throw new Error('not loaded');
    expect(deeper.bars).toHaveLength(2 * REQUEST_PAGE_BARS);
    expect(deeper.history).toBe(first.history + 1);
  });

  it('calls a symbol that doesn’t exist invalid, and tries a failed call again later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 7));
    let down = true;
    const { api } = fakeApi({ 'BINANCE:ETHUSDT@1D': days(10) }, (symbol) =>
      down && symbol === 'BINANCE:ETHUSDT' ? new ApiError('network', 'unreachable') : null,
    );
    const { feed } = fakeFeed();
    const history = vi.fn();
    const loader = new RequestLoader({
      api,
      feed,
      background: '#0F0F0F',
      onHistory: history,
      onLive: () => {},
    });
    const nope = { symbol: 'BINANCE:NOPEUSDT', timeframe: '1D' };
    const reach = { firstBarTime: START, timeframe: '1D' };
    loader.want([nope, ETH], [nope, ETH], reach);
    await settle();
    expect(loader.data(nope)).toBe('invalid');
    expect(history).toHaveBeenCalledTimes(1);
    // The gateway was down: still loading, so the script waits.
    expect(loader.data(ETH)).toBeNull();
    down = false;
    loader.want([ETH], [ETH], reach);
    await settle();
    expect(loader.data(ETH)).toBeNull();
    vi.setSystemTime(Date.now() + REQUEST_RETRY_MS);
    loader.want([ETH], [ETH], reach);
    await settle();
    expect(loader.data(ETH)).not.toBeNull();
  });

  it('finds a ticker given without its exchange, and lets go of what no script asks for', async () => {
    const { api } = fakeApi({ 'BINANCE:ETHUSDT@1D': days(10) });
    const { feed, subscriptions } = fakeFeed();
    const loader = new RequestLoader({
      api,
      feed,
      background: '#0F0F0F',
      onHistory: () => {},
      onLive: () => {},
      find: async (ticker) => (ticker === 'ETHUSDT' ? 'BINANCE:ETHUSDT' : null),
    });
    const bare = { symbol: 'ETHUSDT', timeframe: '1D' };
    const unknown = { symbol: 'NOPE', timeframe: '1D' };
    const reach = { firstBarTime: START, timeframe: '1D' };
    loader.want([bare, unknown], [bare, unknown], reach);
    await settle();
    const data = loader.data(bare);
    expect(data && data !== 'invalid' && data.symbol.tickerid).toBe('BINANCE:ETHUSDT');
    expect(loader.data(unknown)).toBe('invalid');
    expect(subscriptions.size).toBe(1);
    loader.want([], [], reach);
    expect(subscriptions.size).toBe(0);
    expect(loader.data(bare)).toBeNull();
  });
});

describe('Currency pairs for conversions (provisional: Kraken’s, docs/SPEC.md §11)', () => {
  it('goes through the dollar, each pair read as its price or its inverse', () => {
    expect(currencyPath('USDT', 'USD')).toEqual([{ symbol: 'KRAKEN:USDTUSD', invert: false }]);
    expect(currencyPath('USD', 'JPY')).toEqual([{ symbol: 'KRAKEN:USDJPY', invert: false }]);
    expect(currencyPath('EUR', 'JPY')).toEqual([
      { symbol: 'KRAKEN:EURUSD', invert: false },
      { symbol: 'KRAKEN:USDJPY', invert: false },
    ]);
    expect(currencyPath('USD', 'USD')).toEqual([]);
    // No pair of ours: no rate, and the script says so.
    expect(currencyPath('TRY', 'USD')).toBeNull();
  });
});
