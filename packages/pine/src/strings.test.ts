import { describe, expect, it } from 'vitest';
import { closes, compileError, indicator, runScript, series } from './testing.ts';

/**
 * Pine's strings in scripts (the v6 reference's str.* functions). Each check compares in Pine
 * and plots 1 or 0. The na-string rules are TradingView's as PineTS measured them (third-party,
 * docs/SPEC.md §4.17).
 */

const bars = closes([10, 11, 12]);
const holds = (condition: string) => series(`plot((${condition}) ? 1 : 0)`, bars)[0];

describe('str.* functions', () => {
  it('finds, cuts and changes text', () => {
    expect(holds('str.contains("BINANCE:BTCUSDT", ":")')).toBe(1);
    expect(holds('str.pos("NASDAQ:AAPL", ":") == 6')).toBe(1);
    expect(holds('str.substring("NASDAQ:AAPL", 7) == "AAPL"')).toBe(1);
    expect(
      holds(
        'str.replace("FTX:BTCUSD / FTX:BTCEUR", "FTX", "BINANCE", 0) == "BINANCE:BTCUSD / FTX:BTCEUR"',
      ),
    ).toBe(1);
    expect(holds('str.replace_all("a-b-c", "-", "+") == "a+b+c"')).toBe(1);
    expect(holds('str.repeat("?", 3, ",") == "?,?,?"')).toBe(1);
    expect(holds('str.trim("    abc    ") == "abc"')).toBe(1);
    expect(holds('str.upper("abc") + str.lower("DEF") == "ABCdef"')).toBe(1);
    expect(holds('str.startswith("abc", "ab") and str.endswith("abc", "bc")')).toBe(1);
  });

  it('matches a regular expression and splits text', () => {
    expect(
      holds(
        'str.match("It\'s time to sell some NASDAQ:AAPL!", "[\\\\w]+:[\\\\w]+") == "NASDAQ:AAPL"',
      ),
    ).toBe(1);
    expect(series('plot(str.split("a,b,,c", ",").size())', bars)[0]).toBe(4);
    expect(holds('str.tonumber("12.5") == 12.5')).toBe(1);
    expect(holds('na(str.tonumber("1e3"))')).toBe(1);
  });

  it('writes numbers and arrays as TradingView does', () => {
    expect(holds('str.tostring(1.25, "#.#") == "1.3"')).toBe(1);
    expect(holds('str.tostring(array.from(1, 2.0, -3.14)) == "[1, 2, -3.14]"')).toBe(1);
    expect(holds('str.format("{0,number,#.#}", 1.34) == "1.3"')).toBe(1);
    expect(
      holds(
        'str.format("Number {0} is not {1} to {2}", 1, "equal", 4) == "Number 1 is not equal to 4"',
      ),
    ).toBe(1);
    expect(holds('array.join(array.from(5.0, 2.5), ",") == "5.0,2.5"')).toBe(1);
  });

  it('formats times in the exchange’s zone, or the one given', () => {
    expect(holds('str.format_time(0, "yyyy-MM-dd HH:mm", "UTC+2") == "1970-01-01 02:00"')).toBe(1);
  });

  it('stops with a runtime error on a malformed str.format pattern', () => {
    const run = runScript(indicator('plot(str.length(str.format("x {0", 1)))'), bars);
    expect(run.error?.message).toBe('Unmatched braces in the pattern.');
  });
});

describe('the na string is the empty string', () => {
  it('adds nothing, is na, and equals ""', () => {
    expect(holds('"a" + string(na) + "b" == "ab"')).toBe(1);
    expect(holds('na("")')).toBe(1);
    expect(holds('str.length(string(na)) == 0')).toBe(1);
    expect(holds('nz(string(na), "x") == "x"')).toBe(1);
  });

  it('is what an empty array of strings and a missing map key hold', () => {
    expect(holds('array.new_string(2).join(",") == ","')).toBe(1);
    expect(holds('na(map.new<int, string>().get(1))')).toBe(1);
  });
});

describe('str.tostring types', () => {
  it('refuses a color, which has no text form', () => {
    expect(compileError(indicator('plot(str.length(str.tostring(color.red)))')).message).toMatch(
      /can't write a value of type 'color'/,
    );
  });
});
