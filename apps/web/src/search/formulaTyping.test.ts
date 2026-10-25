import { describe, expect, it } from 'vitest';
import { fillOperand, lastOperand, looksLikeFormula, readFormula } from './formulaTyping';

describe('typing a formula in the symbol search', () => {
  it.each([
    ['a plus', 'BTC.D+ETH.D'],
    ['a times', 'BINANCE:BTCUSDT*2'],
    ['brackets', '(TOTAL2)'],
    ["an operator followed by a space, as TradingView's help writes it", 'TOTAL2/ XRPUSD'],
    ['a space before the operator', 'BTCUSDT -ETHUSDT'],
    ['a number after it', 'XRPUSDT/2'],
    ["another exchange's symbol after it", 'CRYPTOCAP:TOTAL2/BITSTAMP:XRPUSD'],
    ['a symbol being typed after it', 'CRYPTOCAP:TOTAL3-CRYPTOCAP:US'],
  ])('reads %s as a formula', (_label, text) => {
    expect(looksLikeFormula(text)).toBe(true);
  });

  it.each([
    ['a ticker', 'XRP'],
    ['a pair with its slash', 'XRP/USDT'],
    ['a pair with a dash', 'BTC-USD'],
    ['a preferred share', 'NYSE:JPM/PD'],
    ["an exchange's symbols", 'BINANCE:'],
    ['spaces around a ticker', '  XRP  '],
  ])('leaves %s a search', (_label, text) => {
    expect(looksLikeFormula(text)).toBe(false);
  });

  it('searches for the symbol being typed, the last one', () => {
    expect(lastOperand('BTCUSDT / ETH')).toEqual({ text: 'ETH', start: 10 });
    expect(lastOperand('(BTC.D+ETH.D')).toEqual({ text: 'ETH.D', start: 7 });
    expect(lastOperand('CRYPTOCAP:TOTAL3-CRYPTOCAP:US')).toEqual({
      text: 'CRYPTOCAP:US',
      start: 17,
    });
    // Right after an operator, nothing yet: the list shows what's most traded.
    expect(lastOperand('BTCUSDT / ')).toEqual({ text: '', start: 10 });
    expect(lastOperand('BTCUSDT /')).toEqual({ text: '', start: 9 });
  });

  it('fills in the symbol picked, in place of the one being typed', () => {
    const text = 'CRYPTOCAP:TOTAL2 / xrpu ';
    expect(fillOperand(text, lastOperand(text), 'COINBASE:XRPUSD')).toBe(
      'CRYPTOCAP:TOTAL2 / COINBASE:XRPUSD',
    );
    const spaced = 'BTCUSDT / ';
    expect(fillOperand(spaced, lastOperand(spaced), 'BINANCE:ETHUSDT')).toBe(
      'BTCUSDT / BINANCE:ETHUSDT',
    );
    const after = 'BINANCE:BTCUSDT/';
    expect(fillOperand(after, lastOperand(after), 'BINANCE:ETHUSDT')).toBe(
      'BINANCE:BTCUSDT/BINANCE:ETHUSDT',
    );
  });

  it('reads text no symbol matches with its / and − as operators', () => {
    expect(readFormula('NVDA/AMD')?.symbols).toEqual(['NVDA', 'AMD']);
    expect(readFormula('BINANCE:BTCUSDT/ETH')?.text).toBe('BINANCE:BTCUSDT/ETH');
    expect(readFormula('BINANCE:BTCUSDT/ETH')?.symbols).toEqual(['BINANCE:BTCUSDT', 'ETH']);
    expect(readFormula('CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT')?.name).toBe('TOTAL3-USDT');
    expect(readFormula('XRP')).toBeNull();
  });
});
