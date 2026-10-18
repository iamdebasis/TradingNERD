import { describe, expect, it } from 'vitest';
import { parseSymbolId, precisionOf } from './market.ts';

describe('parseSymbolId', () => {
  it('parses TradingView-style ids', () => {
    expect(parseSymbolId('BINANCE:XRPUSDT')).toEqual({ exchange: 'BINANCE', ticker: 'XRPUSDT' });
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parseSymbolId(' binance:xrpusdt ')).toEqual({ exchange: 'BINANCE', ticker: 'XRPUSDT' });
  });

  it.each(['XRPUSDT', 'BINANCE:', ':XRPUSDT', 'BINANCE:XRP/USDT', 'BIN ANCE:XRP', 'A:B:C', ''])(
    'rejects %j',
    (id) => {
      expect(parseSymbolId(id)).toBeNull();
    },
  );
});

describe('precisionOf', () => {
  it.each([
    [0.0001, 4],
    [0.01, 2],
    [1, 0],
    [0.5, 1],
    [0.25, 2],
    [1e-8, 8],
    [0.00001, 5],
    [10, 0],
  ])('tick size %d → %d decimals', (tick, decimals) => {
    expect(precisionOf(tick)).toBe(decimals);
  });

  it('falls back to 2 decimals for nonsense', () => {
    expect(precisionOf(0)).toBe(2);
    expect(precisionOf(-1)).toBe(2);
    expect(precisionOf(Number.NaN)).toBe(2);
  });
});
