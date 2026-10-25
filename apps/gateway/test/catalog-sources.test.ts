import { describe, expect, it } from 'vitest';
import { BinanceExchange } from '../src/exchanges/binance/BinanceExchange.ts';
import { parseMiniTickers, parseTradingSymbols } from '../src/exchanges/binance/parse.ts';
import { BitstampExchange } from '../src/exchanges/bitstamp/BitstampExchange.ts';
import { parseBitstampCatalog } from '../src/exchanges/bitstamp/parse.ts';
import { BybitExchange } from '../src/exchanges/bybit/BybitExchange.ts';
import { parseBybitPairs } from '../src/exchanges/bybit/parse.ts';
import { CoinbaseExchange } from '../src/exchanges/coinbase/CoinbaseExchange.ts';
import { parseCoinbaseCatalog } from '../src/exchanges/coinbase/parse.ts';
import { KrakenExchange } from '../src/exchanges/kraken/KrakenExchange.ts';
import { parseKrakenPairs } from '../src/exchanges/kraken/parse.ts';
import { OkxExchange } from '../src/exchanges/okx/OkxExchange.ts';
import { parseOkxPairs } from '../src/exchanges/okx/parse.ts';
import { MarketError } from '../src/market/types.ts';
import { fixture, fixtureFetch } from './helpers/FakeCatalog.ts';

/**
 * Each exchange's public pair list, parsed from responses recorded on 2026-10-19 (Bitstamp's on
 * 2026-10-25), trimmed to a few pairs, plus ones that must be left out: halted, pre-launch,
 * suspended, delisted, aliases, perpetuals.
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
    expect((await new BybitExchange({ fetch }).fetchCatalog()).pairs).toHaveLength(4);
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
    expect((await new OkxExchange({ fetch }).fetchCatalog()).pairs).toHaveLength(4);
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
    expect((await new CoinbaseExchange({ fetch }).fetchCatalog()).pairs).toHaveLength(4);
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
    expect((await new KrakenExchange({ fetch }).fetchCatalog()).pairs).toHaveLength(6);
  });

  it('refuses an error answer', () => {
    expect(() =>
      parseKrakenPairs({ error: ['EGeneral:Too many requests'] }, fixture('kraken-ticker')),
    ).toThrow(MarketError);
  });
});

describe('Bitstamp pair list', () => {
  it("keeps the spot pairs trading, with the asset names Bitstamp's descriptions give", async () => {
    const { pairs, names } = parseBitstampCatalog(
      fixture('bitstamp-markets'),
      fixture('bitstamp-ticker'),
    );
    // ZK/EUR's trading is disabled, and BTC/USD-PERP is a perpetual.
    expect(tickers(pairs)).toEqual(['BTCUSD', 'EURUSD', 'USDTUSD', 'XRPBTC', 'XRPEUR', 'XRPUSD']);
    const xrp = pairs.find((pair) => pair.ticker === 'XRPUSD');
    expect(xrp).toMatchObject({ base: 'XRP', quote: 'USD', last: 1.30055 });
    // Bitstamp counts volume in the base asset: 9,344,208 XRP at the last price.
    expect(xrp?.quoteVolume).toBeCloseTo(9344208.38216504 * 1.30055, 2);
    expect(names).toEqual({
      EUR: 'Euro',
      USD: 'U.S. dollar',
      BTC: 'Bitcoin',
      XRP: 'XRP',
      USDT: 'Tether',
    });

    const { fetch, requested } = fixtureFetch({
      '/api/v2/markets/': fixture('bitstamp-markets'),
      '/api/v2/ticker/': fixture('bitstamp-ticker'),
    });
    const bitstamp = new BitstampExchange({ fetch });
    try {
      expect((await bitstamp.fetchCatalog()).pairs).toHaveLength(6);
      // The list answers symbol lookups too, without asking again; described as Bitstamp does.
      const before = requested.length;
      expect(await bitstamp.resolveSymbol('XRPUSD')).toMatchObject({
        id: 'BITSTAMP:XRPUSD',
        exchangeName: 'Bitstamp',
        description: 'XRP / U.S. dollar',
        tickSize: 0.00001,
        pricePrecision: 5,
      });
      expect(requested).toHaveLength(before);
    } finally {
      await bitstamp.close();
    }
  });

  it('refuses an unexpected answer', () => {
    expect(() => parseBitstampCatalog({ error: 'nope' }, [])).toThrow(MarketError);
    expect(() => parseBitstampCatalog([], { error: 'nope' })).toThrow(MarketError);
  });
});

describe('exchange outages', () => {
  it('names the exchange, and tells rate limiting apart', async () => {
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    await expect(new KrakenExchange({ fetch: down }).fetchCatalog()).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Kraken answered HTTP 503',
    });
    const busy = (async () => new Response('', { status: 429 })) as typeof fetch;
    await expect(new OkxExchange({ fetch: busy }).fetchCatalog()).rejects.toMatchObject({
      code: 'rate_limited',
    });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(new BybitExchange({ fetch: offline }).fetchCatalog()).rejects.toMatchObject({
      code: 'upstream_error',
      message: 'Bybit is unreachable (fetch failed)',
    });
  });
});
