import { parseResolution, type Resolution } from '@tradingnerd/core';
import { describe, expect, it, vi } from 'vitest';
import { BinanceExchange } from '../src/exchanges/binance/BinanceExchange.ts';
import { MarketError } from '../src/market/types.ts';

function mustParse(text: string): Resolution {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(`bad resolution ${text}`);
  return resolution;
}

const exchangeInfo = {
  symbols: [
    {
      symbol: 'XRPUSDT',
      status: 'TRADING',
      baseAsset: 'XRP',
      quoteAsset: 'USDT',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00010000' }],
    },
  ],
};
const assets = {
  data: [
    { assetCode: 'XRP', assetName: 'XRP' },
    { assetCode: 'USDT', assetName: 'TetherUS' },
  ],
};

function exchange(routes: { assets?: () => Response; symbol?: () => Response } = {}) {
  const calls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/assets') return routes.assets?.() ?? Response.json(assets);
    if (url.pathname === '/api/v3/exchangeInfo')
      return routes.symbol?.() ?? Response.json(exchangeInfo);
    if (url.pathname === '/api/v3/klines') return Response.json([]);
    return new Response('not found', { status: 404 });
  });
  const binance = new BinanceExchange({
    restUrl: 'https://binance.test',
    assetsUrl: 'https://binance.test/assets',
    streamUrl: 'ws://127.0.0.1:9/never-used',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { binance, calls };
}

describe('BinanceExchange.resolveSymbol', () => {
  it("describes the pair with Binance's own asset names, like TradingView", async () => {
    const { binance } = exchange();
    expect(await binance.resolveSymbol('XRPUSDT')).toEqual({
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
      resolutions: [
        '1S',
        '1',
        '3',
        '5',
        '15',
        '30',
        '60',
        '120',
        '240',
        '360',
        '480',
        '720',
        '1D',
        '3D',
        '1W',
        '1M',
      ],
    });
  });

  it('falls back to asset codes when the names endpoint fails', async () => {
    const { binance } = exchange({ assets: () => new Response('down', { status: 503 }) });
    expect((await binance.resolveSymbol('XRPUSDT')).description).toBe('XRP / USDT');
  });

  it('caches symbols', async () => {
    const { binance, calls } = exchange();
    await binance.resolveSymbol('XRPUSDT');
    await binance.resolveSymbol('XRPUSDT');
    expect(calls.filter((url) => url.pathname === '/api/v3/exchangeInfo')).toHaveLength(1);
  });

  it('does not cache failures', async () => {
    let fail = true;
    const { binance } = exchange({
      symbol: () =>
        fail
          ? Response.json({ code: -1121, msg: 'Invalid symbol.' }, { status: 400 })
          : Response.json(exchangeInfo),
    });
    await expect(binance.resolveSymbol('XRPUSDT')).rejects.toBeInstanceOf(MarketError);
    fail = false;
    expect((await binance.resolveSymbol('XRPUSDT')).ticker).toBe('XRPUSDT');
  });
});

describe('BinanceExchange intervals', () => {
  it('serves only native Binance intervals', () => {
    const { binance } = exchange();
    for (const text of ['1S', '1', '15', '60', '240', '1D', '3D', '1W', '1M']) {
      expect(binance.supportsResolution(mustParse(text))).toBe(true);
    }
    for (const text of ['2', '45', '180', '2D', '6M', '10T']) {
      expect(binance.supportsResolution(mustParse(text))).toBe(false);
    }
  });

  it('asks Binance for the matching kline interval', async () => {
    const { binance, calls } = exchange();
    await binance.fetchBars('XRPUSDT', mustParse('60'), null, 10);
    await binance.fetchBars('XRPUSDT', mustParse('1M'), null, 10);
    const intervals = calls
      .filter((url) => url.pathname === '/api/v3/klines')
      .map((url) => url.searchParams.get('interval'));
    expect(intervals).toEqual(['1h', '1M']);
  });
});
