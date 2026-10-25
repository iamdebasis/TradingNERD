import { describe, expect, it } from 'vitest';
import {
  evaluateFormula,
  isChartable,
  isComplete,
  MAX_FORMULA_LENGTH,
  parseFormula,
  replaceSymbols,
  symbolName,
} from './formula.ts';

const values: Record<string, number> = {
  'CRYPTOCAP:TOTAL2': 1_041e9,
  'BITSTAMP:XRPUSD': 1.27,
  'CRYPTOCAP:BTC.D': 60.73,
  'CRYPTOCAP:ETH.D': 10.67,
  'A:X': 10,
  'B:Y': 4,
  'C:Z': 2,
};
const worth = (formula: string) => {
  const parsed = parseFormula(formula);
  if (!parsed) throw new Error(`not a formula: ${formula}`);
  return evaluateFormula(parsed.root, (symbol) => values[symbol] ?? Number.NaN);
};

describe('reading formulas', () => {
  it("keeps TradingView's saved text and shows the tickers alone", () => {
    const formula = parseFormula('CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD');
    expect(formula?.text).toBe('CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD');
    expect(formula?.name).toBe('TOTAL2/XRPUSD');
    expect(formula?.symbols).toEqual(['CRYPTOCAP:TOTAL2', 'BITSTAMP:XRPUSD']);
  });

  it("reads the user's own formulas from their TradingView list", () => {
    expect(parseFormula('CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-EURONEXT:USDC')?.name).toBe(
      'TOTAL3-USDT-USDC',
    );
    const four = parseFormula('CRYPTOCAP:BTC.D+CRYPTOCAP:ETH.D+CRYPTOCAP:USDT.D+CRYPTOCAP:USDC.D');
    expect(four?.symbols).toHaveLength(4);
    expect(four?.name).toBe('BTC.D+ETH.D+USDT.D+USDC.D');
  });

  it('takes spaces, lower case and numbers, and writes them away', () => {
    const formula = parseFormula(' binance:btcusdt / 2 ');
    expect(formula?.text).toBe('BINANCE:BTCUSDT/2');
    expect(parseFormula('1 / TVC:DXY')?.text).toBe('1/TVC:DXY');
    expect(parseFormula('A:X*1.50')?.text).toBe('A:X*1.5');
  });

  it('follows arithmetic: × and ÷ before + and −, left to right, brackets first', () => {
    expect(worth('A:X+B:Y*C:Z')).toBe(18);
    expect(worth('(A:X+B:Y)*C:Z')).toBe(28);
    expect(worth('A:X-B:Y-C:Z')).toBe(4);
    expect(worth('A:X/B:Y/C:Z')).toBe(1.25);
    expect(worth('A:X-(B:Y-C:Z)')).toBe(8);
    expect(worth('-A:X+B:Y')).toBe(-6);
    expect(worth('A:X*-C:Z')).toBe(-20);
    expect(worth('CRYPTOCAP:BTC.D+CRYPTOCAP:ETH.D')).toBeCloseTo(71.4, 9);
  });

  it('keeps only the brackets it needs when written back', () => {
    expect(parseFormula('((A:X)+(B:Y))*C:Z')?.text).toBe('(A:X+B:Y)*C:Z');
    expect(parseFormula('(A:X*B:Y)+C:Z')?.text).toBe('A:X*B:Y+C:Z');
    expect(parseFormula('A:X-(B:Y+C:Z)')?.text).toBe('A:X-(B:Y+C:Z)');
    expect(parseFormula('A:X/(B:Y*C:Z)')?.text).toBe('A:X/(B:Y*C:Z)');
    expect(parseFormula('A:X*(-C:Z)')?.text).toBe('A:X*(-C:Z)');
    expect(parseFormula('-(A:X+B:Y)')?.text).toBe('-(A:X+B:Y)');
    // What's written reads back the same.
    for (const text of ['(A:X+B:Y)*C:Z', 'A:X-(B:Y-C:Z)', 'A:X*(-C:Z)', '1/A:X']) {
      expect(parseFormula(text)?.text).toBe(text);
    }
  });

  it('has no value where a division by zero is', () => {
    expect(worth('A:X/(B:Y-B:Y)')).toBeNaN();
  });

  it('counts each symbol once, up to 10', () => {
    expect(parseFormula('A:X+A:X*B:Y')?.symbols).toEqual(['A:X', 'B:Y']);
    const ten = Array.from({ length: 10 }, (_, i) => `E:S${i}`).join('+');
    expect(parseFormula(ten)?.symbols).toHaveLength(10);
    expect(parseFormula(`${ten}+E:S10`)).toBeNull();
    expect(parseFormula(`A:X+${'1+'.repeat(MAX_FORMULA_LENGTH)}1`)).toBeNull();
  });

  it.each([
    ['a lone symbol', 'BINANCE:XRPUSDT'],
    ['a lone number', '42'],
    ['a symbol in brackets', '(BINANCE:XRPUSDT)'],
    ['a preferred share', 'NYSE:JPM/PD'],
    ['a dangling operator', 'A:X/'],
    ['two operators', 'A:X*/B:Y'],
    ['an open bracket', '(A:X+B:Y'],
    ['an unknown character', 'A:X%B:Y'],
    ['a broken exchange', '1A:X+B:Y'],
    ['nothing', '   '],
  ])("doesn't take %s", (_label, text) => {
    expect(parseFormula(text)).toBeNull();
  });

  it('reads a symbol with a number after its operator as a formula (BINANCE:BTCUSDT/2)', () => {
    expect(parseFormula('BINANCE:BTCUSDT/2')?.symbols).toEqual(['BINANCE:BTCUSDT']);
    expect(parseFormula('BINANCE:BTCUSDT-100')?.text).toBe('BINANCE:BTCUSDT-100');
  });

  it('takes tickers without their exchange while typing, and says so', () => {
    const typed = parseFormula('TOTAL2 / XRPUSD');
    expect(typed?.symbols).toEqual(['TOTAL2', 'XRPUSD']);
    expect(typed && isComplete(typed)).toBe(false);
    const resolved =
      typed &&
      replaceSymbols(typed, (symbol) =>
        symbol === 'TOTAL2' ? 'CRYPTOCAP:TOTAL2' : 'COINBASE:XRPUSD',
      );
    expect(resolved?.text).toBe('CRYPTOCAP:TOTAL2/COINBASE:XRPUSD');
    expect(resolved && isComplete(resolved)).toBe(true);
  });

  it("names any symbol as the watchlist shows it: a ticker, or a formula's tickers", () => {
    expect(symbolName('BINANCE:XRPUSDT')).toBe('XRPUSDT');
    expect(symbolName('NYSE:JPM/PD')).toBe('JPM/PD');
    expect(symbolName('CRYPTOCAP:BTC.D')).toBe('BTC.D');
    expect(symbolName('CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD')).toBe('TOTAL2/XRPUSD');
    expect(symbolName('BITSTAMP:BTCUSD/OANDA:XAUUSD')).toBe('BTCUSD/XAUUSD');
  });

  it("charts an exchange's symbol, or a formula of them", () => {
    expect(isChartable('BINANCE:XRPUSDT')).toBe(true);
    expect(isChartable('NYSE:JPM/PD')).toBe(true);
    expect(isChartable('CRYPTOCAP:TOTAL-CRYPTOCAP:TOTAL2')).toBe(true);
    expect(isChartable('BINANCE:XRPUSDT*2')).toBe(true);
    expect(isChartable('TOTAL-TOTAL2')).toBe(false);
    expect(isChartable('XRP')).toBe(false);
    expect(isChartable('###SECTION')).toBe(false);
  });
});
