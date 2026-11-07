import type { Bar } from '@tradingnerd/core';
import { defaultSettings, RSI, RSI_PINE, sanitizeSettings } from '@tradingnerd/indicators';
import { compileScript, DEFAULT_SYMBOL, type ScriptProgram } from '@tradingnerd/pine';
import { describe, expect, it } from 'vitest';
import { formatIndicatorValue } from './model';
import {
  inputId,
  type ScriptContext,
  ScriptLayerRun,
  scriptDefaultInputs,
  scriptDefinition,
  scriptInputs,
} from './script';

const CONTEXT: ScriptContext = { symbol: DEFAULT_SYMBOL, priceDecimals: 4 };

function program(source: string): ScriptProgram {
  const result = compileScript(source);
  if (!result.ok) throw new Error(result.errors[0]?.message);
  return result.program;
}

const script = (body: string, declaration = 'indicator("Test")') =>
  program(`//@version=6\n${declaration}\n${body}`);

const bars = (count: number): Bar[] =>
  Array.from({ length: count }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 10 + Math.sin(i),
    high: 11 + Math.sin(i),
    low: 9 + Math.sin(i),
    close: 10 + Math.sin(i + 1),
    volume: 100,
  }));

describe('A script read as the chart reads a built-in (scriptDefinition)', () => {
  const rsi = program(RSI_PINE);
  const inputs = scriptDefaultInputs(rsi);
  const definition = scriptDefinition(rsi, inputs, CONTEXT);

  it('keys inputs by place, as TradingView does, with the Inputs tab’s kinds', () => {
    expect(definition.inputs.map((input) => [input.id, input.kind, input.title])).toEqual([
      ['in_0', 'int', 'RSI Length'],
      ['in_1', 'source', 'Source'],
      ['in_2', 'select', 'Type'],
      ['in_3', 'int', 'Length'],
      ['in_4', 'float', 'BB StdDev'],
      // indicator(timeframe = "", timeframe_gaps = true)'s, in the Calculation section.
      ['in_5', 'select', 'Timeframe'],
      ['in_6', 'bool', 'Wait for timeframe closes'],
    ]);
    expect(inputs).toEqual({
      in_0: 14,
      in_1: 'close',
      in_2: 'SMA',
      in_3: 14,
      in_4: 2,
      in_5: '',
      in_6: true,
    });
    expect(definition.inputs[5]?.group).toBe('Calculation');
    expect(definition.inputs[4]?.enabledWhen?.(inputs)).toBe(false);
    expect(definition.inputs[4]?.enabledWhen?.({ ...inputs, in_2: 'SMA + Bollinger Bands' })).toBe(
      true,
    );
  });

  it('draws in a pane of its own with two decimals, and names itself as the built-in does', () => {
    expect(definition.placement).toBe('pane');
    expect(definition.format).toEqual({ kind: 'decimals', decimals: 2 });
    expect(definition.legendName({ base: 'XRP', hasVolume: true })).toBe('RSI');
    expect(definition.legendInputs(inputs)).toBe('14 close');
    expect(definition.legendInputs({ ...inputs, in_5: '1W' })).toBe('14 close 1W');
  });

  it('lists the built-in’s plots, levels and fills, by kind and place', () => {
    expect(definition.plots.map((plot) => plot.id)).toEqual([
      'plot_0',
      'plot_1',
      'plot_2',
      'plot_3',
      'plot_4',
    ]);
    expect(definition.plots.slice(0, 4).map((plot) => plot.title)).toEqual(
      RSI.plots.map((plot) => plot.title),
    );
    expect(definition.levels.map((level) => level.style.value)).toEqual([70, 50, 30]);
    expect(definition.fills.map((fill) => fill.between)).toEqual([
      ['plot_2', 'plot_3'],
      ['hline_0', 'hline_2'],
      ['plot_0', 'plot_4'],
      ['plot_0', 'plot_4'],
    ]);
    expect(definition.fills[2]?.gradient).toEqual({ top: 100, bottom: 70 });
  });

  it('shows the plots its display argument shows, for these inputs', () => {
    const shown = (values: Record<string, unknown>) =>
      scriptDefinition(rsi, { ...inputs, ...values } as never, CONTEXT)
        .plots.filter((plot) => plot.shownWhen?.({}) ?? true)
        .map((plot) => plot.id);
    expect(shown({})).toEqual(['plot_0', 'plot_1']);
    expect(shown({ in_2: 'None' })).toEqual(['plot_0']);
    expect(shown({ in_2: 'SMA + Bollinger Bands' })).toEqual([
      'plot_0',
      'plot_1',
      'plot_2',
      'plot_3',
    ]);
  });

  it('keeps only the looks the Style tab changed, so the rest follows the code', () => {
    expect(defaultSettings(definition).styles).toEqual({});
    const changed = { visible: true, color: '#FF0000', opacity: 1, width: 2, dash: 'solid' };
    const settings = sanitizeSettings(definition, { inputs, styles: { plot_0: changed } });
    expect(Object.keys(settings.styles)).toEqual(['plot_0']);
    expect(settings.styles.plot_0).toMatchObject({ color: '#FF0000', width: 2 });
  });
});

describe('Scripts’ other inputs, placements and formats', () => {
  it('maps every Pine input kind to the Inputs tab’s', () => {
    const p = script(
      [
        'a = input.color(color.red, "Color")',
        'b = input.string("hello", "Text")',
        'c = input.int(2, "Choice", options = [1, 2, 3])',
        'd = input.bool(false, "Flag", tooltip = "Turns it on", inline = "row")',
        'plot(close)',
      ].join('\n'),
    );
    const definition = scriptDefinition(p, scriptDefaultInputs(p), CONTEXT);
    expect(definition.inputs.map((input) => input.kind)).toEqual([
      'color',
      'string',
      'numbers',
      'bool',
    ]);
    expect(definition.inputs[2]).toMatchObject({ options: [1, 2, 3], default: 2 });
    expect(definition.inputs[3]).toMatchObject({ tooltip: 'Turns it on', inline: 'row' });
  });

  it('gives the newer input kinds TradingView’s controls', () => {
    const p = script(
      [
        'enum Side',
        '    long = "Long only"',
        '    short = "Short only"',
        'tf = input.timeframe("60", "Timeframe")',
        'ses = input.session("0930-1600", "Session")',
        't = input.time(timestamp("2024-01-01"), "From")',
        'note = input.text_area("one\\ntwo", "Notes")',
        'side = input.enum(Side.short, "Side")',
        'plot(close)',
      ].join('\n'),
    );
    const definition = scriptDefinition(p, scriptDefaultInputs(p), CONTEXT);
    const [tf, ses, t, note, side] = definition.inputs;
    // "Chart" first, then the intervals without ticks, in TradingView's words.
    expect(tf).toMatchObject({ kind: 'select', default: '60' });
    expect(tf?.kind === 'select' && tf.options.slice(0, 2)).toEqual(['', '1S']);
    expect(tf?.kind === 'select' && tf.labels?.[0]).toBe('Chart');
    expect(tf?.kind === 'select' && tf.labels?.[tf.options.indexOf('60')]).toBe('1 hour');
    expect(ses).toMatchObject({ kind: 'session', default: '0930-1600' });
    expect(t).toMatchObject({ kind: 'time', default: Date.UTC(2024, 0, 1) });
    expect(note).toMatchObject({ kind: 'string', multiline: true });
    // An enum: its members by title, the settings keeping the name.
    expect(side).toMatchObject({
      kind: 'select',
      default: 'short',
      options: ['long', 'short'],
      labels: ['Long only', 'Short only'],
    });
  });

  it('puts an overlay on the price pane, writing values with the chart’s price decimals', () => {
    const p = script('plot(ta.sma(close, 3))', 'indicator("Average", overlay = true)');
    const definition = scriptDefinition(p, {}, CONTEXT);
    expect(definition.placement).toBe('price');
    expect(definition.format).toEqual({ kind: 'decimals', decimals: 4 });
  });

  it('writes format.percent with a percent sign, and format.volume as Volume does', () => {
    const percent = scriptDefinition(
      script('plot(close)', 'indicator("P", format = format.percent)'),
      {},
      CONTEXT,
    );
    expect(percent.format).toEqual({ kind: 'percent', decimals: 2 });
    expect(formatIndicatorValue(-12.345, percent.format)).toBe('−12.35%');
    const volume = scriptDefinition(
      script('plot(volume)', 'indicator("V", format = format.volume)'),
      {},
      CONTEXT,
    );
    expect(volume.format).toEqual({ kind: 'volume' });
  });

  it('carries Pine’s plot styles and per-bar colors in each plot’s look', () => {
    const p = script(
      [
        'plot(close, style = plot.style_columns, color = close > open ? color.green : color.red)',
        'plot(close, style = plot.style_stepline, offset = 2, show_last = 10, trackprice = true)',
        'bgcolor(color.new(color.blue, 90))',
      ].join('\n'),
    );
    const definition = scriptDefinition(p, {}, CONTEXT);
    expect(definition.plots[0]).toMatchObject({
      kind: 'columns',
      look: { style: 'columns', colorChanges: true },
    });
    expect(definition.plots[1]?.look).toMatchObject({
      style: 'stepline',
      offset: 2,
      showLast: 10,
      trackprice: true,
    });
    expect(definition.backgrounds?.map((background) => background.id)).toEqual(['bg_0']);
  });

  it('draws plotshape, plotchar and plotarrow as marks, with what places and colors them', () => {
    const p = script(
      [
        'plotshape(close > open, style = shape.triangleup, location = location.belowbar, color = color.teal, text = "Buy")',
        'plotchar(close < open, "Down", "▼", location.top, size = size.tiny)',
        'plotarrow(close - open)',
      ].join('\n'),
      'indicator("Signals", overlay = true)',
    );
    const [shape, char, arrow] = scriptDefinition(p, {}, CONTEXT).plots;
    // An untitled mark is named for its kind (provisional).
    expect(shape).toMatchObject({
      kind: 'marks',
      title: 'Shapes',
      style: { color: '#089981' },
      look: {
        mark: {
          kind: 'shape',
          shape: 'triangleup',
          location: 'belowbar',
          size: 'auto',
          text: 'Buy',
          // The text in the shape's color (the manual's "Lift text" figure).
          textColor: '#089981',
        },
      },
    });
    expect(char).toMatchObject({
      kind: 'marks',
      title: 'Down',
      look: { mark: { kind: 'char', char: '▼', location: 'top', size: 'tiny' } },
    });
    expect(arrow).toMatchObject({
      kind: 'marks',
      title: 'Arrows',
      look: { colorChanges: true, mark: { kind: 'arrow', minheight: 5, maxheight: 100 } },
    });
  });

  it('draws plotcandle as candles whose high, low and close follow them in the legend', () => {
    const p = script('plotcandle(open, high, low, close, "Mine", color.teal)');
    const definition = scriptDefinition(p, {}, CONTEXT);
    const [candles, high, low, close] = definition.plots;
    expect(candles).toMatchObject({
      kind: 'candles',
      title: 'Mine',
      look: { candle: { kind: 'candle', parts: [1, 2, 3] } },
    });
    // Parts: drawn with the candles, never listed in the Style tab by themselves.
    for (const part of [high, low, close]) {
      expect(part).toMatchObject({ partOf: 'plot_0', look: { editable: false } });
      expect(part?.shownWhen?.({})).toBe(true);
    }
    // The wick's and the border's colors, unless the script gives them (provisional).
    expect(high?.style.color).toBe('#737375');
    expect(low?.style.color).toBe('#000000');
  });

  it('marks barcolor() as coloring the chart’s bars, named "Bar color" when untitled', () => {
    const p = script('barcolor(close > open ? color.yellow : na)\nplot(close)');
    const definition = scriptDefinition(p, {}, CONTEXT);
    expect(definition.backgrounds).toMatchObject([{ id: 'bg_0', bars: true, title: 'Bar color' }]);
  });

  it('runs through ScriptLayerRun with the chart’s listing flag', () => {
    const p = script('plot(bar_index)');
    const run = new ScriptLayerRun(p, {}, CONTEXT, null);
    run.setListing(false);
    run.setBars(bars(50));
    expect(run.run.plotStarts).toEqual([Number.POSITIVE_INFINITY]);
    run.setListing(true);
    run.setBars(bars(50));
    expect(run.run.plotStarts).toEqual([0]);
    expect(run.values[0]?.[49]).toBe(49);
    expect(run.length).toBe(50);
  });

  it('turns the settings’ inputs into the script’s, checked', () => {
    const p = script('n = input.int(5, "N", minval = 1)\nplot(ta.sma(close, n))');
    expect(scriptInputs(p, { [inputId(0)]: 0 })).toEqual([1]);
    expect(scriptInputs(p, {})).toEqual([5]);
  });
});
