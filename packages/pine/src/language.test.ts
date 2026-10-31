import { describe, expect, it } from 'vitest';
import { closes, compileError, indicator, plots, runScript, series } from './testing.ts';

/** Ten bars with these closes; each bar opens at the close before. */
const BARS = closes([10, 11, 12, 11, 13, 14, 12, 15, 16, 14]);
const ONE = BARS.slice(0, 1);
const NA = Number.NaN;

describe('Pine arithmetic (Pine docs, Operators)', () => {
  it('divides two ints into a fraction, as v6 does', () => {
    expect(series('plot(5 / 2)', ONE)).toEqual([2.5]);
  });

  it('takes % by rounding the quotient down, and x % 0 is x, by the docs’ own formula', () => {
    expect(series('plot(-1 % 100)', ONE)).toEqual([99]);
    expect(series('plot(7 % -3)', ONE)).toEqual([-2]);
    expect(series('plot(5 % 0)', ONE)).toEqual([5]);
  });

  it('gives na for na operands and for division by zero', () => {
    expect(series('plot(close / 0)', ONE)).toEqual([NA]);
    expect(series('plot(close + na)', ONE)).toEqual([NA]);
    expect(series('plot(close[1] * 2)', ONE)).toEqual([NA]);
  });

  it('finds comparisons with na false, either way', () => {
    expect(series('plot(close == na ? 1 : 0)', ONE)).toEqual([0]);
    expect(series('plot(close != na ? 1 : 0)', ONE)).toEqual([0]);
  });

  it('follows Pine’s precedence: [] first, then unary, * / %, + -, comparisons, not before and before or', () => {
    expect(series('plot(2 + 3 * 4 - 6 / 3)', ONE)).toEqual([12]);
    expect(series('plot(-2 * -3)', ONE)).toEqual([6]);
    expect(series('plot(not true or true ? 1 : 0)', ONE)).toEqual([1]);
    expect(series('plot(not (true or true) ? 1 : 0)', ONE)).toEqual([0]);
    expect(series('plot(1 < 2 == true ? 1 : 0)', ONE)).toEqual([1]);
    expect(series('plot(2 * close[1])', BARS.slice(0, 2))).toEqual([NA, 20]);
  });

  it('chains ?: from the right', () => {
    expect(series('plot(close > 12 ? 2 : close > 10 ? 1 : 0)', BARS)).toEqual([
      0, 1, 1, 1, 2, 2, 1, 2, 2, 2,
    ]);
  });

  it('joins strings with + and compares them with ==', () => {
    expect(series('s = "EUR" + "USD"\nplot(s == "EURUSD" ? 1 : 0)', ONE)).toEqual([1]);
  });
});

describe('Pine structures (Pine docs, Conditional structures and Loops)', () => {
  it('gives an if’s value from the branch that runs', () => {
    const body = [
      'x = if close > 12',
      '    1',
      'else if close > 10',
      '    2',
      'else',
      '    3',
      'plot(x)',
    ].join('\n');
    expect(series(body, BARS)).toEqual([3, 2, 2, 2, 1, 1, 2, 1, 1, 1]);
  });

  it('gives na when no branch runs, and false for a bool', () => {
    expect(series('y = if close > 100\n    1\nplot(y)', BARS.slice(0, 2))).toEqual([NA, NA]);
    expect(series('b = if close > 100\n    true\nplot(b ? 1 : 0)', ONE)).toEqual([0]);
  });

  it('runs a switch on a value, or on conditions, with => as its default', () => {
    const onValue = ['v = switch close', '    11 => 1', '    12 => 2', '    => 0', 'plot(v)'];
    expect(series(onValue.join('\n'), BARS)).toEqual([0, 1, 2, 1, 0, 0, 2, 0, 0, 0]);
    const onConditions = [
      'v = switch',
      '    close > 14 => 3',
      '    close > 12 => 2',
      '    => 1',
      'plot(v)',
    ];
    expect(series(onConditions.join('\n'), BARS)).toEqual([1, 1, 1, 1, 2, 2, 1, 3, 3, 2]);
  });

  it('counts a for loop up, down, and by a step', () => {
    const loop = (head: string) => series(`total = 0\n${head}\n    total += i\nplot(total)`, ONE);
    expect(loop('for i = 1 to 4')).toEqual([10]);
    expect(loop('for i = 0 to 10 by 5')).toEqual([15]);
    expect(loop('for i = 3 to 1')).toEqual([6]);
  });

  it('works out a for loop’s end again on every iteration, as v6 does', () => {
    const body = [
      'n = 3',
      'count = 0',
      'for i = 0 to n',
      '    count += 1',
      '    n := 1',
      'plot(count)',
    ];
    expect(series(body.join('\n'), ONE)).toEqual([2]);
  });

  it('skips an iteration on continue and leaves the loop on break', () => {
    const body = [
      'total = 0',
      'for i = 1 to 10',
      '    if i == 3',
      '        continue',
      '    if i == 6',
      '        break',
      '    total += i',
      'plot(total)',
    ];
    expect(series(body.join('\n'), ONE)).toEqual([12]);
  });

  it('runs a while loop while its condition holds', () => {
    expect(series('k = 1\nwhile k < 100\n    k *= 3\nplot(k)', ONE)).toEqual([243]);
  });
});

describe('Pine variables and history (Pine docs, Variable declarations, History referencing)', () => {
  it('keeps a var’s value from bar to bar', () => {
    expect(series('var count = 0\ncount += 1\nplot(count)', BARS)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('reads bars back with [], na before the first', () => {
    expect(series('plot(close[1])', BARS.slice(0, 3))).toEqual([NA, 10, 11]);
    expect(series('plot(close[20])', BARS.slice(0, 3))).toEqual([NA, NA, NA]);
  });

  it('keeps the history of variables, expressions and calls', () => {
    expect(series('x = close * 2\nplot(x[1])', BARS.slice(0, 3))).toEqual([NA, 20, 22]);
    expect(series('plot((close + open)[1])', BARS.slice(0, 3))).toEqual([NA, 20, 21]);
    expect(series('plot(ta.sma(close, 2)[1])', BARS.slice(0, 4))).toEqual([NA, NA, 10.5, 11.5]);
  });

  it('keeps a var’s reassigned value in its history', () => {
    const body = ['var float hi = na', 'hi := math.max(nz(hi, close), close)', 'plot(hi[1])'];
    expect(series(body.join('\n'), BARS)).toEqual([NA, 10, 11, 12, 12, 13, 14, 14, 15, 16]);
  });

  it('declares a typed variable as na, then fills it', () => {
    expect(series('float x = na\nx := close\nplot(x)', ONE)).toEqual([10]);
  });
});

describe('Pine user functions (Pine docs, User-defined functions)', () => {
  it('gives each call its own history', () => {
    const [a, b] = plots(
      indicator('prev(x) => x[1]\nplot(prev(close))\nplot(prev(close * 10))'),
      BARS.slice(0, 3),
    );
    expect(a).toEqual([NA, 10, 11]);
    expect(b).toEqual([NA, 100, 110]);
  });

  it('takes defaults and named arguments', () => {
    const [a, b] = plots(
      indicator('scale(x, k = 2) => x * k\nplot(scale(close))\nplot(scale(k = 3, x = close))'),
      ONE,
    );
    expect(a).toEqual([20]);
    expect(b).toEqual([30]);
  });

  it('returns tuples, as ta.macd does', () => {
    const [a, b] = plots(
      indicator('pair(x) => [x, x * 2]\n[a, b] = pair(close)\nplot(a)\nplot(b)'),
      ONE,
    );
    expect(a).toEqual([10]);
    expect(b).toEqual([20]);
    const macd = plots(
      indicator('[m, s, h] = ta.macd(close, 3, 5, 2)\nplot(m - s)\nplot(h)'),
      BARS,
    );
    expect(macd[1]).toEqual(macd[0]);
  });

  it('runs a multi-line body, its value its last line', () => {
    const body = ['spread(a, b) =>', '    d = a - b', '    d * 2', 'plot(spread(close, open))'];
    expect(series(body.join('\n'), BARS.slice(0, 2))).toEqual([0, 2]);
  });
});

describe('Pine’s compile errors, in its own words where it has them (Pine docs, Errors)', () => {
  const error = (body: string) => compileError(indicator(body)).message;

  it('wants a simple length for ta.ema, naming the argument and both types', () => {
    expect(error('len = bar_index + 1\nplot(ta.ema(close, len))')).toBe(
      "Cannot call 'ta.ema' with argument 'length'='len'. An argument of 'series int' type was used but a 'simple int' is expected.",
    );
  });

  it('takes a series length for ta.sma', () => {
    expect(series('plot(ta.sma(close, bar_index + 1))', BARS.slice(0, 3))).toEqual([10, 10.5, 11]);
  });

  it('finds a variable a later := made a series, before code above used it', () => {
    const found = compileError(
      indicator('len = 5\nplot(ta.ema(close, len))\nlen := bar_index + 1'),
    );
    expect(found.message).toMatch(/'length'='len'.*'series int'/);
    expect(found.line).toBe(4);
  });

  it('names undeclared identifiers and unknown functions', () => {
    expect(error('plot(foo)')).toBe('Undeclared identifier "foo"');
    expect(error('plot(ta.foo(close))')).toBe(
      "Could not find function or function reference 'ta.foo'",
    );
  });

  it('keeps plot() and the like to the global scope', () => {
    expect(error('if close > 0\n    plot(close)')).toMatch(
      /Cannot call 'plot' inside a local block/,
    );
  });

  it('refuses recursion, break outside a loop, and an untyped na', () => {
    expect(error('f(x) => f(x - 1)\nplot(f(1))')).toMatch(/Recursive calls/);
    expect(error('break\nplot(close)')).toMatch(/"break" can only be used inside a loop/);
    expect(error('x = na\nplot(x)')).toMatch(/NA type/);
  });

  it('wants bool conditions, as v6 does', () => {
    expect(error('x = if close\n    1\nplot(x)')).toMatch(/A condition must be a bool/);
  });

  it('types plot()’s series', () => {
    expect(error('plot("a")')).toBe(
      "Cannot call 'plot' with argument 'series'='\"a\"'. An argument of 'const string' type was used but a 'series float' is expected.",
    );
  });

  it('types the style constants as Pine does', () => {
    expect(error('plot(close, style = "line")')).toMatch(
      /'const string' type was used but a 'input plot_style'/,
    );
    expect(error('hline(1, linestyle = plot.style_line)')).toMatch(
      /'const plot_style'.*'input hline_style'/,
    );
  });

  it('wants //@version=6, an indicator() and something drawn', () => {
    expect(compileError('indicator("x")\nplot(close)').message).toMatch(/Add \/\/@version=6/);
    expect(compileError('//@version=5\nindicator("x")\nplot(close)').message).toMatch(
      /v5: tradingNerd runs v6/,
    );
    expect(compileError('//@version=6\nplot(close)').message).toMatch(/must declare indicator\(\)/);
    expect(compileError('//@version=6\nindicator("x")\na = 1').message).toMatch(
      /must draw something/,
    );
  });

  it('says which features come later', () => {
    expect(error('label.new(bar_index, high, "x")\nplot(close)')).toMatch(
      /Drawings come later \(P3\)/,
    );
    expect(error('x = request.security("BTC", "D", close)\nplot(x)')).toMatch(/comes later \(P2\)/);
    expect(compileError('//@version=6\nstrategy("x")\nplot(close)').message).toMatch(
      /Strategies come later/,
    );
  });

  it('points at where the error is', () => {
    const found = compileError(indicator('a = 1\nplot(foo)'));
    expect([found.line, found.column]).toEqual([4, 6]);
  });
});

describe('Pine’s runtime errors (Pine docs, Errors)', () => {
  it('stop the script with runtime.error()’s message, on its bar', () => {
    const run = runScript(
      indicator('if bar_index == 3\n    runtime.error("Stop here")\nplot(close)'),
      BARS,
    );
    expect(run.error).toMatchObject({ message: 'Stop here', bar: 3 });
  });

  it('stop on a length that isn’t positive', () => {
    const run = runScript(indicator('plot(ta.sma(close, bar_index - 2))'), BARS);
    expect(run.error?.message).toMatch(
      /Invalid value of the 'length' argument \(-2\) in the 'ta.sma' function/,
    );
    expect(run.error?.bar).toBe(0);
  });
});
