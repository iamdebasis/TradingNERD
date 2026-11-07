import { describe, expect, it } from 'vitest';
import { floatToString, formatMessage, formatNumber, javaDouble, parseNumber } from './format.ts';

/**
 * How Pine writes numbers. The expected strings are TradingView's own outputs as PineTS measured
 * them (third-party, PineTS 0.11.0, 2026-10-01), and the v6 reference's and manual's examples
 * (docs/SPEC.md §4.17).
 */

const noDates = () => 'DATE';
const fmt = (pattern: string, ...args: [unknown, string][]) =>
  formatMessage(
    pattern,
    args.map(([value, type]) => ({ value, type })),
    noDates,
  );

describe('str.tostring of a float', () => {
  it('writes at most 10 decimals, without trailing zeros or an exponent below 1e21', () => {
    expect([1 / 3, 0.1 + 0.2, -2 / 3, 5, 1e8, 1e-7].map(floatToString)).toEqual([
      '0.3333333333',
      '0.3',
      '-0.6666666667',
      '5',
      '100000000',
      '0.0000001',
    ]);
    expect([1e21, 1.23456789e25, 1.5e300].map(floatToString)).toEqual([
      '1E21',
      '1.23456789E25',
      '1.5E300',
    ]);
  });

  it('rounds on the number’s exact value: a tie below the written digits goes down', () => {
    // 0.99999999995 is just under the tie in binary; 0.12345678905 just over it.
    expect(floatToString(0.99999999995)).toBe('0.9999999999');
    expect(floatToString(0.12345678905)).toBe('0.1234567891');
    expect(floatToString(-0.00000000004)).toBe('0');
    expect(floatToString(Number.NaN)).toBe('NaN');
  });
});

describe('str.tostring with a format', () => {
  it('follows the reference’s examples: # rounds, 0 keeps zeros', () => {
    expect(formatNumber(1.25, '#', 0.01)).toBe('1');
    expect(formatNumber(1.25, '#.#', 0.01)).toBe('1.3');
    expect(formatNumber(1.25, '#.0000', 0.01)).toBe('1.2500');
    expect(formatNumber(3.99, '#', 0.01)).toBe('4');
  });

  it('rounds half up from the digits as written, with a leading zero', () => {
    expect([2.345, 1.005, 0.125, 2.675, -2.345].map((x) => formatNumber(x, '#.##', 0.01))).toEqual([
      '2.35',
      '1.01',
      '0.13',
      '2.68',
      '-2.35',
    ]);
    expect(formatNumber(-0.001, '#.##', 0.01)).toBe('0');
  });

  it('writes format.percent, format.volume and format.mintick as TradingView does', () => {
    expect([0.123456, 1, -0.5, 1234.5].map((x) => formatNumber(x, 'percent', 0.01))).toEqual([
      '0.12%',
      '1.00%',
      '-0.50%',
      '1234.50%',
    ]);
    expect(
      [1234567, 2.5e9, 999, 12.3456, 1500, 999.5].map((x) => formatNumber(x, 'volume', 0.01)),
    ).toEqual(['1.235M', '2.5B', '999', '12', '1.5K', '1000']);
    expect(formatNumber(0.015, 'mintick', 0.01)).toBe('0.02');
  });

  it('takes a format without digits as a prefix to the whole number', () => {
    expect(formatNumber(83123.456, 'price', 0.01)).toBe('price83123');
    expect(formatNumber(-0.4, 'x', 0.01)).toBe('-x0');
  });
});

describe('str.format, as Java’s MessageFormat', () => {
  it('writes numbers with grouping and up to three decimals by default', () => {
    expect(fmt('{0}', [1234567, 'int'])).toBe('1,234,567');
    expect(fmt('{0}', [1 / 3, 'float'])).toBe('0.333');
    expect(fmt('{0} != {0,number,#.#}', [1.34, 'float'])).toBe('1.34 != 1.3');
  });

  it('follows the reference’s number styles', () => {
    expect(fmt('{0,number,integer}', [1.34, 'float'])).toBe('1');
    expect(fmt('{0,number,currency}', [1340000, 'int'])).toBe('$1,340,000.00');
    expect(fmt('{0,number,percent}', [0.5, 'float'])).toBe('50%');
  });

  it('rounds half even on the exact value, keeping the sign of a rounded zero', () => {
    expect([2.345, 1.005, 0.125, 0.375].map((x) => fmt('{0,number,#.##}', [x, 'float']))).toEqual([
      '2.35',
      '1',
      '0.12',
      '0.38',
    ]);
    expect(fmt('{0,number,#.##}', [-0.001, 'float'])).toBe('-0');
  });

  it('keeps a placeholder without its value, and reads quotes as Java does', () => {
    expect(fmt('{0} {2}', [1, 'int'], [2, 'int'])).toBe('1 {2}');
    expect(fmt("it''s {0}", [1, 'int'])).toBe("it's 1");
    expect(fmt("'{0}' {0}", [7, 'int'])).toBe('{0} 7');
    // The style isn't trimmed: a space before it is written.
    expect(fmt('{0, number, #.##}', [1.255, 'float'])).toBe(' 1.25');
  });

  it('stops with TradingView’s messages on a malformed pattern', () => {
    expect(() => fmt('{a}', [1, 'int'])).toThrow("can't parse argument number: a");
    expect(() => fmt('x {0', [1, 'int'])).toThrow('Unmatched braces in the pattern.');
    expect(() => fmt('{0,foo}', [1, 'int'])).toThrow('unknown format type: foo');
  });

  it('writes arrays in brackets, floats as Java’s Double.toString', () => {
    expect(fmt('{0}', [[1.5, 2], 'array<float>'])).toBe('[1.5, 2.0]');
    expect(fmt('{0}', [[1, 2], 'array<int>'])).toBe('[1, 2]');
    expect([5, 1e8, 1e-7, 1 / 3].map(javaDouble)).toEqual([
      '5.0',
      '1.0E8',
      '1.0E-7',
      '0.3333333333333333',
    ]);
  });
});

describe('str.tonumber', () => {
  it('reads plain decimal numbers only, with spaces around', () => {
    expect([' 12 ', '+4', '.5', '5.', '-.5'].map(parseNumber)).toEqual([12, 4, 0.5, 5, -0.5]);
    for (const text of ['1e3', '0x10', '', 'Infinity', '12abc', '1,000', 'NaN']) {
      expect(parseNumber(text)).toBeNaN();
    }
  });
});
