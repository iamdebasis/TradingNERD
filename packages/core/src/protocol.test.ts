import { describe, expect, it } from 'vitest';
import {
  parseApiError,
  parseBar,
  parseBarsResponse,
  parseClientMessage,
  parseServerMessage,
  parseSymbolInfo,
} from './protocol.ts';
import { NYSE_2026 } from './testing.ts';

const bar = {
  time: 1_792_281_600,
  open: 1.3115,
  high: 1.3126,
  low: 1.288,
  close: 1.2909,
  volume: 1,
};
const json = (value: unknown) => JSON.stringify(value);

describe('parseBar', () => {
  it('accepts a bar with six finite numbers', () => {
    expect(parseBar(bar)).toEqual(bar);
  });

  it('drops extra fields', () => {
    expect(parseBar({ ...bar, color: 'red' })).toEqual(bar);
  });

  it("keeps a tick bar's start time", () => {
    expect(parseBar({ ...bar, start: 1_792_341_875_123 })).toEqual({
      ...bar,
      start: 1_792_341_875_123,
    });
  });

  it.each([
    ['null', null],
    ['a missing field', { ...bar, volume: undefined }],
    ['a start time that is not a number', { ...bar, start: 'soon' }],
    ['a string price', { ...bar, close: '1.29' }],
    ['NaN', { ...bar, high: Number.NaN }],
    ['Infinity', { ...bar, low: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, value) => {
    expect(parseBar(value)).toBeNull();
  });
});

describe('parseServerMessage', () => {
  it.each([
    ['hello', { type: 'hello', protocolVersion: 2, serverTime: 123 }],
    ['pong', { type: 'pong', t: 42 }],
    ['bar', { type: 'bar', id: 's1', bar, historical: false }],
    ['historical bar', { type: 'bar', id: 's1', bar, historical: true }],
    ['book', { type: 'book', id: 's2', bid: 1.2955, ask: 1.2956 }],
    ['quote', { type: 'quote', id: 's3', last: 1.2955, prevClose: 1.3115 }],
    ['quote of a symbol listed today', { type: 'quote', id: 's3', last: 1.2955, prevClose: null }],
    ['status live', { type: 'status', id: 's1', state: 'live' }],
    ['status reconnecting', { type: 'status', id: 's1', state: 'reconnecting' }],
    ['error', { type: 'error', id: 's1', code: 'unknown_symbol', message: 'No such symbol' }],
    ['error without id', { type: 'error', id: null, code: 'bad_request', message: 'x' }],
  ])('accepts %s', (_label, message) => {
    expect(parseServerMessage(json(message))).toEqual(message);
  });

  it('drops extra fields instead of passing them through', () => {
    expect(parseServerMessage(json({ type: 'pong', t: 1, extra: 'x' }))).toEqual({
      type: 'pong',
      t: 1,
    });
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a JSON array', '[1,2]'],
    ['null', 'null'],
    ['an unknown type', json({ type: 'quotes' })],
    ['a quote without a last price', json({ type: 'quote', id: 's3', prevClose: 1 })],
    ['a quote with a string close', json({ type: 'quote', id: 's3', last: 1, prevClose: '1' })],
    ['a hello with a string version', json({ type: 'hello', protocolVersion: '2', serverTime: 1 })],
    ['a bar with a bad bar', json({ type: 'bar', id: 's1', bar: { time: 1 }, historical: false })],
    ['a bar without historical', json({ type: 'bar', id: 's1', bar })],
    ['a bar with an empty id', json({ type: 'bar', id: '', bar, historical: false })],
    ['a bar with a huge id', json({ type: 'bar', id: 'x'.repeat(65), bar, historical: false })],
    ['a book with a missing ask', json({ type: 'book', id: 's2', bid: 1 })],
    ['an unknown status', json({ type: 'status', id: 's1', state: 'sleepy' })],
    ['an unknown error code', json({ type: 'error', id: null, code: 'oops', message: 'x' })],
  ])('rejects %s', (_label, raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });
});

describe('parseClientMessage', () => {
  it.each([
    ['ping', { type: 'ping', t: 7 }],
    [
      'bars subscription',
      { type: 'subscribe', id: 's1', channel: 'bars', symbol: 'BINANCE:XRPUSDT', resolution: '1D' },
    ],
    [
      'book subscription',
      { type: 'subscribe', id: 's2', channel: 'book', symbol: 'BINANCE:XRPUSDT' },
    ],
    [
      'quotes subscription',
      { type: 'subscribe', id: 's3', channel: 'quotes', symbol: 'BINANCE:LINKUSDT' },
    ],
    ['unsubscribe', { type: 'unsubscribe', id: 's1' }],
  ])('accepts %s', (_label, message) => {
    expect(parseClientMessage(json(message))).toEqual(message);
  });

  it.each([
    ['invalid JSON', 'ping'],
    ['a ping without t', json({ type: 'ping' })],
    ['an unknown channel', json({ type: 'subscribe', id: 's1', channel: 'news', symbol: 'X:Y' })],
    [
      'bars without resolution',
      json({ type: 'subscribe', id: 's1', channel: 'bars', symbol: 'X:Y' }),
    ],
    [
      'a too-long resolution',
      json({
        type: 'subscribe',
        id: 's1',
        channel: 'bars',
        symbol: 'X:Y',
        resolution: 'x'.repeat(17),
      }),
    ],
    ['a subscribe without id', json({ type: 'subscribe', channel: 'book', symbol: 'X:Y' })],
    ['an unsubscribe without id', json({ type: 'unsubscribe' })],
    ['a server-only type', json({ type: 'hello', protocolVersion: 2, serverTime: 1 })],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe('parseBarsResponse', () => {
  const later = { ...bar, time: bar.time + 86_400 };

  it('accepts ascending bars', () => {
    expect(parseBarsResponse({ bars: [bar, later], hasMore: true })).toEqual({
      bars: [bar, later],
      hasMore: true,
    });
  });

  it.each([
    ['bars out of order', { bars: [later, bar], hasMore: true }],
    ['a duplicate bar', { bars: [bar, bar], hasMore: false }],
    ['a malformed bar', { bars: [{ time: 1 }], hasMore: false }],
    ['a missing hasMore', { bars: [bar] }],
    ['no bars array', { hasMore: false }],
  ])('rejects %s', (_label, value) => {
    expect(parseBarsResponse(value)).toBeNull();
  });
});

describe('parseSymbolInfo', () => {
  const info = {
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
    resolutions: ['1', '1D'],
    timezone: 'Etc/UTC',
    delayMs: 0,
    hasBook: true,
  };
  const stock = {
    ...info,
    id: 'NYSE:JPM/PD',
    exchange: 'NYSE',
    exchangeName: 'NYSE',
    ticker: 'JPM/PD',
    base: 'JPM',
    quote: 'USD',
    description: 'JPMorgan Chase & Co. Depositary Shares, Series DD',
    type: 'preferred',
    tickSize: 0.01,
    pricePrecision: 2,
    timezone: 'America/New_York',
    delayMs: 900_000,
    hasBook: false,
    schedule: NYSE_2026,
  };

  it('accepts complete symbol info', () => {
    expect(parseSymbolInfo(info)).toEqual(info);
  });

  it("accepts a stock's, with its delay and trading calendar", () => {
    expect(parseSymbolInfo(JSON.parse(JSON.stringify(stock)))).toEqual(stock);
  });

  it.each([
    ['a missing description', { ...info, description: undefined }],
    ['a zero tick size', { ...info, tickSize: 0 }],
    ['a fractional precision', { ...info, pricePrecision: 1.5 }],
    ['an unknown type', { ...info, type: 'perp' }],
    ['non-string resolutions', { ...info, resolutions: [1] }],
    ['no time zone', { ...info, timezone: undefined }],
    ['a negative delay', { ...info, delayMs: -1 }],
    ['no book flag', { ...info, hasBook: undefined }],
    ['a broken schedule', { ...stock, schedule: { ...NYSE_2026, regular: [960, 570] } }],
  ])('rejects %s', (_label, value) => {
    expect(parseSymbolInfo(value)).toBeNull();
  });
});

describe('parseApiError', () => {
  it('accepts a known error body', () => {
    expect(parseApiError({ error: 'unknown_symbol', message: 'Not listed' })).toEqual({
      error: 'unknown_symbol',
      message: 'Not listed',
    });
  });

  it('rejects anything else', () => {
    expect(parseApiError({ error: 'forbidden_origin' })).toBeNull();
    expect(parseApiError('oops')).toBeNull();
  });
});
