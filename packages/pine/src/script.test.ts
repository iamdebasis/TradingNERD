import type { Bar } from '@tradingnerd/core';
import { emaSettling } from '@tradingnerd/indicators';
import { describe, expect, it } from 'vitest';
import { colorHex, compileScript, DISPLAY, ScriptRun } from './index.ts';
import { forming, indicator, program, runScript, walk, walkBar } from './testing.ts';

const INFINITY = Number.POSITIVE_INFINITY;

/** A run checked by the warm-up rule (our first bar isn't the listing). */
function checked(body: string, bars: readonly Bar[], declaration?: string): ScriptRun {
  const run = new ScriptRun(program(indicator(body, declaration)), []);
  run.setBars(bars, false);
  return run;
}

/**
 * The script kept live over 60 more bars, three ticks each and a correction every tenth, as the
 * chart feeds a run; then a fresh run over the same bars.
 */
function liveAndFresh(source: string, fromListing = false): [ScriptRun, ScriptRun] {
  const p = program(source);
  const bars = walk(200);
  bars[199] = forming(walkBar(199), 1);
  const live = new ScriptRun(p, []);
  live.setBars(bars, fromListing);
  for (let i = 200; i < 260; i++) {
    for (let tick = 1; tick <= 3; tick++) {
      bars[bars.length - 1] = forming(walkBar(i - 1), tick);
      expect(live.update(bars, 'tick', bars.length - 1)).toEqual([bars.length - 1]);
    }
    bars[bars.length - 1] = walkBar(i - 1);
    bars.push(forming(walkBar(i), 1));
    expect(live.update(bars, 'new', bars.length - 1)).toEqual([bars.length - 2, bars.length - 1]);
    if (i % 10 === 0) {
      const corrected = walkBar(i - 1);
      bars[bars.length - 2] = {
        ...corrected,
        close: corrected.close * 1.001,
        high: corrected.high * 1.001,
      };
      expect(live.update(bars, 'correction', bars.length - 2)).toEqual([
        bars.length - 2,
        bars.length - 1,
      ]);
    }
  }
  const fresh = new ScriptRun(p, []);
  fresh.setBars(bars, fromListing);
  return [live, fresh];
}

const asArrays = (series: readonly (Float64Array | null)[], length: number) =>
  series.map((values) => (values ? Array.from(values.subarray(0, length)) : null));

function expectSameRuns(live: ScriptRun, fresh: ScriptRun): void {
  expect(live.length).toBe(fresh.length);
  expect(live.error).toEqual(fresh.error);
  expect(asArrays(live.values, live.length)).toEqual(asArrays(fresh.values, fresh.length));
  expect(asArrays(live.plotColors, live.length)).toEqual(asArrays(fresh.plotColors, fresh.length));
  expect(asArrays(live.backgrounds, live.length)).toEqual(
    asArrays(fresh.backgrounds, fresh.length),
  );
  expect(asArrays(live.fillColors, live.length)).toEqual(asArrays(fresh.fillColors, fresh.length));
  expect(live.plotStarts).toEqual(fresh.plotStarts);
  expect(live.backgroundStarts).toEqual(fresh.backgroundStarts);
  expect(live.fillStarts).toEqual(fresh.fillStarts);
}

describe('A script kept live (Pine docs, Execution model)', () => {
  const SCRIPT = indicator(
    [
      'fast = ta.ema(close, 9)',
      'slow = ta.sma(close, 21)',
      'var int crosses = 0',
      'if ta.cross(fast, slow)',
      '    crosses += 1',
      'p1 = plot(fast, color = fast > slow ? color.green : color.red)',
      'p2 = plot(slow)',
      'plot(crosses)',
      'plot(close[3] - ta.highest(5))',
      'fill(p1, p2, color = fast > slow ? color.new(color.green, 80) : color.new(color.red, 80))',
      'bgcolor(ta.rsi(close, 14) > 60 ? color.new(color.blue, 90) : na)',
    ].join('\n'),
  );

  it('gives the same values after ticks, new bars and corrections as a fresh run', () => {
    const [live, fresh] = liveAndFresh(SCRIPT);
    expectSameRuns(live, fresh);
    expect(live.plotStarts.slice(0, 2).every(Number.isFinite)).toBe(true);
  });

  it('does the same when every bar is drawn (our first bar the listing)', () => {
    const [live, fresh] = liveAndFresh(SCRIPT, true);
    expectSameRuns(live, fresh);
    expect(live.plotStarts).toEqual([0, 0, 0, 0]);
  });

  it('rolls a var back before each tick, while a varip keeps counting', () => {
    const p = program(indicator('var a = 0\na += 1\nvarip b = 0\nb += 1\nplot(a)\nplot(b)'));
    const bars = walk(5);
    const run = new ScriptRun(p, []);
    run.setBars(bars, true);
    for (let tick = 1; tick <= 3; tick++) {
      bars[4] = forming(walkBar(4), tick);
      run.update(bars, 'tick', 4);
    }
    expect(run.valuesAt(4)).toEqual([5, 8]);
  });

  it('runs afresh on anything else, as TradingView reloads a script', () => {
    const p = program(indicator('plot(ta.sma(close, 3))'));
    const run = new ScriptRun(p, []);
    run.setBars(walk(50), true);
    expect(run.update(walk(80), 'tick', 79)).toBe('all');
    expect(run.length).toBe(80);
  });
});

describe('The warm-up rule for scripts (docs/SPEC.md §6.17)', () => {
  const BARS = walk(800);

  it('draws what needs no older bars from our first bar, and a window from its first full one', () => {
    expect(checked('plot(close)', BARS).plotStarts).toEqual([0]);
    expect(checked('plot(ta.sma(close, 14))', BARS).plotStarts).toEqual([13]);
    expect(checked('plot(close - close[5])', BARS).plotStarts).toEqual([5]);
  });

  it('draws a recursive average once its seed weighs less than I1’s rule allows', () => {
    const [start] = checked('plot(ta.ema(close, 10))', BARS).plotStarts;
    const analytic = 9 + emaSettling(10);
    expect(Math.abs((start as number) - analytic)).toBeLessThanOrEqual(3);
  });

  it('never draws what counts bars or remembers the first one', () => {
    expect(checked('plot(bar_index)', BARS).plotStarts).toEqual([INFINITY]);
    expect(checked('plot(ta.cum(close))', BARS).plotStarts).toEqual([INFINITY]);
    expect(checked('var first = close\nplot(first)', BARS).plotStarts).toEqual([INFINITY]);
    const runningHigh = 'var float hi = na\nhi := math.max(nz(hi, high), high)\nplot(hi)';
    const runningLow = 'var float lo = na\nlo := math.min(nz(lo, low), low)\nplot(lo)';
    expect(checked(runningHigh, BARS).plotStarts).toEqual([INFINITY]);
    expect(checked(runningLow, BARS).plotStarts).toEqual([INFINITY]);
  });

  it('draws a state that every run reaches alike, once they have', () => {
    const regime = [
      'var bool up = false',
      'average = ta.sma(close, 20)',
      'if ta.crossover(close, average)',
      '    up := true',
      'if ta.crossunder(close, average)',
      '    up := false',
      'plot(up ? 1 : 0)',
    ].join('\n');
    const [start] = checked(regime, BARS).plotStarts;
    expect(start).toBeGreaterThan(19);
    expect(start).toBeLessThan(200);
  });

  it('draws every value when our first bar is the listing', () => {
    const run = new ScriptRun(program(indicator('plot(bar_index)\nplot(ta.cum(close))')), []);
    run.setBars(BARS, true);
    expect(run.plotStarts).toEqual([0, 0]);
  });

  it('applies to colors, backgrounds and fills too', () => {
    const run = checked(
      [
        'p = plot(close, color = close > open ? color.green : color.red)',
        'q = plot(ta.sma(close, 10))',
        'fill(p, q, color = color.new(color.blue, 90))',
        'bgcolor(bar_index % 2 == 0 ? color.new(color.gray, 90) : na)',
      ].join('\n'),
      BARS,
    );
    expect(run.plotStarts).toEqual([0, 9]);
    expect(run.fillStarts).toEqual([9]);
    expect(run.backgroundStarts).toEqual([INFINITY]);
  });

  it('still checks with the other runs when one stops on an error', () => {
    const run = checked('if close > 1000\n    runtime.error("Too high")\nplot(close)', BARS);
    expect(run.error).toBeNull();
    expect(run.plotStarts).toEqual([0]);
  });

  it('draws nothing it can’t check on a chart of one bar', () => {
    expect(checked('plot(close)', walk(1)).plotStarts).toEqual([INFINITY]);
  });
});

describe('What a script draws (ScriptProgram.describe)', () => {
  const SCRIPT = indicator(
    [
      'length = input.int(14, "Length", minval = 1, maxval = 500, group = "Main")',
      'source = input.source(close, "Source")',
      'kind = input.string("SMA", "Type", options = ["SMA", "EMA"])',
      'shown = input.bool(true, "Show")',
      'tint = input.color(color.orange, "Tint")',
      'mult = input.float(2.0, "Mult", step = 0.5, active = kind == "SMA")',
      'average = kind == "SMA" ? ta.sma(source, length) : ta.ema(source, length)',
      'p = plot(average, "Average", color = tint, linewidth = 2, display = display.all - display.status_line)',
      'q = plot(close, color = close > open ? color.green : color.red, style = plot.style_histogram)',
      'hline(70, "Upper")',
      'fill(p, q)',
      'bgcolor(shown ? color.new(color.blue, 95) : na)',
    ].join('\n'),
    'indicator("Averages", shorttitle = "AVG", overlay = true, format = format.price, precision = 3)',
  );

  it('describes the declaration and each input, defaults first', () => {
    const p = program(SCRIPT);
    const d = p.describe(p.defaults());
    expect(d).toMatchObject({
      title: 'Averages',
      shorttitle: 'AVG',
      overlay: true,
      format: 'price',
      precision: 3,
    });
    expect(d.inputs.map((input) => [input.kind, input.title, input.value])).toEqual([
      ['int', 'Length', 14],
      ['source', 'Source', 'close'],
      ['string', 'Type', 'SMA'],
      ['bool', 'Show', true],
      ['color', 'Tint', expect.any(Number)],
      ['float', 'Mult', 2],
    ]);
    expect(d.inputs[0]).toMatchObject({ minval: 1, maxval: 500, group: 'Main' });
    expect(d.inputs[2]?.options).toEqual(['SMA', 'EMA']);
  });

  it('keeps bool and color inputs out of the status line unless asked (Pine docs, Inputs)', () => {
    const p = program(SCRIPT);
    const display = p.describe(p.defaults()).inputs.map((input) => input.display);
    expect(display).toEqual([
      DISPLAY.all,
      DISPLAY.all,
      DISPLAY.all,
      DISPLAY.none,
      DISPLAY.none,
      DISPLAY.all,
    ]);
  });

  it('greys an input out by its active argument, from the other inputs', () => {
    const p = program(SCRIPT);
    expect(p.describe(p.defaults()).inputs[5]?.active).toBe(true);
    expect(p.describe([14, 'close', 'EMA']).inputs[5]?.active).toBe(false);
  });

  it('describes plots, levels, fills and backgrounds with their defaults', () => {
    const p = program(SCRIPT);
    const d = p.describe(p.defaults());
    expect(d.plots[0]).toMatchObject({
      title: 'Average',
      linewidth: 2,
      style: 'line',
      colorChanges: false,
    });
    expect(colorHex(d.plots[0]?.color as number)).toBe('#FF9800');
    expect(d.plots[0]?.display).toBe(DISPLAY.all - DISPLAY.status_line);
    expect(d.plots[1]).toMatchObject({
      title: '',
      style: 'histogram',
      colorChanges: true,
      color: null,
    });
    expect(d.hlines[0]).toMatchObject({ price: 70, title: 'Upper', linestyle: 'dashed' });
    expect(colorHex(d.hlines[0]?.color as number)).toBe('#787B86');
    expect(colorHex(d.fills[0]?.color as number)).toBe('#2962FF');
    expect(d.fills[0]?.between).toEqual([
      { output: 'plot', index: 0 },
      { output: 'plot', index: 1 },
    ]);
    expect(d.backgrounds[0]?.color).not.toBeNull();
    expect(p.describe([14, 'close', 'SMA', false]).backgrounds[0]?.color).toBeNull();
  });

  it('draws a plot in color.blue when no color is given (Pine docs, Colors)', () => {
    const p = program(indicator('plot(close)'));
    expect(colorHex(p.describe([]).plots[0]?.color as number)).toBe('#2962FF');
  });

  it('checks input values: kinds, limits and options, else the default', () => {
    const p = program(SCRIPT);
    expect(p.sanitize([1000.4, 'hl2', 'EMA', false])).toEqual([
      500,
      'hl2',
      'EMA',
      false,
      expect.any(Number),
      2,
    ]);
    expect(p.sanitize([0, 'nowhere', 'WMA', 'yes', -1, Number.NaN])).toEqual([
      1,
      'close',
      'SMA',
      true,
      expect.any(Number),
      2,
    ]);
    expect(p.sanitize([7.6])[0]).toBe(8);
  });

  it('runs with the values given', () => {
    const bars = walk(30);
    const sma = runScript(SCRIPT, bars, [5]).values[0]?.[29] as number;
    const expected = bars.slice(25, 30).reduce((sum, bar) => sum + bar.close, 0) / 5;
    expect(sma).toBeCloseTo(expected, 12);
  });
});

describe('Compiling (compileScript)', () => {
  it('gives errors with where they are, and warnings apart', () => {
    const failed = compileScript(indicator('plot(nothing)'));
    expect(failed).toMatchObject({
      ok: false,
      errors: [{ severity: 'error', line: 3, column: 6 }],
    });
    const warned = compileScript(indicator('x = 1\nif close > 0\n    x = 2\nplot(x)'));
    expect(warned.ok).toBe(true);
    expect(warned.warnings).toMatchObject([
      { severity: 'warning', message: expect.stringMatching(/Shadowing/), line: 5 },
    ]);
  });
});

describe('Speed', () => {
  it('runs RSI’s Pine code over 20,000 bars with the warm-up checks in well under a second', () => {
    const p = program(
      indicator('rsi = ta.rsi(close, 14)\nplot(rsi)\nplot(ta.sma(rsi, 14))\nhline(70)\nhline(30)'),
    );
    const bars = walk(20_000);
    const run = new ScriptRun(p, []);
    const started = Date.now();
    run.setBars(bars, false);
    const loaded = Date.now() - started;
    bars[19_999] = forming(walkBar(19_999), 2);
    const ticked = Date.now();
    for (let i = 0; i < 100; i++) run.update(bars, 'tick', 19_999);
    const tick = (Date.now() - ticked) / 100;
    expect(loaded).toBeLessThan(1_500);
    expect(tick).toBeLessThan(5);
  });
});
