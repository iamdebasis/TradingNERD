import { describe, expect, it } from 'vitest';
import { MarketError } from '../src/market/types.ts';
import { AlpacaClient, type AlpacaKey } from '../src/stocks/alpaca.ts';

const KEY: AlpacaKey = { keyId: 'PKTESTKEYID123456789', secret: 'very-secret-value-0000000000' };
const NOW = Date.parse('2026-10-19T18:00:00Z');

interface Call {
  url: URL;
  headers: Record<string, string>;
}

/** A fake Alpaca: each request is answered by `respond`, and recorded. */
function fakeAlpaca(respond: (url: URL, call: number) => Response) {
  const calls: Call[] = [];
  const waits: number[] = [];
  let now = NOW;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return respond(url, calls.length - 1);
  }) as typeof globalThis.fetch;
  const options = {
    key: async () => KEY,
    fetch,
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
  return { calls, waits, options, advance: (ms: number) => (now += ms) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const rawBar = (t: string, c: number) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 100, n: 5, vw: c });

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe("Alpaca's bars", () => {
  it('asks for split-adjusted whole-market bars with the key, and follows pages', async () => {
    const fake = fakeAlpaca((_url, call) =>
      call === 0
        ? json({ bars: { AAPL: [rawBar('2026-10-19T13:30:00Z', 10)] }, next_page_token: 'p2' })
        : json({
            bars: { AAPL: [rawBar('2026-10-19T13:31:00Z', 11)], SPY: [] },
            next_page_token: null,
          }),
    );
    const client = new AlpacaClient({ ...fake.options, sip: () => 'realtime' });
    const bars = await client.bars(['AAPL', 'SPY'], {
      timeframe: '1Min',
      start: Date.parse('2026-10-19T13:30:00Z'),
      end: Date.parse('2026-10-19T14:00:00Z'),
      limit: 500,
      sort: 'asc',
    });
    expect(bars.get('AAPL')).toEqual([
      {
        time: Date.parse('2026-10-19T13:30:00Z') / 1000,
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 100,
      },
      {
        time: Date.parse('2026-10-19T13:31:00Z') / 1000,
        open: 11,
        high: 12,
        low: 10,
        close: 11,
        volume: 100,
      },
    ]);
    expect(bars.get('SPY')).toEqual([]);
    const [first, second] = fake.calls;
    expect(first?.url.origin + (first?.url.pathname ?? '')).toBe(
      'https://data.alpaca.markets/v2/stocks/bars',
    );
    expect(Object.fromEntries(first?.url.searchParams ?? [])).toEqual({
      symbols: 'AAPL,SPY',
      timeframe: '1Min',
      start: '2026-10-19T13:30:00.000Z',
      end: '2026-10-19T14:00:00.000Z',
      limit: '500',
      sort: 'asc',
      feed: 'sip',
      adjustment: 'split',
    });
    expect(first?.headers).toMatchObject({
      'APCA-API-KEY-ID': KEY.keyId,
      'APCA-API-SECRET-KEY': KEY.secret,
    });
    expect(second?.url.searchParams.get('page_token')).toBe('p2');
    expect(second?.url.searchParams.get('limit')).toBe('499');
  });

  it('never asks the free plan for the last 15 minutes', async () => {
    const fake = fakeAlpaca(() => json({ bars: {}, next_page_token: null }));
    const client = new AlpacaClient({ ...fake.options, sip: () => 'delayed' });
    const query = { timeframe: '1Min' as const, limit: 10, sort: 'desc' as const };
    await client.bars(['AAPL'], { ...query, start: NOW - 3_600_000, end: NOW });
    expect(fake.calls[0]?.url.searchParams.get('end')).toBe(
      new Date(NOW - 15 * 60_000 - 1_000).toISOString(),
    );
    // A window entirely inside the delay isn't asked for at all.
    await client.bars(['AAPL'], { ...query, start: NOW - 60_000, end: NOW });
    expect(fake.calls).toHaveLength(1);
  });

  it('wants a key, and says so when Alpaca refuses it, without ever repeating it', async () => {
    const noKey = new AlpacaClient({
      ...fakeAlpaca(() => json({})).options,
      key: async () => null,
    });
    const query = {
      timeframe: '1Day' as const,
      start: 0,
      end: NOW,
      limit: 1,
      sort: 'desc' as const,
    };
    expect(await errorOf(noKey.bars(['AAPL'], query))).toMatchObject({ code: 'needs_key' });

    const refused = new AlpacaClient(
      fakeAlpaca(() => json({ message: 'forbidden.' }, 403)).options,
    );
    const error = await errorOf(refused.bars(['AAPL'], query));
    expect(error).toBeInstanceOf(MarketError);
    expect(error).toMatchObject({ code: 'needs_key' });
    expect(error.message).not.toContain(KEY.secret);
    expect(error.message).not.toContain(KEY.keyId);
  });

  it('waits for the rate limit to reset, then gives up after three tries', async () => {
    const reset = String(Math.floor(NOW / 1000) + 2);
    const fake = fakeAlpaca((_url, call) =>
      call === 0
        ? json({ message: 'too many requests.' }, 429, { 'x-ratelimit-reset': reset })
        : json({ bars: { AAPL: [] }, next_page_token: null }),
    );
    const client = new AlpacaClient({ ...fake.options, sip: () => 'realtime' });
    const query = {
      timeframe: '1Day' as const,
      start: 0,
      end: NOW,
      limit: 1,
      sort: 'desc' as const,
    };
    await client.bars(['AAPL'], query);
    expect(fake.waits).toEqual([2_000]);

    const always = fakeAlpaca(() => json({ message: 'too many requests.' }, 429));
    const limited = new AlpacaClient({ ...always.options, sip: () => 'realtime' });
    expect(await errorOf(limited.bars(['AAPL'], query))).toMatchObject({ code: 'rate_limited' });
    expect(always.calls).toHaveLength(3);
  });

  it('keeps under its own per-minute allowance', async () => {
    const fake = fakeAlpaca(() => json({ bars: {}, next_page_token: null }));
    const client = new AlpacaClient({
      ...fake.options,
      sip: () => 'realtime',
      requestsPerMinute: 2,
    });
    const query = {
      timeframe: '1Day' as const,
      start: 0,
      end: NOW,
      limit: 1,
      sort: 'desc' as const,
    };
    await Promise.all([1, 2, 3].map(() => client.bars(['AAPL'], query)));
    expect(fake.calls).toHaveLength(3);
    expect(fake.waits).toEqual([60_000]);
  });
});

describe("checking a key's plan", () => {
  it('finds real-time access, delayed access, or a key Alpaca refuses', async () => {
    const realtime = new AlpacaClient(
      fakeAlpaca(() => json({ bars: {}, next_page_token: null })).options,
    );
    expect(await realtime.checkKey(KEY)).toBe('realtime');

    const delayed = fakeAlpaca(() =>
      json({ message: 'subscription does not permit querying recent SIP data' }, 403),
    );
    expect(await new AlpacaClient(delayed.options).checkKey(KEY)).toBe('delayed');
    expect(delayed.calls[0]?.url.searchParams.get('feed')).toBe('sip');

    const wrong = new AlpacaClient(
      fakeAlpaca(() => json({ message: 'unauthorized.' }, 401)).options,
    );
    expect(await errorOf(wrong.checkKey(KEY))).toMatchObject({ code: 'needs_key' });
  });
});

describe("Alpaca's trading API", () => {
  it('finds the host the key belongs to (paper first) and remembers it', async () => {
    const fake = fakeAlpaca((url) =>
      url.hostname === 'paper-api.alpaca.markets'
        ? json({ message: 'unauthorized.' }, 401)
        : json([
            { date: '2026-11-25', open: '09:30', close: '16:00', session_open: '0400' },
            { date: '2026-11-27', open: '09:30', close: '13:00' },
            { date: 7 },
          ]),
    );
    const client = new AlpacaClient(fake.options);
    expect(await client.calendar('2026-11-25', '2026-11-27')).toEqual([
      { date: '2026-11-25', open: '09:30', close: '16:00' },
      { date: '2026-11-27', open: '09:30', close: '13:00' },
    ]);
    expect(fake.calls.map((call) => call.url.hostname)).toEqual([
      'paper-api.alpaca.markets',
      'api.alpaca.markets',
    ]);
    expect(fake.calls[1]?.url.searchParams.get('start')).toBe('2026-11-25');
    await client.calendar('2026-11-25', '2026-11-27');
    expect(fake.calls.at(-1)?.url.hostname).toBe('api.alpaca.markets');
  });

  it('lists active US equities', async () => {
    const fake = fakeAlpaca(() =>
      json([
        { symbol: 'AAPL', exchange: 'NASDAQ', name: 'Apple Inc. Common Stock', status: 'active' },
        { symbol: 'BRK.B', exchange: 'NYSE', name: 'Berkshire Hathaway', status: 'active' },
        { nonsense: true },
      ]),
    );
    const assets = await new AlpacaClient(fake.options).assets();
    expect(assets.map((asset) => asset.symbol)).toEqual(['AAPL', 'BRK.B']);
    expect(Object.fromEntries(fake.calls[0]?.url.searchParams ?? [])).toEqual({
      status: 'active',
      asset_class: 'us_equity',
    });
  });
});
