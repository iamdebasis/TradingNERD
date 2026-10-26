import type { Bar, BarsResponse, StreamState } from '@tradingnerd/core';
import { describe, expect, it, vi } from 'vitest';
import { type DailyBars, QuoteFeed, type QuoteListener } from '../src/market/quotes.ts';
import { MarketError } from '../src/market/types.ts';

const DAY = 86_400;
const TODAY = Date.UTC(2026, 9, 18) / 1000;
const day = (time: number, close: number): Bar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

/** Daily bars driven by the test. */
function fakeDaily(recent: Promise<BarsResponse>) {
  let inner: Parameters<DailyBars['subscribe']>[0] | null = null;
  const daily: DailyBars = {
    subscribe: (listener) => {
      inner = listener;
      return () => {
        inner = null;
      };
    },
    fetchRecent: () => recent,
  };
  return {
    daily,
    bar: (bar: Bar, historical = false) => inner?.onBar(bar, historical),
    state: (state: StreamState) => inner?.onState(state),
    error: (error: MarketError) => inner?.onError(error),
    subscribed: () => inner !== null,
  };
}

function recorder() {
  const events: string[] = [];
  const listener: QuoteListener = {
    onQuote: (last, prevClose) => events.push(`quote ${last} ${prevClose}`),
    onState: (state) => events.push(`state ${state}`),
    onError: (error) => events.push(`error ${error.code}`),
  };
  return { events, listener };
}

function start(recent: Promise<BarsResponse>) {
  const fake = fakeDaily(recent);
  const feed = new QuoteFeed(fake.daily, 0, () => {});
  const { events, listener } = recorder();
  feed.add(listener);
  feed.start();
  return { ...fake, feed, events };
}

describe('QuoteFeed', () => {
  it("quotes the live price against yesterday's close", async () => {
    const { events, state, bar } = start(
      Promise.resolve({
        bars: [day(TODAY - DAY, 1.3115), day(TODAY, 1.3)],
        hasMore: true,
        fromListing: false,
      }),
    );
    state('live');
    bar(day(TODAY, 1.2955));
    await vi.waitFor(() => expect(events.at(-1)).toBe('quote 1.2955 1.3115'));
    bar(day(TODAY, 1.2961));
    expect(events.at(-1)).toBe('quote 1.2961 1.3115');
  });

  it('sends nothing for trades that change neither the price nor the previous close', async () => {
    const { events, bar } = start(
      Promise.resolve({
        bars: [day(TODAY - DAY, 1.3115), day(TODAY, 1.3)],
        hasMore: true,
        fromListing: false,
      }),
    );
    bar(day(TODAY, 1.29));
    await vi.waitFor(() => expect(events).toEqual(['quote 1.29 1.3115']));
    bar({ ...day(TODAY, 1.29), volume: 5 }); // more trades at the same price
    bar(day(TODAY, 1.3));
    bar(day(TODAY, 1.29)); // back again: that's news
    expect(events).toEqual(['quote 1.29 1.3115', 'quote 1.3 1.3115', 'quote 1.29 1.3115']);
  });

  it("rolls over at midnight: the old day's last price becomes the previous close", async () => {
    const { events, bar } = start(
      Promise.resolve({
        bars: [day(TODAY - DAY, 1.3115), day(TODAY, 1.3)],
        hasMore: true,
        fromListing: false,
      }),
    );
    bar(day(TODAY, 1.29));
    await vi.waitFor(() => expect(events.at(-1)).toBe('quote 1.29 1.3115'));
    bar(day(TODAY + DAY, 1.31));
    expect(events.at(-1)).toBe('quote 1.31 1.29');
    // The exchange's final word on the old day.
    bar(day(TODAY, 1.2905), true);
    expect(events.at(-1)).toBe('quote 1.31 1.2905');
    // Corrections to older days don't matter.
    bar(day(TODAY - DAY, 9), true);
    expect(events.at(-1)).toBe('quote 1.31 1.2905');
  });

  it('ignores a REST answer the stream has already moved past', async () => {
    let answer: (value: BarsResponse) => void = () => {};
    const { events, bar } = start(new Promise((resolve) => (answer = resolve)));
    bar(day(TODAY, 1.29));
    bar(day(TODAY + DAY, 1.31));
    answer({
      bars: [day(TODAY - DAY, 1.3115), day(TODAY, 1.29)],
      hasMore: true,
      fromListing: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toBe('quote 1.31 1.29');
  });

  it('waits for the previous close, so a row never shows a price without its change', async () => {
    let answer: (value: BarsResponse) => void = () => {};
    const { events, bar } = start(new Promise((resolve) => (answer = resolve)));
    bar(day(TODAY, 1.29));
    expect(events).toEqual([]);
    answer({
      bars: [day(TODAY - DAY, 1.3115), day(TODAY, 1.29)],
      hasMore: true,
      fromListing: false,
    });
    await vi.waitFor(() => expect(events).toEqual(['quote 1.29 1.3115']));
  });

  it('still quotes the price when the previous close is unavailable', async () => {
    const { events, bar } = start(Promise.reject(new Error('Binance is unreachable')));
    bar(day(TODAY, 1.29));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['quote 1.29 null']);
  });

  it('passes errors on and lets go of the daily feed', async () => {
    const { events, error, subscribed } = start(new Promise(() => {}));
    error(new MarketError('unknown_symbol', 'Not listed'));
    expect(events).toEqual(['error unknown_symbol']);
    expect(subscribed()).toBe(false);
  });
});
