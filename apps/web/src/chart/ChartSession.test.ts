import type { HoverInfo } from '@tradingnerd/chart';
import type { Bar, BarsResponse, SymbolInfo } from '@tradingnerd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type MarketApi } from '../data/api';
import type { BarHandlers, BookHandlers, LiveFeed } from '../data/GatewayConnection';
import {
  ChartSession,
  type ChartSurface,
  HISTORY_RETRY_MS,
  INITIAL_BARS,
  type LegendView,
  PAGE_BARS,
} from './ChartSession';

const DAY = 86_400;
const LAST = Date.UTC(2026, 9, 18) / 1000;
const INFO: SymbolInfo = {
  id: 'BINANCE:XRPUSDT',
  exchange: 'BINANCE',
  exchangeName: 'Binance',
  ticker: 'XRPUSDT',
  base: 'XRP',
  quote: 'USDT',
  description: 'XRP / TetherUS',
  type: 'spot',
  tickSize: 0.0001,
  pricePrecision: 4,
  resolutions: ['1D'],
};

const makeBar = (time: number, close = 1): Bar => ({
  time,
  open: 1,
  high: 2,
  low: 0.5,
  close,
  volume: 1,
});

/** `count` daily bars ending at LAST. */
const history = (count: number) =>
  Array.from({ length: count }, (_, i) => makeBar(LAST - (count - 1 - i) * DAY));

class FakeChart implements ChartSurface {
  bars: Bar[] = [];
  readonly calls: string[] = [];
  setInstrument() {
    this.calls.push('setInstrument');
  }
  setBars(bars: readonly Bar[]) {
    this.calls.push(`setBars ${bars.length}`);
    this.bars = [...bars];
  }
  prependBars(bars: readonly Bar[]) {
    this.calls.push(`prependBars ${bars.length}`);
    this.bars = [...bars, ...this.bars];
  }
  mergeRecent(bars: readonly Bar[]) {
    this.calls.push(`mergeRecent ${bars.length}`);
  }
  updateBar(bar: Bar, historical?: boolean) {
    this.calls.push(`updateBar ${bar.time}${historical ? ' historical' : ''}`);
    if (bar.time > (this.bars.at(-1)?.time ?? 0)) this.bars.push(bar);
    else this.bars[this.bars.length - 1] = bar;
  }
  firstBarTime() {
    return this.bars[0]?.time ?? null;
  }
  latest() {
    const bar = this.bars.at(-1);
    return bar ? { bar, previous: this.bars.at(-2) ?? null } : null;
  }
  showLatest() {
    this.calls.push('showLatest');
  }
}

class FakeLegend implements LegendView {
  readonly calls: string[] = [];
  setInstrument(info: SymbolInfo) {
    this.calls.push(`instrument ${info.description}`);
  }
  showBar(bar: Bar) {
    this.calls.push(`bar ${bar.time} ${bar.close}`);
  }
  setBook(bid: number, ask: number) {
    this.calls.push(`book ${bid}/${ask}`);
  }
  setStatus(status: string, message?: string) {
    this.calls.push(message ? `status ${status}: ${message}` : `status ${status}`);
  }
}

class FakeFeed implements LiveFeed {
  bars: BarHandlers | null = null;
  book: BookHandlers | null = null;
  unsubscribed = 0;
  subscribeBars(_symbol: string, _resolution: string, handlers: BarHandlers) {
    this.bars = handlers;
    return () => this.unsubscribed++;
  }
  subscribeBook(_symbol: string, handlers: BookHandlers) {
    this.book = handlers;
    return () => this.unsubscribed++;
  }
}

function fakeApi(data: Bar[]) {
  const requests: { to: number | null; countBack: number }[] = [];
  let failure: Error | null = null;
  const api: MarketApi = {
    resolveSymbol: async () => INFO,
    getBars: async (_symbol, _resolution, to, countBack): Promise<BarsResponse> => {
      requests.push({ to, countBack });
      if (failure) throw failure;
      const eligible = data.filter((bar) => to === null || bar.time < to);
      return { bars: eligible.slice(-countBack), hasMore: eligible.length > countBack };
    },
  };
  return { api, requests, fail: (error: Error | null) => (failure = error) };
}

function setup(data = history(2_500)) {
  const chart = new FakeChart();
  const legend = new FakeLegend();
  const feed = new FakeFeed();
  const { api, requests, fail } = fakeApi(data);
  const session = new ChartSession({
    chart,
    api,
    feed,
    legend,
    symbol: 'BINANCE:XRPUSDT',
    resolution: '1D',
  });
  return { session, chart, legend, feed, requests, fail };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ChartSession', () => {
  it('opens in order: symbol, history, legend, then the live feed', async () => {
    const { session, chart, legend, feed, requests } = setup();
    await session.start();
    expect(requests).toEqual([{ to: null, countBack: INITIAL_BARS }]);
    expect(chart.calls).toEqual(['setInstrument', `setBars ${INITIAL_BARS}`, 'showLatest']);
    expect(legend.calls).toEqual(['status loading', 'instrument XRP / TetherUS', `bar ${LAST} 1`]);
    expect(feed.bars).not.toBeNull();
    expect(feed.book).not.toBeNull();
  });

  it('applies live bars and keeps the legend on the latest bar', async () => {
    const { session, chart, legend, feed } = setup();
    await session.start();
    feed.bars?.onState('live');
    feed.bars?.onBar(makeBar(LAST, 1.5), false);
    feed.bars?.onBar(makeBar(LAST + DAY, 1.6), false);
    expect(chart.calls.slice(-2)).toEqual([`updateBar ${LAST}`, `updateBar ${LAST + DAY}`]);
    expect(legend.calls.slice(-3)).toEqual([
      'status live',
      `bar ${LAST} 1.5`,
      `bar ${LAST + DAY} 1.6`,
    ]);
  });

  it('keeps the legend on a hovered older bar while live updates arrive', async () => {
    const { session, legend, feed } = setup();
    await session.start();
    const older: HoverInfo = { bar: makeBar(LAST - 10 * DAY, 0.9), previous: null };
    session.hover(older);
    feed.bars?.onBar(makeBar(LAST, 1.7), false);
    expect(legend.calls.at(-1)).toBe(`bar ${LAST - 10 * DAY} 0.9`);
    session.hover(null);
    expect(legend.calls.at(-1)).toBe(`bar ${LAST} 1.7`);
  });

  it('follows live updates while the latest bar itself is hovered', async () => {
    const { session, legend, feed } = setup();
    await session.start();
    session.hover({ bar: makeBar(LAST, 1), previous: null });
    feed.bars?.onBar(makeBar(LAST, 1.8), false);
    expect(legend.calls.at(-1)).toBe(`bar ${LAST} 1.8`);
  });

  it('loads one older page at a time and stops at the start of history', async () => {
    const { session, chart, requests } = setup(history(2_500));
    await session.start();
    await Promise.all([session.loadOlder(), session.loadOlder()]);
    expect(requests.slice(1)).toEqual([
      { to: LAST - (INITIAL_BARS - 1) * DAY, countBack: PAGE_BARS },
    ]);
    await session.loadOlder();
    expect(chart.calls.filter((c) => c.startsWith('prependBars'))).toEqual([
      'prependBars 1000',
      'prependBars 500',
    ]);
    await session.loadOlder(); // the exchange said there's no more
    expect(requests).toHaveLength(3);
  });

  it('pauses paging after a failure instead of hammering the gateway', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { session, requests, fail } = setup();
    await session.start();
    fail(new ApiError('network', 'down'));
    await session.loadOlder();
    await session.loadOlder();
    expect(requests).toHaveLength(2);
    fail(null);
    vi.setSystemTime(Date.now() + HISTORY_RETRY_MS);
    await session.loadOlder();
    expect(requests).toHaveLength(3);
  });

  it('refills recent bars when the feed comes back after an outage', async () => {
    const { session, chart, legend, feed, requests } = setup();
    await session.start();
    feed.bars?.onState('live');
    feed.bars?.onState('reconnecting');
    expect(legend.calls.at(-1)).toBe('status reconnecting');
    feed.bars?.onState('live');
    await vi.waitFor(() => expect(chart.calls.at(-1)).toBe('mergeRecent 1000'));
    expect(requests.at(-1)).toEqual({ to: null, countBack: 1_000 });
    expect(legend.calls).toContain('status live');
  });

  it('passes quotes to the legend', async () => {
    const { session, legend, feed } = setup();
    await session.start();
    feed.book?.onBook(1.2955, 1.2956);
    expect(legend.calls.at(-1)).toBe('book 1.2955/1.2956');
  });

  it('shows why a symbol could not be loaded', async () => {
    const { chart, legend, feed } = setup();
    const session = new ChartSession({
      chart,
      legend,
      feed,
      symbol: 'BINANCE:NOPE',
      resolution: '1D',
      api: {
        resolveSymbol: async () => {
          throw new ApiError('unknown_symbol', 'Binance does not list this symbol');
        },
        getBars: async () => ({ bars: [], hasMore: false }),
      },
    });
    await session.start();
    expect(legend.calls.at(-1)).toBe('status error: Binance does not list this symbol');
    expect(feed.bars).toBeNull();
  });

  it('rejects an invalid interval without calling the gateway', async () => {
    const { chart, legend, feed, requests } = setup();
    const { api } = fakeApi([]);
    const session = new ChartSession({
      chart,
      legend,
      feed,
      api,
      symbol: 'BINANCE:XRPUSDT',
      resolution: '7X',
    });
    await session.start();
    expect(legend.calls).toEqual(['status error: "7X" is not a valid interval']);
    expect(requests).toEqual([]);
  });

  it('cleans up completely, even with a request in flight', async () => {
    const { chart, legend, feed } = setup();
    let release: () => void = () => {};
    const session = new ChartSession({
      chart,
      legend,
      feed,
      symbol: 'BINANCE:XRPUSDT',
      resolution: '1D',
      api: {
        resolveSymbol: async () => INFO,
        getBars: () =>
          new Promise((resolve) => {
            release = () => resolve({ bars: history(5), hasMore: false });
          }),
      },
    });
    const started = session.start();
    await vi.waitFor(() => expect(legend.calls).toContain('instrument XRP / TetherUS'));
    session.dispose();
    release();
    await started;
    // The chart belongs to the pane, which may already show the next interval: untouched.
    expect(chart.calls).toEqual([]);
    expect(feed.bars).toBeNull();
  });

  it('leaves the chart alone until its first page is in, then swaps it over at once', async () => {
    const { chart, legend, feed } = setup();
    let release: () => void = () => {};
    const requests: (number | null)[] = [];
    const session = new ChartSession({
      chart,
      legend,
      feed,
      symbol: 'BINANCE:XRPUSDT',
      resolution: '15',
      api: {
        resolveSymbol: async () => INFO,
        getBars: (_symbol, _resolution, to) => {
          requests.push(to);
          return new Promise((resolve) => {
            release = () => resolve({ bars: history(5), hasMore: true });
          });
        },
      },
    });
    chart.bars = history(50); // the previous interval, still on screen
    const started = session.start();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await session.loadOlder(); // would page back from the old interval's bars
    expect(requests).toEqual([null]);
    expect(chart.calls).toEqual([]);
    release();
    await started;
    expect(chart.calls).toEqual(['setInstrument', 'setBars 5', 'showLatest']);
  });

  it('unsubscribes from the live feed on dispose', async () => {
    const { session, feed } = setup();
    await session.start();
    session.dispose();
    expect(feed.unsubscribed).toBe(2);
  });
});
