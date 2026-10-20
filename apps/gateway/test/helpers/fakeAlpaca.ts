import { type Bar, dateOf, MarketSchedule, timeZone } from '@tradingnerd/core';
import { NYSE_2026 } from '@tradingnerd/core/testing';

/**
 * A fake Alpaca on the free plan, for tests: minute bars of each symbol in extended hours
 * (04:00–20:00 New York) on the NYSE's 2026 trading days from `dataFrom`, Alpaca's 5, 15
 * and 30-minute and daily bars built from them, the calendar and the asset list. Like the free
 * plan, it refuses whole-market requests reaching into the last 15 minutes.
 */

const MINUTE = 60_000;
const nyse = new MarketSchedule(NYSE_2026);
const newYork = timeZone('America/New_York');

export interface FakeAlpacaOptions {
  now: () => number;
  symbols?: readonly string[];
  /** First day with data. */
  dataFrom?: string;
  /** Real-time access (no 15-minute refusal). */
  realtime?: boolean;
}

/** A symbol's price at a minute: a slow, deterministic walk. */
export function priceAt(symbol: string, ms: number): number {
  const base = 100 + (symbol.charCodeAt(0) % 10) * 10;
  return Math.round((base + ((ms / MINUTE) % 600) * 0.01) * 100) / 100;
}

function minuteBar(symbol: string, ms: number): Bar {
  const price = priceAt(symbol, ms);
  return {
    time: ms / 1000,
    open: price,
    high: Math.round((price + 0.05) * 100) / 100,
    low: Math.round((price - 0.05) * 100) / 100,
    close: Math.round((price + 0.01) * 100) / 100,
    volume: 100,
  };
}

export function createFakeAlpaca(options: FakeAlpacaOptions) {
  const symbols = new Set(options.symbols ?? ['AAPL', 'SPY', 'BRK.B']);
  const dataFrom = options.dataFrom ?? '2026-10-01';
  const requests: URL[] = [];
  let failing = false;

  /** Every minute bar of a symbol from `dataFrom` through `until` (exclusive), extended hours. */
  function minutes(symbol: string, until: number): Bar[] {
    const out: Bar[] = [];
    for (let day = newYork.local(Date.parse(`${dataFrom}T12:00:00Z`)).day; ; day++) {
      const session = nyse.session(day, 'extended');
      if (!session) continue;
      if (session.open >= until) break;
      for (let ms = session.open; ms < Math.min(session.close, until); ms += MINUTE) {
        out.push(minuteBar(symbol, ms));
      }
    }
    return out;
  }

  /** Alpaca-style aggregation: clock-aligned buckets, or days at the date's New York midnight. */
  function aggregate(bars: readonly Bar[], timeframe: string): Bar[] {
    if (timeframe === '1Min') return [...bars];
    const out = new Map<number, Bar>();
    for (const bar of bars) {
      let key: number;
      if (timeframe === '1Day') {
        const { day } = newYork.local(bar.time * 1000);
        key = newYork.utc(day, 0) / 1000;
      } else {
        const step = Number.parseInt(timeframe, 10) * 60;
        key = Math.floor(bar.time / step) * step;
      }
      const current = out.get(key);
      if (!current) out.set(key, { ...bar, time: key });
      else {
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
        current.volume += bar.volume;
      }
    }
    if (timeframe === '1Day') {
      // The official day: regular-hours open, high and low, the closing auction's price.
      for (const [key, day] of out) {
        const date = newYork.local(key * 1000).day;
        const regular = nyse.session(date, 'regular');
        const inHours = bars.filter(
          (bar) => regular && bar.time * 1000 >= regular.open && bar.time * 1000 < regular.close,
        );
        const first = inHours[0];
        const last = inHours.at(-1);
        if (!first || !last) continue;
        day.open = first.open;
        day.high = Math.max(...inHours.map((bar) => bar.high));
        day.low = Math.min(...inHours.map((bar) => bar.low));
        day.close = Math.round((last.close + 0.5) * 100) / 100;
      }
    }
    return [...out.values()];
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    if (failing) return json({ message: 'internal error' }, 500);
    if (url.pathname === '/v2/calendar') {
      const from = url.searchParams.get('start') ?? '';
      const to = url.searchParams.get('end') ?? '';
      const days = [];
      for (let day = newYork.local(Date.parse(`${NYSE_2026.from}T12:00:00Z`)).day; ; day++) {
        const date = dateOf(day);
        if (date > NYSE_2026.to) break;
        const hours = nyse.hours(day, 'regular');
        if (!hours || date < from || date > to) continue;
        const clock = (minutes: number) =>
          `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        days.push({ date, open: clock(hours[0]), close: clock(hours[1]) });
      }
      return json(days);
    }
    if (url.pathname === '/v2/assets') {
      return json(
        [...symbols].map((symbol) => ({
          symbol,
          exchange: 'NASDAQ',
          name: symbol,
          status: 'active',
        })),
      );
    }
    if (url.pathname !== '/v2/stocks/bars') return json({ message: 'not found' }, 404);
    const params = url.searchParams;
    const end = Date.parse(params.get('end') ?? '');
    if (!options.realtime && end > options.now() - 15 * MINUTE) {
      return json({ message: 'subscription does not permit querying recent SIP data' }, 403);
    }
    const start = Date.parse(params.get('start') ?? '');
    const timeframe = params.get('timeframe') ?? '1Min';
    const limit = Number(params.get('limit') ?? 1000);
    const sort = params.get('sort') ?? 'asc';
    const offset = Number(params.get('page_token') ?? 0);
    const all: [string, Bar][] = [];
    for (const symbol of (params.get('symbols') ?? '').split(',')) {
      if (!symbols.has(symbol)) continue;
      // Bars whose minutes are all in by `end` (Alpaca aggregates what it has).
      const bars = aggregate(minutes(symbol, end + 1), timeframe).filter(
        (bar) => bar.time * 1000 >= start && bar.time * 1000 <= end,
      );
      if (sort === 'desc') bars.reverse();
      for (const bar of bars) all.push([symbol, bar]);
    }
    const page = all.slice(offset, offset + limit);
    const bars: Record<string, unknown[]> = {};
    for (const [symbol, bar] of page) {
      bars[symbol] ??= [];
      bars[symbol].push({
        t: new Date(bar.time * 1000).toISOString().replace('.000Z', 'Z'),
        o: bar.open,
        h: bar.high,
        l: bar.low,
        c: bar.close,
        v: bar.volume,
        n: 1,
        vw: bar.close,
      });
    }
    return json({
      bars,
      next_page_token: offset + limit < all.length ? String(offset + limit) : null,
    });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    requests,
    /** Requests for bars, as [timeframe, symbols]. */
    barRequests: () =>
      requests
        .filter((url) => url.pathname === '/v2/stocks/bars')
        .map((url) => [url.searchParams.get('timeframe'), url.searchParams.get('symbols')]),
    setFailing: (value: boolean) => {
      failing = value;
    },
    minutes,
    aggregate,
  };
}
