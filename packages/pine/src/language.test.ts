import { describe, expect, it } from 'vitest';
import { closes, compileError, indicator, plots, program, runScript, series } from './testing.ts';
import { COLORS, withTransparency } from './values.ts';

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

  it('gives a for…in loop its last iteration’s value, as the reference’s example returns it', () => {
    // The v6 reference's for...in: how many of the bar's OHLC values are above a value.
    const body = `values = array.from(1.0, 5.0, 3.0, 8.0)
countAbove(value, array) =>
    int result = 0
    for item in array
        if item > value
            result += 1
        result
plot(countAbove(2.5, values))
plot(countAbove(2.5, array.new<float>()))`;
    expect(plots(indicator(body), ONE).map((values) => values[0])).toEqual([3, NA]);
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

  it('runs a one-line body of statements separated by commas, its value the last', () => {
    // The v6 manual's own: `printTable(txt) => var table t = table.new(…), table.cell(…)`.
    expect(
      series('f(x) => var float first = x, x - first\nplot(f(close))', BARS.slice(0, 3)),
    ).toEqual([0, 1, 2]);
    expect(series('g(x) => d = x * 2, [d, d + 1]\n[a, b] = g(close)\nplot(b)', ONE)).toEqual([21]);
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

  it('takes versions 1 to 6, wants a declaration and something drawn', () => {
    expect(compileError('//@version=7\nindicator("x")\nplot(close)').message).toMatch(
      /v7 doesn't exist: the versions are 1 to 6/,
    );
    expect(compileError('//@version=6\nplot(close)').message).toMatch(
      /must declare indicator\(\) or library\(\)/,
    );
    expect(compileError('//@version=6\nindicator("x")\na = 1').message).toMatch(
      /must have an output/,
    );
  });

  it('runs a script whose only output is its logs, as the manual’s debugging examples do', () => {
    const run = runScript(
      indicator('if barstate.isfirst\n    log.info("first")\n    log.warning("careful")'),
      closes([1, 2, 3]),
    );
    expect(run.error).toBeNull();
    expect(run.logs.map((entry) => [entry.level, entry.message])).toEqual([
      ['info', 'first'],
      ['warning', 'careful'],
    ]);
    // Each says where it came from: its bar and that bar's time, and its line for Source code.
    expect(run.logs[0]).toMatchObject({ bar: 0, line: 4, realtime: false });
    expect(run.logs[0]?.time).toBe((closes([1])[0]?.time ?? 0) * 1000);
    expect(run.logging).toBe(true);
    expect(run.logsWritten).toBe(2);
    expect(runScript(indicator('plot(close)'), closes([1])).logging).toBe(false);
  });

  it('joins a string wrapped inside parentheses, its line break and indentation dropped', () => {
    // TradingView's manual writes a long log over several lines; its Pine Logs show each
    // message line once, without the indentation (Time, Figure 295).
    const run = runScript(
      indicator(`if barstate.isfirst
    log.info(
         "a: {0}\\n
         b: {1}",
         1, 2
     )
plot(close)`),
      closes([1, 2]),
    );
    expect(run.logs[0]?.message).toBe('a: 1\nb: 2');
  });

  it('says plainly what tradingNerd doesn\u2019t run yet, without milestone codes', () => {
    const seed =
      'x = request.seed("seed_crypto_santiment", "BTC_SENTIMENT_POSITIVE", close)\nplot(x)';
    expect(error(seed)).toMatch(/isn't supported in tradingNerd yet: this data comes from/);
    expect(error('x = request.financial("NASDAQ:AAPL", "TOTAL_REVENUE", "FQ")\nplot(x)')).toMatch(
      /financial data comes in a later update/,
    );
    expect(error(seed)).not.toMatch(/\(P\d\)/);
  });

  it('points at where the error is', () => {
    const found = compileError(indicator('a = 1\nplot(foo)'));
    expect([found.line, found.column]).toEqual([4, 6]);
  });
});

describe('A variable declared simple (the v6 reference, simple)', () => {
  it('takes a simple value, and refuses a series one in v6', () => {
    const body = 'simple float myVar = 5.0\nmyVar := close\nplot(myVar)';
    expect(compileError(indicator(body)).message).toBe(
      '"myVar" is declared simple, so it can\'t take a series value',
    );
    expect(() => program(indicator('simple float x = 5.0\nx := 6.0\nplot(x)'))).not.toThrow();
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

  it('stop on a negative history offset; an na one reads na, as HalfTrend needs', () => {
    // HalfTrend reads high[math.abs(ta.highestbars(amplitude))], na over its first bars.
    const na = 'n = int(na)\nx = close * 2\nplot(close[n] + x[n] + (close + 1)[n])';
    expect(series(na, ONE)).toEqual([NA]);
    const run = runScript(indicator('n = bar_index - 1\nplot(close[n])'), BARS);
    expect(run.error).toMatchObject({
      message: expect.stringMatching(/Invalid history reference \[-1\]/),
      bar: 0,
    });
  });
});

describe('An if’s or a switch’s value known before the bars (the v6 migration guide)', () => {
  // The guide's "`na` and unique types demo", cut to two options.
  const STYLES = `string inputStyle = input.string("Area", "Plot style", options = ["Area", "Columns"])
selectedPlotStyle = switch inputStyle
    "Area"    => plot.style_area
    "Columns" => plot.style_columns
plot(close, style = selectedPlotStyle)
cross = input.bool(true, "Crosses")
hundredStyle = if cross
    plot.style_cross
plot(100, style = hundredStyle)`;

  it('gives an input plot style from a switch or an if on an input, na being a line in v5', () => {
    const p = program(`//@version=5\nindicator("x")\n${STYLES}`);
    expect(p.describe([]).plots.map((plot) => plot.style)).toEqual(['area', 'cross']);
    expect(p.describe(['Columns', false]).plots.map((plot) => plot.style)).toEqual([
      'columns',
      'line',
    ]);
  });

  it('needs a default block and an else block in v6, as the value could be na otherwise', () => {
    expect(compileError(indicator(STYLES))).toMatchObject({
      message: expect.stringMatching(/A switch that returns a 'plot_style' must have a default/),
      line: 4,
    });
    const ifOnly = STYLES.replace('"Columns" => plot.style_columns', '=> plot.style_columns');
    expect(compileError(indicator(ifOnly)).message).toMatch(
      /An if that returns a 'plot_style' must have an else block/,
    );
  });

  it('takes the strongest qualifier of its parts: simple on the timeframe, series on a close', () => {
    const ema = (cond: string) =>
      indicator(`len = if ${cond}\n    14\nelse\n    20\nplot(ta.ema(close, len))`);
    expect(() => program(ema('timeframe.isdaily'))).not.toThrow();
    expect(compileError(ema('close > 10')).message).toMatch(/'series int' type was used/);
  });

  it('gives a function’s result its arguments’ qualifier, each call its own', () => {
    // The manual's fillColor(color.lime) for a fill between hlines (Fills between levels), and a
    // call inside a function, which is one call site for every call of that function.
    const p = program(
      indicator(`h1 = hline(1)
h2 = hline(2)
fillColor(color col) =>
    color.new(col, 90)
fill(h1, h2, fillColor(color.lime))
lw(x) => x
twice(x) =>
    y = lw(x) * 2
    y
plot(close, linewidth = twice(1))
plot(close, linewidth = twice(input.int(2)))`),
    );
    expect(p.describe([]).fills[0]?.color).toBe(withTransparency(COLORS.lime as number, 90));
    // The v6 reference's `const` example: a function ending in a const declaration.
    const titled = program(
      indicator(`concatStrings(const string x, const string y) =>
    const string result = x + y
const string myTitle = concatStrings("My ", "Plot")
plot(close, myTitle)`),
    );
    expect(titled.describe([]).plots[0]?.title).toBe('My Plot');
    expect(p.describe([]).plots.map((plot) => plot.linewidth)).toEqual([2, 4]);
    expect(p.describe([3]).plots.map((plot) => plot.linewidth)).toEqual([2, 6]);
  });
});

describe('Two ints divided (Pine docs: the v6 migration guide; Arrays; Colors)', () => {
  it('keep the fraction but stay an int, which an int parameter takes the floor of', () => {
    const bars = closes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The manual's "Distance from high": array.get(fillColors, fillNo) with fillNo from int
    // division, "the equivalent of floor(fillNo)"; and ta.atr(lengthInput / 5) (CCI DC).
    const values = plots(
      indicator(`n = input.int(5)
half = n / 2
arr = array.from(10, 20, 30)
plot(half)
plot(arr.get(n / 2))
plot(ta.sma(close, n / 2))
int fromDivision = n / 2
plot(fromDivision)`),
      bars,
    );
    expect(values[0]?.[9]).toBe(2.5);
    expect(values[1]?.[9]).toBe(30);
    // A length of 2.5 is 2: the mean of the last two closes.
    expect(values[2]?.[9]).toBe(9.5);
    expect(values[3]?.[9]).toBe(2.5);
  });

  it('divide as integers when both are const in v5, as the guide says', () => {
    const v5 = (body: string) => `//@version=5\nindicator("x")\n${body}`;
    expect(plots(v5('plot(5 / 2)'), closes([1]))[0]?.[0]).toBe(2);
    expect(plots(indicator('plot(5 / 2)'), closes([1]))[0]?.[0]).toBe(2.5);
  });
});
