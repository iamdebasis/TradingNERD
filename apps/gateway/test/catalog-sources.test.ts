import { describe, expect, it } from 'vitest';
import { BinanceExchange } from '../src/exchanges/binance/BinanceExchange.ts';
import { parseMiniTickers, parseTradingSymbols } from '../src/exchanges/binance/parse.ts';
import { BybitCatalog, parseBybitPairs } from '../src/exchanges/bybit/catalog.ts';
import { CoinbaseCatalog, parseCoinbaseCatalog } from '../src/exchanges/coinbase/catalog.ts';
import { KrakenCatalog, parseKrakenPairs } from '../src/exchanges/kraken/catalog.ts';
import { OkxCatalog, parseOkxPairs } from '../src/exchanges/okx/catalog.ts';
import { MarketError } from '../src/market/types.ts';
import { fixture, fixtureFetch } from './helpers/FakeCatalog.ts';

/**
 * Each exchange's public pair list, parsed from responses recorded on 2026-10-19 (trimmed to a
 * few pairs, plus ones that must be left out: halted, pre-launch, suspended, delisted, aliases).
 */
const tickers = (pairs: { ticker: string }[]) => pairs.map((pair) => pair.ticker).sort();

describe('Binance pair list', () => {
  it('keeps the spot pairs that are trading, with 24 h figures and asset names', async () => {
    const listed = parseTradingSymbols(fixture('binance-exchangeInfo')) ?? [];
    expect(listed.map((listing) => listing.symbol).sort()).toEqual(
      ['BTCUSDT', 'EURUSDT', 'USDTTRY', 'XRPBTC', 'XRPTRY', 'XRPUSDT'], // not the halted SNTUSDT
    );
    expect(parseMiniTickers(fixture('binance-ticker24hr'))?.get('XRPUSDT')).toEqual({
      last: 1.314,
      quoteVolume: 96533149.14009,
    });

    const { fetch, requested } = fixtureFetch({
      '/api/v3/exchangeInfo': fixture('binance-exchangeInfo'),
      '/api/v3/ticker/24hr': fixture('binance-ticker24hr'),
      'get-all-asset': {
        data: [
          { assetCode: 'USDT', assetName: 'TetherUS' },
          { assetCode: 'TRY', assetName: 'Turkish Lira' },
        ],
      },
    });
    const binance = new BinanceExchange({ fetch });
    try {
      const catalog = await binance.fetchCatalog();
      expect(catalog.pairs).toHaveLength(6);
      expect(catalog.pairs.find((pair) => pair.ticker === 'XRPTRY')).toEqual({
        ticker: 'XRPTRY',
        base: 'XRP',
        quote: 'TRY',
        quoteVolume: 157802274.221,
        last: 64.97,
      });
      expect(catalog.names).toEqual({ USDT: 'TetherUS', TRY: 'Turkish Lira' });
      expect(requested.some((url) => url.includes('symbolStatus=TRADING'))).toBe(true);

      // The full list answers symbol lookups, so a picked pair goes live a round trip sooner.
      const before = requested.length;
      expect(await binance.resolveSymbol('XRPTRY')).toMatchObject({
        id: 'BINANCE:XRPTRY',
        description: 'XRP / Turkish Lira',
        tickSize: 0.01,
        pricePrecision: 2,
      });
      expect(requested.slice(before)).toEqual([]);
      // One it doesn't list (halted, delisted, unknown) is still asked about.
      await binance.resolveSymbol('SNTUSDT').catch(() => {});
      expect(requested.at(-1)).toContain('exchangeInfo?symbol=SNTUSDT');
    } finally {
      await binance.close();
    }
  });
});

describe('Bybit pair list', () => {
  it('keeps trading pairs with their 24 h turnover in the quote asset', async () => {
    const pairs = parseBybitPairs(fixture('bybit-instruments'), fixture('bybit-tickers'));
    expect(tickers(pairs)).toEqual(['BTCUSDT', 'XRPBTC', 'XRPEUR', 'XRPUSDT']); // not PreLaunch
    expect(pairs.find((pair) => pair.ticker === 'XRPUSDT')).toEqual({
      ticker: 'XRPUSDT',
      base: 'XRP',
      quote: 'USDT',
      quoteVolume: 20567948.699984,
      last: 1.3139,
    });
    const { fetch, requested } = fixtureFetch({
      'instruments-info': fixture('bybit-instruments'),
      '/v5/market/tickers': fixture('bybit-tickers'),
    });
    expect((await new BybitCatalog({ fetch }).fetchCatalog()).pairs).toHaveLength(4);
    expect(requested.every((url) => url.includes('category=spot'))).toBe(true);
  });

  it('refuses an error answer', () => {
    expect(() => parseBybitPairs({ retCode: 10001, result: {} }, fixture('bybit-tickers'))).toThrow(
      MarketError,
    );
  });
});

describe('OKX pair list', () => {
  it("writes OKX's XRP-USDT as XRPUSDT, keeping live pairs only", async () => {
    const pairs = parseOkxPairs(fixture('okx-instruments'), fixture('okx-tickers'));
    expect(tickers(pairs)).toEqual(['BTCUSDT', 'USDTEUR', 'XRPEUR', 'XRPUSDT']); // not suspended
    expect(pairs.find((pair) => pair.ticker === 'XRPEUR')).toEqual({
      ticker: 'XRPEUR',
      base: 'XRP',
      quote: 'EUR',
      quoteVolume: 618844.47799818,
      last: 1.1692,
    });
    const { fetch } = fixtureFetch({
      '/public/instruments': fixture('okx-instruments'),
      '/market/tickers': fixture('okx-tickers'),
    });
    expect((await new OkxCatalog({ fetch }).fetchCatalog()).pairs).toHaveLength(4);
  });

  it('refuses an error answer', () => {
    expect(() => parseOkxPairs({ code: '50011', data: [] }, fixture('okx-tickers'))).toThrow(
      MarketError,
    );
  });
});

describe('Coinbase pair list', () => {
  it('lists each book once, with the asset names Coinbase publishes', async () => {
    const { pairs, names } = parseCoinbaseCatalog(fixture('coinbase-products'));
    // XRP-USDC is XRP-USD's own book (an alias), and DAI-USD is delisted.
    expect(tickers(pairs)).toEqual(['BTCUSD', 'USDTUSD', 'XRPEUR', 'XRPUSD']);
    expect(pairs.find((pair) => pair.ticker === 'XRPUSD')).toEqual({
      ticker: 'XRPUSD',
      base: 'XRP',
      quote: 'USD',
      quoteVolume: 66692210.34,
      last: 1.3125,
    });
    expect(names).toEqual({
      BTC: 'Bitcoin',
      USD: 'US Dollar',
      XRP: 'XRP',
      USDT: 'Tether',
      EUR: 'Euro',
    });
    const { fetch, requested } = fixtureFetch({ '/market/products': fixture('coinbase-products') });
    expect((await new CoinbaseCatalog({ fetch }).fetchCatalog()).pairs).toHaveLength(4);
    expect(requested[0]).toContain('product_type=SPOT');
  });

  it('refuses an unexpected answer', () => {
    expect(() => parseCoinbaseCatalog({ error: 'nope' })).toThrow(MarketError);
  });
});

describe('Kraken pair list', () => {
  it("uses Kraken's own short names, with its XBT and XDG codes kept as listed", async () => {
    const pairs = parseKrakenPairs(fixture('kraken-assetpairs'), fixture('kraken-ticker'));
    // ACAEUR is cancel-only.
    expect(tickers(pairs)).toEqual(['EURUSD', 'USDTUSD', 'XBTUSD', 'XDGUSD', 'XRPUSD', 'XRPUSDT']);
    const xbt = pairs.find((pair) => pair.ticker === 'XBTUSD');
    expect(xbt).toMatchObject({ base: 'XBT', quote: 'USD', last: 82706.7 });
    // Kraken counts volume in the base asset: 1414.83 BTC at the last price.
    expect(xbt?.quoteVolume).toBeCloseTo(1414.83206342 * 82706.7, 2);
    const { fetch } = fixtureFetch({
      '/0/public/AssetPairs': fixture('kraken-assetpairs'),
      '/0/public/Ticker': fixture('kraken-ticker'),
    });
    expect((await new KrakenCatalog({ fetch }).fetchCatalog()).pairs).toHaveLength(6);
  });

  it('refuses an error answer', () => {
    expect(() =>
      parseKrakenPairs({ error: ['EGeneral:Too many requests'] }, fixture('kraken-ticker')),
    ).toThrow(MarketError);
  });
});

describe('exchange outages', () => {
  it('names the exchange, and tells rate limiting apart', async () => {
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(new KrakenCatalog({ fetch: down }).fetchCatalog()).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Kraken answered HTTP 503',
    });
    const busy = (async () => new Response('', { status: 429 })) as typeof fetch;
    await expect(new OkxCatalog({ fetch: busy }).fetchCatalog()).rejects.toMatchObject({
      code: 'rate_limited',
    });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(new BybitCatalog({ fetch: offline }).fetchCatalog()).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Bybit is unreachable (fetch failed)',
    });
  });
});
