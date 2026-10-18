import { describe, expect, it, vi } from 'vitest';
import { BinanceRest } from '../src/exchanges/binance/BinanceRest.ts';
import { MarketError } from '../src/market/types.ts';

const row = (openMs: number) => [
  openMs,
  '1.3',
  '1.31',
  '1.29',
  '1.305',
  '100',
  openMs + 59_999,
  '0',
  1,
  '0',
  '0',
  '0',
];

function client(respond: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    return respond(url);
  });
  const rest = new BinanceRest({
    baseUrl: 'https://binance.test/',
    assetsUrl: 'https://binance.test/assets',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { rest, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function errorOf(promise: Promise<unknown>): Promise<MarketError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('BinanceRest.klines', () => {
  it('asks for bars strictly before the exclusive end time', async () => {
    const { rest, calls } = client(() => json([row(60_000), row(120_000)]));
    const bars = await rest.klines('XRPUSDT', '1m', 180_000, 500);
    expect(bars.map((bar) => bar.time)).toEqual([60, 120]);
    const params = calls[0]?.searchParams;
    expect(calls[0]?.pathname).toBe('/api/v3/klines');
    expect(params?.get('symbol')).toBe('XRPUSDT');
    expect(params?.get('interval')).toBe('1m');
    expect(params?.get('limit')).toBe('500');
    expect(params?.get('endTime')).toBe('179999');
  });

  it('omits endTime to get the latest bars', async () => {
    const { rest, calls } = client(() => json([row(60_000)]));
    await rest.klines('XRPUSDT', '1d', null, 1);
    expect(calls[0]?.searchParams.has('endTime')).toBe(false);
  });

  it('rejects malformed rows instead of charting garbage', async () => {
    const { rest } = client(() => json([row(60_000), ['bad']]));
    expect((await errorOf(rest.klines('XRPUSDT', '1m', null, 2))).code).toBe('upstream_error');
  });
});

describe('BinanceRest errors', () => {
  it.each([
    [
      'an unknown symbol',
      () => json({ code: -1121, msg: 'Invalid symbol.' }, 400),
      'unknown_symbol',
    ],
    ['rate limiting (429)', () => json({ code: -1003 }, 429), 'rate_limited'],
    ['an IP ban (418)', () => json({ code: -1003 }, 418), 'rate_limited'],
    ['a geo-block (451)', () => json({ code: 0, msg: 'restricted' }, 451), 'upstream_error'],
    ['a server error', () => json({ code: -1000 }, 500), 'upstream_error'],
    ['a non-JSON body', () => new Response('<html>', { status: 200 }), 'upstream_error'],
  ])('maps %s', async (_label, respond, code) => {
    const { rest } = client(respond);
    expect((await errorOf(rest.symbol('XRPUSDT'))).code).toBe(code);
  });

  it('explains a geo-block in plain words', async () => {
    const { rest } = client(() => json({}, 451));
    expect((await errorOf(rest.symbol('XRPUSDT'))).message).toMatch(
      /not available from this location/,
    );
  });

  it('maps network failures to upstream_error', async () => {
    const { rest } = client(() => {
      throw new TypeError('fetch failed');
    });
    const error = await errorOf(rest.klines('XRPUSDT', '1m', null, 1));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toMatch(/unreachable/);
  });
});

describe('BinanceRest.symbol and assetNames', () => {
  it('reads tick size and assets from exchangeInfo', async () => {
    const { rest, calls } = client(() =>
      json({
        symbols: [
          {
            symbol: 'XRPUSDT',
            status: 'TRADING',
            baseAsset: 'XRP',
            quoteAsset: 'USDT',
            filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00010000' }],
          },
        ],
      }),
    );
    expect(await rest.symbol('XRPUSDT')).toMatchObject({ baseAsset: 'XRP', tickSize: 0.0001 });
    expect(calls[0]?.searchParams.get('symbol')).toBe('XRPUSDT');
  });

  it('reads display names from the asset list', async () => {
    const { rest } = client(() => json({ data: [{ assetCode: 'USDT', assetName: 'TetherUS' }] }));
    expect((await rest.assetNames()).get('USDT')).toBe('TetherUS');
  });
});
