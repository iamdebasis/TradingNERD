import { describe, expect, it } from 'vitest';
import {
  parseAggTrade,
  parseAggTradeRow,
  parseAssetNames,
  parseBookTicker,
  parseExchangeInfo,
  parseKlineEvent,
  parseKlineRow,
  parseTradeRow,
} from '../src/exchanges/binance/parse.ts';

// Shapes copied from real Binance responses captured on 2026-10-17/18.
const klineRow = [
  1792195200000,
  '1.31150000',
  '1.31260000',
  '1.28800000',
  '1.29090000',
  '22957267.40000000',
  1792281599999,
  '29894986.09',
  114040,
  '9854206.4',
  '12835798.61',
  '0',
];
const klineEvent = {
  e: 'kline',
  E: 1792326094343,
  s: 'XRPUSDT',
  k: {
    t: 1792326060000,
    T: 1792326119999,
    s: 'XRPUSDT',
    i: '1m',
    o: '1.29960000',
    c: '1.30020000',
    h: '1.30020000',
    l: '1.29960000',
    v: '31426.70000000',
    x: false,
  },
};
const aggTrade = {
  e: 'aggTrade',
  E: 1792326093943,
  s: 'XRPUSDT',
  a: 730153278,
  p: '1.30020000',
  q: '122.90000000',
  f: 1736985092,
  l: 1736985094,
  T: 1792326093943,
  m: false,
  M: true,
};
/** GET /api/v3/aggTrades row. */
const aggTradeRow = {
  a: 730153278,
  p: '1.30020000',
  q: '122.90000000',
  f: 1736985092,
  l: 1736985094,
  T: 1792326093943,
  m: false,
  M: true,
};
/** GET /api/v3/historicalTrades row. */
const tradeRow = {
  id: 1736985093,
  price: '1.30020000',
  qty: '40.00000000',
  quoteQty: '52.00800000',
  time: 1792326093943,
  isBuyerMaker: false,
  isBestMatch: true,
};
const bookTicker = {
  u: 26763969247,
  s: 'XRPUSDT',
  b: '1.30010000',
  B: '11650.0',
  a: '1.30020000',
  A: '14267.0',
};

describe('Binance parsers', () => {
  it('parses a REST kline row', () => {
    expect(parseKlineRow(klineRow)).toEqual({
      time: 1792195200,
      open: 1.3115,
      high: 1.3126,
      low: 1.288,
      close: 1.2909,
      volume: 22957267.4,
    });
  });

  it('parses a kline stream event', () => {
    expect(parseKlineEvent(klineEvent)).toEqual({
      eventTime: 1792326094343,
      bar: {
        time: 1792326060,
        open: 1.2996,
        high: 1.3002,
        low: 1.2996,
        close: 1.3002,
        volume: 31426.7,
      },
    });
  });

  it('parses an aggregate trade with its aggregate and trade ids', () => {
    expect(parseAggTrade(aggTrade)).toEqual({
      price: 1.3002,
      quantity: 122.9,
      time: 1792326093943,
      id: 730153278,
      firstId: 1736985092,
      lastId: 1736985094,
    });
  });

  it('still parses an aggregate trade without usable ids, just without them', () => {
    const { a: _a, ...withoutIds } = aggTrade;
    expect(parseAggTrade(withoutIds)).toEqual({
      price: 1.3002,
      quantity: 122.9,
      time: 1792326093943,
    });
    expect(parseAggTrade({ ...aggTrade, l: 1 })).toEqual({
      price: 1.3002,
      quantity: 122.9,
      time: 1792326093943,
    });
  });

  it('parses aggregate trade history rows', () => {
    expect(parseAggTradeRow(aggTradeRow)).toEqual({
      id: 730153278,
      firstId: 1736985092,
      lastId: 1736985094,
      price: 1.3002,
      quantity: 122.9,
      time: 1792326093943,
    });
    expect(parseAggTradeRow({ ...aggTradeRow, f: undefined })).toBeNull();
    expect(parseAggTradeRow({ ...aggTradeRow, p: 'x' })).toBeNull();
  });

  it('parses a single trade row for its id and time', () => {
    expect(parseTradeRow(tradeRow)).toEqual({ id: 1736985093, time: 1792326093943 });
    expect(parseTradeRow({ ...tradeRow, id: '1' })).toBeNull();
  });

  it('parses a book ticker', () => {
    expect(parseBookTicker(bookTicker)).toEqual({ bid: 1.3001, ask: 1.3002 });
  });

  it.each([
    ['a short kline row', () => parseKlineRow(klineRow.slice(0, 5))],
    ['a kline row with a bad price', () => parseKlineRow(['x', ...klineRow.slice(1)])],
    [
      'a kline row with a negative price',
      () => parseKlineRow([klineRow[0], '-1', ...klineRow.slice(2)]),
    ],
    ['a kline event of another type', () => parseKlineEvent({ ...klineEvent, e: 'trade' })],
    ['a kline event without k', () => parseKlineEvent({ e: 'kline', E: 1 })],
    ['a kline event with a string time', () => parseKlineEvent({ ...klineEvent, E: '1' })],
    ['a trade with a numeric price', () => parseAggTrade({ ...aggTrade, p: 1.3 })],
    ['a trade with an empty quantity', () => parseAggTrade({ ...aggTrade, q: '' })],
    ['a book ticker without an ask', () => parseBookTicker({ ...bookTicker, a: undefined })],
  ])('rejects %s', (_label, parse) => {
    expect(parse()).toBeNull();
  });

  it('parses exchangeInfo for one symbol', () => {
    const body = {
      symbols: [
        {
          symbol: 'XRPUSDT',
          status: 'TRADING',
          baseAsset: 'XRP',
          quoteAsset: 'USDT',
          filters: [
            {
              filterType: 'PRICE_FILTER',
              minPrice: '0.0001',
              maxPrice: '10000',
              tickSize: '0.00010000',
            },
            { filterType: 'LOT_SIZE', stepSize: '0.1' },
          ],
        },
      ],
    };
    expect(parseExchangeInfo(body)).toEqual({
      symbol: 'XRPUSDT',
      status: 'TRADING',
      baseAsset: 'XRP',
      quoteAsset: 'USDT',
      tickSize: 0.0001,
    });
  });

  it('rejects exchangeInfo without a usable price filter', () => {
    const body = {
      symbols: [{ symbol: 'X', status: 'TRADING', baseAsset: 'A', quoteAsset: 'B', filters: [] }],
    };
    expect(parseExchangeInfo(body)).toBeNull();
    expect(parseExchangeInfo({ symbols: [] })).toBeNull();
  });

  it('maps asset codes to display names and skips junk', () => {
    const body = {
      code: '000000',
      data: [
        { assetCode: 'USDT', assetName: 'TetherUS' },
        { assetCode: 'XRP', assetName: 'XRP' },
        { assetCode: 'BAD' },
        { assetCode: 'EMPTY', assetName: '  ' },
        'junk',
      ],
    };
    expect([...parseAssetNames(body)]).toEqual([
      ['USDT', 'TetherUS'],
      ['XRP', 'XRP'],
    ]);
    expect(parseAssetNames(null).size).toBe(0);
  });
});
