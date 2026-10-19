import { describe, expect, it } from 'vitest';
import {
  type CatalogEntry,
  compactQuery,
  descriptionMatches,
  parseExchangeList,
  parseSymbolSearchResponse,
  searchCatalog,
  splitExchangePrefix,
  tickerMatch,
} from './search.ts';

const entry = (
  exchange: string,
  ticker: string,
  base: string,
  quote: string,
  description: string,
  volumeUsd: number,
  live = exchange === 'BINANCE',
): CatalogEntry => ({ exchange, ticker, base, quote, description, volumeUsd, live });

const CATALOG: CatalogEntry[] = [
  entry('BYBIT', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 20e6),
  entry('BINANCE', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 150e6),
  entry('OKX', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 22e6),
  entry('COINBASE', 'XRPUSD', 'XRP', 'USD', 'XRP / US Dollar', 66e6),
  entry('KRAKEN', 'XRPUSD', 'XRP', 'USD', 'XRP / US Dollar', 20e6),
  entry('BINANCE', 'XRPEUR', 'XRP', 'EUR', 'XRP / Euro', 5e6),
  entry('BINANCE', 'XRPBTC', 'XRP', 'BTC', 'XRP / Bitcoin', 3e6),
  entry('BINANCE', 'BTCUSDT', 'BTC', 'USDT', 'Bitcoin / TetherUS', 900e6),
  entry('KRAKEN', 'XBTUSD', 'BTC', 'USD', 'Bitcoin / US Dollar', 200e6),
  entry('BINANCE', 'ETHBTC', 'ETH', 'BTC', 'Ethereum / Bitcoin', 40e6),
  entry('BINANCE', 'LDOUSDT', 'LDO', 'USDT', 'Lido DAO / TetherUS', 9e6),
];

const tickers = (query: string, options = {}) =>
  searchCatalog(CATALOG, { query, ...options }).matches.map((match) => match.ticker);

describe('symbol search ranking', () => {
  it('puts an exact ticker first, then ticker prefixes by how much they trade', () => {
    expect(tickers('XRPUSDT')).toEqual(['XRPUSDT']);
    // XRPUSDT trades 192 M across its exchanges, XRPUSD 86 M.
    expect(tickers('xrp')).toEqual(['XRPUSDT', 'XRPUSD', 'XRPEUR', 'XRPBTC']);
  });

  it('ranks prefix, then base asset, then description, then anywhere in the ticker', () => {
    // BTCUSDT starts with BTC; Kraken's XBTUSD is BTC underneath; ETHBTC and XRPBTC only
    // contain it ("Bitcoin" doesn't start with "BTC"), so the more traded one leads.
    expect(tickers('BTC')).toEqual(['BTCUSDT', 'XBTUSD', 'ETHBTC', 'XRPBTC']);
  });

  it('finds words of the description: names, and the start of them', () => {
    expect(tickers('bitcoin')).toEqual(['BTCUSDT', 'XBTUSD', 'ETHBTC', 'XRPBTC']);
    expect(tickers('lido dao')).toEqual(['LDOUSDT']);
    expect(tickers('tether')).toEqual(['BTCUSDT', 'XRPUSDT', 'LDOUSDT']);
  });

  it('ignores the separators people type between assets', () => {
    expect(tickers('xrp/usdt')).toEqual(['XRPUSDT']);
    expect(tickers(' XRP-usd ')[0]).toBe('XRPUSD');
    expect(compactQuery('xrp / usdt')).toBe('XRPUSDT');
  });

  it('shows the most traded pairs when nothing is typed', () => {
    expect(tickers('')).toEqual([
      'BTCUSDT',
      'XBTUSD',
      'XRPUSDT',
      'XRPUSD',
      'ETHBTC',
      'LDOUSDT',
      'XRPEUR',
      'XRPBTC',
    ]);
  });

  it('finds nothing for a query nothing matches', () => {
    expect(tickers('NOPE')).toEqual([]);
  });
});

describe('one match per pair, with every exchange that lists it', () => {
  it('lists exchanges with live data first, then by how much they trade', () => {
    const [xrp] = searchCatalog(CATALOG, { query: 'XRPUSDT' }).matches;
    expect(xrp).toEqual({
      ticker: 'XRPUSDT',
      base: 'XRP',
      quote: 'USDT',
      description: 'XRP / TetherUS',
      type: 'spot',
      listings: [
        { id: 'BINANCE:XRPUSDT', exchange: 'BINANCE', live: true },
        { id: 'OKX:XRPUSDT', exchange: 'OKX', live: false },
        { id: 'BYBIT:XRPUSDT', exchange: 'BYBIT', live: false },
      ],
    });
  });

  it('keeps only the chosen source, from the filter or an "EXCHANGE:" prefix', () => {
    const okx = searchCatalog(CATALOG, { query: 'XRP', exchange: 'OKX' }).matches;
    expect(okx.map((match) => match.listings.map((listing) => listing.id))).toEqual([
      ['OKX:XRPUSDT'],
    ]);
    expect(tickers('kraken:xbt')).toEqual(['XBTUSD']);
    expect(tickers('KRAKEN:')).toEqual(['XBTUSD', 'XRPUSD']);
    // Not an exchange: searched as typed.
    expect(tickers('FOO:XRP')).toEqual([]);
  });

  it('pages through the matches', () => {
    const first = searchCatalog(CATALOG, { query: 'XRP', limit: 3 });
    expect(first.matches.map((match) => match.ticker)).toEqual(['XRPUSDT', 'XRPUSD', 'XRPEUR']);
    expect(first.hasMore).toBe(true);
    const next = searchCatalog(CATALOG, { query: 'XRP', offset: 3, limit: 3 });
    expect(next.matches.map((match) => match.ticker)).toEqual(['XRPBTC']);
    expect(next.hasMore).toBe(false);
  });

  it('splits an exchange prefix only when it names an exchange', () => {
    const known = new Set(['BINANCE']);
    expect(splitExchangePrefix('binance:xrp', known)).toEqual({ exchange: 'BINANCE', text: 'xrp' });
    expect(splitExchangePrefix('NOPE:xrp', known)).toEqual({ exchange: null, text: 'NOPE:xrp' });
  });
});

describe('highlighting what matched', () => {
  it('marks the typed text in the ticker', () => {
    expect(tickerMatch('XRPUSDT', 'xrp')).toEqual([[0, 3]]);
    expect(tickerMatch('ETHBTC', 'btc')).toEqual([[3, 6]]);
    expect(tickerMatch('XRPUSDT', 'binance:xrp/u')).toEqual([[0, 4]]);
    expect(tickerMatch('XRPUSDT', '')).toEqual([]);
    expect(tickerMatch('XRPUSDT', 'ETH')).toEqual([]);
  });

  it('marks the start of each description word the query begins', () => {
    // As in the reference: "XRP / TetherUS", "Market Cap XRPC, $".
    expect(descriptionMatches('XRP / TetherUS', 'XRP')).toEqual([[0, 3]]);
    expect(descriptionMatches('Market Cap XRPC, $', 'xrp')).toEqual([[11, 14]]);
    expect(descriptionMatches('Lido DAO / TetherUS', 'lido te')).toEqual([
      [0, 4],
      [11, 13],
    ]);
    expect(descriptionMatches('XRP / Euro', '')).toEqual([]);
  });
});

describe('parsing search responses', () => {
  it('accepts well-formed results and exchange lists', () => {
    const response = searchCatalog(CATALOG, { query: 'XRP', limit: 2 });
    expect(parseSymbolSearchResponse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    const exchanges = { exchanges: [{ id: 'BINANCE', name: 'Binance', live: true }] };
    expect(parseExchangeList(exchanges)).toEqual(exchanges);
  });

  it('rejects malformed ones', () => {
    expect(parseSymbolSearchResponse(null)).toBeNull();
    expect(parseSymbolSearchResponse({ matches: [{ ticker: 'X' }], hasMore: false })).toBeNull();
    expect(
      parseSymbolSearchResponse({
        matches: [
          {
            ticker: 'XRPUSDT',
            base: 'XRP',
            quote: 'USDT',
            description: '',
            type: 'spot',
            listings: [],
          },
        ],
        hasMore: false,
      }),
    ).toBeNull();
    expect(parseExchangeList({ exchanges: [{ id: 'BINANCE', live: true }] })).toBeNull();
  });
});
