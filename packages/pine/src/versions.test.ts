import { describe, expect, it } from 'vitest';
import { DEFAULT_SYMBOL } from './runtime.ts';
import { compileError, firstDifference, plots, program, walk } from './testing.ts';
import { hexColor, unpackColor } from './values.ts';

/**
 * Older Pine versions run as TradingView runs them, by the rules its migration guides give
 * ("To Pine Script version 3" to "version 6"): names they had, and behaviour they kept.
 */

const bars = walk(80);
const first = (source: string) => plots(source, bars)[0] as number[];

describe('Pine v4 and older, in their own words', () => {
  it('runs a v4 script with study(), built-ins without namespaces and input(type = …)', () => {
    const v4 = first(`//@version=4
study("Test")
len = input(14, title="Length", type=input.integer, minval=1)
plot(sma(close, len) + rsi(close, len) + highest(high, 5) - lowest(low, 5) + abs(change(close)))`);
    const v6 = first(`//@version=6
indicator("Test")
len = input.int(14, "Length", minval = 1)
plot(ta.sma(close, len) + ta.rsi(close, len) + ta.highest(high, 5) - ta.lowest(low, 5) + math.abs(ta.change(close)))`);
    expect(firstDifference(v4, v6)).toBe(-1);
    expect(
      program(`//@version=4
study("Test")
len = input(14, title="Length", type=input.integer, minval=1)
plot(close)`).inputs[0],
    ).toMatchObject({ kind: 'int', title: 'Length', defval: 14, minval: 1 });
  });

  it('reads v3’s colors, plot styles and variables by their v4 names', () => {
    const p = program(`//@version=3
study("Test")
plot(close + n, color=red, style=histogram)`);
    const plot = p.describe([]).plots[0];
    expect(plot?.style).toBe('histogram');
    // v3 and v4 colors are v5's (v6 changed red, teal and yellow).
    expect(plot?.color).toBe(hexColor('#FF5252'));
    const values = first(`//@version=3
study("Test")
plot(close + n)`);
    expect(values[5]).toBeCloseTo((bars[5]?.close ?? 0) + 5, 12);
  });

  it('works out both of iff()’s values on every bar, as v4 did', () => {
    const v4 = first(`//@version=4
study("Test")
plot(iff(close > open, highest(10), lowest(10)))`);
    const v6 = first(`//@version=6
indicator("Test")
h = ta.highest(10)
l = ta.lowest(10)
plot(close > open ? h : l)`);
    expect(firstDifference(v4, v6)).toBe(-1);
  });

  it('reads v4’s rsi(x, y) with a float y as MFI’s formula, and offset() as history', () => {
    const values = first(`//@version=4
study("Test")
plot(rsi(close, open * 1.0) + offset(close, 2))`);
    const i = 10;
    const bar = bars[i] as (typeof bars)[number];
    const before = bars[i - 2] as (typeof bars)[number];
    expect(values[i]).toBeCloseTo(100 - 100 / (1 + bar.close / bar.open) + before.close, 9);
  });

  it('keeps names the script declares: a variable called sma beside sma()', () => {
    const values = first(`//@version=4
study("Test")
sma = sma(close, 3)
plot(sma)`);
    const v6 = first(`//@version=6
indicator("Test")
plot(ta.sma(close, 3))`);
    expect(firstDifference(values, v6)).toBe(-1);
  });

  it('declares v2’s self-referencing variables first, as v3 asks', () => {
    expect(
      first(`//@version=2
study("Test")
s = nz(s[1]) + 1
plot(s)`).slice(0, 4),
    ).toEqual([1, 2, 3, 4]);
  });

  it('reads a bool as 1 or 0 in v2 arithmetic; v3 forbade it (the manual’s own example)', () => {
    const counted = first(`//@version=2
study("Test")
s = close >= open
sum = s + s[1] - (close < open)
plot(sum)`);
    const values = bars.map((bar, i) => {
      const up = (k: number) => ((bars[k]?.close ?? 0) >= (bars[k]?.open ?? 0) ? 1 : 0);
      return i === 0 ? Number.NaN : up(i) + up(i - 1) - (bar.close < bar.open ? 1 : 0);
    });
    expect(firstDifference(counted.slice(1), values.slice(1))).toBe(-1);
    expect(compileError('//@version=3\nstudy("Test")\nplot((close > open) + 1)').message).toMatch(
      /Cannot apply "\+" to 'series bool'/,
    );
  });

  it('reads v4’s barssince() as ta.barssince(), and v3’s plot style as an hline’s linestyle', () => {
    const v3 = `//@version=3
study("Test")
hline(0, linestyle=line)
plot(barssince(close > open))`;
    const v6 = `//@version=6
indicator("Test")
plot(ta.barssince(close > open))`;
    expect(firstDifference(first(v3), first(v6))).toBe(-1);
    expect(program(v3).describe([]).hlines[0]?.linestyle).toBe('solid');
  });

  it('gives v4’s bgcolor() and fill() a transparency of 90 when none is given', () => {
    const background = program(`//@version=4
study("Test")
bgcolor(color.red)
plot(close)`).describe([]).backgrounds[0];
    expect(unpackColor(background?.color as number).t).toBe(90);
  });

  it('joins transp to the color it applies to (v5 deprecated it, v6 removed it)', () => {
    const plot = program(`//@version=5
indicator("Test")
plot(close, color = color.blue, transp = 50)`).describe([]).plots[0];
    expect(unpackColor(plot?.color as number).t).toBe(50);
  });
});

describe('Pine v5’s rules, kept for v5 scripts (v6 migration guide)', () => {
  it('casts numbers to bools in v5; v6 asks for a bool', () => {
    expect(
      first(`//@version=5
indicator("Test")
plot(bar_index ? 1 : 0)`).slice(0, 3),
    ).toEqual([0, 1, 1]);
    expect(
      compileError(`//@version=6
indicator("Test")
plot(bar_index ? 1 : 0)`).message,
    ).toMatch(/must be a bool/);
  });

  it('casts numbers where a function or a bool variable needs a bool, in v4 and v5; v6 asks for one', () => {
    // The v6 guide: v5 cast "when an expression or function requires a boolean value". Found
    // with VuManChu B (v4), whose valuewhen() takes a price or na as its condition (2026-11-08).
    const asNumber = first(`//@version=4
study("Test")
x = close > open ? close : na
plot(valuewhen(x, close, 0) + barssince(x ? 1 : 0))`);
    const asBool = first(`//@version=6
indicator("Test")
x = close > open
plot(ta.valuewhen(x, close, 0) + ta.barssince(x))`);
    expect(firstDifference(asNumber, asBool)).toBe(-1);
    for (const body of [
      'x = close > open ? 1 : 0\nplot(ta.valuewhen(x, close, 0))',
      'x = close > open ? 1 : 0\nalertcondition(x, "a", "b")\nplot(close)',
      'bool b = 0\nb := close > open ? 1 : 0\nplot(b ? 1 : 0)',
      'f(bool up) => up ? 1 : 0\nplot(f(bar_index))',
      'type T\n    bool up = 1\nt = T.new(0)\nt.up := 2\nplot(t.up ? 1 : 0)',
    ]) {
      expect(() => program(`//@version=5\nindicator("Test")\n${body}`)).not.toThrow();
      expect(compileError(`//@version=6\nindicator("Test")\n${body}`).message).toMatch(
        /bool|Cannot assign|Cannot set|default/,
      );
    }
    expect(
      first('//@version=5\nindicator("Test")\nbool b = bar_index % 2\nplot(b ? 1 : 0)').slice(0, 4),
    ).toEqual([0, 1, 0, 1]);
  });

  it('gives v5 bools a third value, na, which na(), nz() and fixnan() see and == false doesn’t', () => {
    // The v6 guide, "Boolean values cannot be na": in v5 "na is evaluated as false" when cast,
    // "is not considered equal to false" with ==, and na() returns true for it.
    const v5 = (body: string) =>
      plots(
        `//@version=5\nindicator("Test")\nbool b = na\nb := bar_index > 2 ? true : na\n${body}`,
        bars,
      ).map((p) => p.slice(0, 5));
    expect(
      v5(`plot(na(b) ? 1 : 0)
plot(b == false ? 1 : 0)
plot(nz(b) ? 1 : 0)
plot(b and true ? 1 : 0)
plot(na(b[1]) ? 1 : 0)
plot(fixnan(bar_index == 1 ? true : bar_index == 3 ? false : na) ? 1 : 0)`),
    ).toEqual([
      [1, 1, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 1, 1],
      [0, 0, 0, 1, 1],
      [1, 1, 1, 1, 0],
      [0, 1, 1, 0, 0],
    ]);
    // An if without else gives na in v5, false in v6.
    expect(
      first('//@version=5\nindicator("Test")\nx = if close < 0\n    true\nplot(na(x) ? 1 : 0)')[0],
    ).toBe(1);
    expect(
      compileError('//@version=6\nindicator("Test")\nbool b = true\nplot(na(b) ? 1 : 0)').message,
    ).toMatch(/na\(\) doesn't take a bool/);
  });

  it('works out both sides of and/or in v5; v6 stops when the left side decides', () => {
    const body = `var a = array.new_int()
f() =>
    a.push(1)
    true
x = close < 0 and f()
plot(a.size())`;
    expect(first(`//@version=5\nindicator("Test")\n${body}`).slice(0, 3)).toEqual([1, 2, 3]);
    expect(first(`//@version=6\nindicator("Test")\n${body}`).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('divides two const ints as ints in v5; v6 gives the fraction', () => {
    expect(first('//@version=5\nindicator("Test")\nplot(5 / 2)')[0]).toBe(2);
    expect(first('//@version=6\nindicator("Test")\nplot(5 / 2)')[0]).toBe(2.5);
  });

  it('reads a for loop’s end once in v5; v6 reads it before every iteration', () => {
    const body = `n = 3
k = 0
for i = 0 to n
    k += 1
    n := 5
plot(k)`;
    expect(first(`//@version=5\nindicator("Test")\n${body}`)[0]).toBe(4);
    expect(first(`//@version=6\nindicator("Test")\n${body}`)[0]).toBe(6);
  });

  it('keeps v5’s values for the colors v6 changed', () => {
    const color = (version: number) =>
      program(`//@version=${version}\nindicator("Test")\nplot(close, color = color.red)`).describe(
        [],
      ).plots[0]?.color;
    expect(color(5)).toBe(hexColor('#FF5252'));
    expect(color(6)).toBe(hexColor('#F23645'));
  });

  it('writes a daily timeframe.period as "D" in v5 and "1D" in v6', () => {
    const daily = { ...DEFAULT_SYMBOL, timeframe: '1D' };
    const source = (version: number) =>
      `//@version=${version}\nindicator("Test")\nplot(timeframe.period == "D" ? 1 : timeframe.period == "1D" ? 2 : 0)`;
    expect(plots(source(5), bars, [], daily)[0]?.[0]).toBe(1);
    expect(plots(source(6), bars, [], daily)[0]?.[0]).toBe(2);
  });

  it('lets v5 reference a literal’s history; v6 refuses it', () => {
    expect(first('//@version=5\nindicator("Test")\nplot(close + 1[1])')[1]).toBeCloseTo(
      (bars[1]?.close ?? 0) + 1,
      12,
    );
    expect(compileError('//@version=6\nindicator("Test")\nplot(close + 1[1])').message).toMatch(
      /cannot be used on a literal/,
    );
  });

  it('uses the first of a repeated argument in v5, with a warning; v6 refuses', () => {
    const v5 = program(
      '//@version=5\nindicator("Test")\nplot(close, color = color.blue, color = color.red)',
    );
    expect(v5.warnings.some((w) => /given twice/.test(w.message))).toBe(true);
    expect(
      compileError(
        '//@version=6\nindicator("Test")\nplot(close, color = color.blue, color = color.red)',
      ).message,
    ).toMatch(/given twice/);
  });
});

describe('versions', () => {
  it('reads a script without //@version as version 1, as Pine assumes', () => {
    expect(first('study("Test")\nplot(close)')).toEqual(bars.map((bar) => bar.close));
    // The v6 reference: "Pine Script v1 has no function named indicator()".
    for (const version of ['', '//@version=4\n']) {
      expect(compileError(`${version}indicator("Test")\nplot(close)`).message).toBe(
        "Could not find function or function reference 'indicator'",
      );
    }
  });
});
