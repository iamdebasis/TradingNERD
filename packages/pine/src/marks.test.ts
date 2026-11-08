import { describe, expect, it } from 'vitest';
import { CANDLE_BORDER, CANDLE_WICK } from './marks.ts';
import { closes, indicator, plots, program, runScript } from './testing.ts';
import { COLORS, hexColor } from './values.ts';

/**
 * Pine's marks and bars (Pine docs: Text and shapes, Bar plotting, Bar coloring; the v6
 * reference). Defaults the reference's text leaves out are measured from the manual's figures
 * and marked provisional (docs/SPEC.md §11).
 */

const bars = closes([10, 11, 10.5, 12, 11]);

describe('plotshape, plotchar and plotarrow', () => {
  it('keeps a bool series as 1 or 0 on each bar, as the legend shows it', () => {
    const [shape] = plots(indicator('plotshape(close > open, "Up")'), bars);
    expect(shape).toEqual([0, 1, 0, 1, 0]);
  });

  it('describes a shape by its style, place, size and text, at the manual’s defaults', () => {
    const p = program(
      indicator(`plotshape(close > open)
plotshape(close > open, "Long", shape.triangleup, location.belowbar, color.teal, text = "B\\nUY", textcolor = color.white, size = size.small)
plotchar(close > open)
plotarrow(close - open)`),
    );
    const [plain, long, char, arrow] = p.describe([]).plots;
    expect(plain).toMatchObject({
      kind: 'shape',
      color: COLORS.blue,
      mark: { shape: 'xcross', location: 'abovebar', size: 'auto', text: '' },
    });
    expect(long).toMatchObject({
      kind: 'shape',
      title: 'Long',
      color: COLORS.teal,
      mark: {
        shape: 'triangleup',
        location: 'belowbar',
        size: 'small',
        text: 'B\nUY',
        textColor: COLORS.white,
      },
    });
    expect(char).toMatchObject({ kind: 'char', mark: { char: '★', location: 'abovebar' } });
    // plotarrow: its length between 5 and 100 px (the reference's defaults).
    expect(arrow).toMatchObject({
      kind: 'arrow',
      colorChanges: true,
      mark: { minheight: 5, maxheight: 100 },
    });
  });

  it('colors each arrow by its direction: color.lime up and color.red down by default', () => {
    const run = runScript(indicator('plotarrow(close - open)'), bars);
    const colors = Array.from(run.plotColors[0] ?? []).slice(0, bars.length);
    // Close − open: 0, 1, −0.5, 1.5, −1.
    expect(colors.slice(1)).toEqual([COLORS.lime, COLORS.red, COLORS.lime, COLORS.red]);
    expect(Array.from(run.values[0] ?? []).slice(0, bars.length)).toEqual([0, 1, -0.5, 1.5, -1]);
  });

  it('writes the text in the mark’s color unless the script gives one', () => {
    // The Pine manual's "Lift text" figure: each letter in its shape's color.
    const fixed = program(indicator('plotshape(true, color = color.teal, text = "x")'));
    expect(fixed.describe([]).plots[0]?.mark).toMatchObject({
      textColor: COLORS.teal,
      textPart: null,
    });
    // A color that changes: the text reads the mark's own colors, bar by bar.
    const changing = program(
      indicator('plotshape(true, color = close > open ? color.green : color.red, text = "x")'),
    );
    const [mark, ...rest] = changing.describe([]).plots;
    expect(mark?.mark?.textPart).toBe(0);
    expect(rest).toEqual([]);
  });

  it('keeps a text color that changes from bar to bar in a hidden part of its own', () => {
    const p = program(
      indicator('plotshape(true, text = "x", textcolor = close > open ? color.green : color.red)'),
    );
    const [shape, part] = p.describe([]).plots;
    expect(shape?.mark?.textPart).toBe(1);
    expect(part?.kind).toBe('part');
    const run = runScript(p.source, bars);
    expect(run.plotColors[1]?.[1]).toBe(COLORS.green);
    expect(run.plotColors[1]?.[2]).toBe(COLORS.red);
  });

  it('takes shape.*, location.* and size.* as the plain strings the v6 reference types them', () => {
    expect(
      program(
        indicator('plotchar(true, char = "▲", location = location.top, size = size.huge)'),
      ).describe([]).plots[0]?.mark,
    ).toMatchObject({ char: '▲', location: 'top', size: 'huge' });
    // Kept in a string input and picked by the user, as scripts on TradingView do; the manual's
    // own examples offer size.* in input.string()'s options (found 2026-11-08).
    const picked = program(
      indicator(`s = input.string(shape.circle, "Shape", options = [shape.circle, shape.cross])
string where = location.belowbar
z = input.string(size.small, "Size", options = [size.tiny, size.small, size.large])
plotshape(true, style = s, location = where, size = z)`),
    );
    expect(picked.describe([]).plots[0]?.mark).toMatchObject({
      shape: 'circle',
      location: 'belowbar',
      size: 'small',
    });
    expect(picked.describe(['cross', 'large']).plots[0]?.mark).toMatchObject({
      shape: 'cross',
      size: 'large',
    });
    // Text none of them has draws as the default would, with a warning.
    const unknown = program(indicator('plotshape(true, style = "nope")'));
    expect(unknown.describe([]).plots[0]?.mark).toMatchObject({ shape: 'xcross' });
    expect(unknown.warnings.map((w) => w.message).join()).toMatch(/nope/);
  });
});

describe('plotcandle and plotbar', () => {
  it('keep the open as their value and the high, low and close in hidden parts', () => {
    const source = indicator('plotcandle(open, high, low, close, "Candles")');
    const p = program(source);
    const [candle, high, low, close] = p.describe([]).plots;
    expect(candle).toMatchObject({ kind: 'candle', title: 'Candles', parts: [1, 2, 3] });
    expect([high?.kind, low?.kind, close?.kind]).toEqual(['part', 'part', 'part']);
    const values = plots(source, bars);
    expect(values[0]).toEqual(bars.map((bar) => bar.open));
    expect(values[1]).toEqual(bars.map((bar) => bar.high));
    expect(values[2]).toEqual(bars.map((bar) => bar.low));
    expect(values[3]).toEqual(bars.map((bar) => bar.close));
  });

  it('take the highest of the four as the high and the lowest as the low', () => {
    // "The maximal value … will be set as 'high', and the minimal value … as 'low'."
    const values = plots(indicator('plotbar(close, low, high, open)'), bars);
    expect(values[1]).toEqual(bars.map((bar) => bar.high));
    expect(values[2]).toEqual(bars.map((bar) => bar.low));
  });

  it('draw no bar where any of the four is na', () => {
    const values = plots(
      indicator('plotcandle(open, high, bar_index == 2 ? na : low, close)'),
      bars,
    );
    expect(values.map((series) => Number.isNaN(series[2]))).toEqual([true, true, true, true]);
    expect(values[0]?.[1]).toBe(bars[1]?.open);
  });

  it('draw a candle’s wick dark gray and its border black unless the script colors them', () => {
    const plain = program(indicator('plotcandle(open, high, low, close)')).describe([]).plots;
    expect(plain[0]?.color).toBe(COLORS.blue);
    expect(plain[1]?.color).toBe(CANDLE_WICK);
    expect(plain[2]?.color).toBe(CANDLE_BORDER);
    expect(CANDLE_WICK).toBe(hexColor('#737375'));
    const given = program(
      indicator(
        'plotcandle(open, high, low, close, color = color.teal, wickcolor = color.gray, bordercolor = color.navy)',
      ),
    ).describe([]).plots;
    expect([given[0]?.color, given[1]?.color, given[2]?.color]).toEqual([
      COLORS.teal,
      COLORS.gray,
      COLORS.navy,
    ]);
  });

  it('keep each bar’s colors when they change: the body’s, the wick’s and the border’s', () => {
    const source = indicator(
      'c = close > open ? color.green : color.red\nplotcandle(open, high, low, close, color = c, wickcolor = c, bordercolor = c)',
    );
    const p = program(source);
    expect(
      p
        .describe([])
        .plots.slice(0, 3)
        .map((plot) => plot.colorChanges),
    ).toEqual([true, true, true]);
    const run = runScript(source, bars);
    for (const part of [0, 1, 2]) {
      expect(run.plotColors[part]?.[1]).toBe(COLORS.green);
      expect(run.plotColors[part]?.[2]).toBe(COLORS.red);
    }
  });

  it('color a plotbar all in its own color', () => {
    const [bar, high, low] = program(
      indicator('plotbar(open, high, low, close, color = color.orange)'),
    ).describe([]).plots;
    expect([bar?.color, high?.color, low?.color]).toEqual([
      COLORS.orange,
      COLORS.orange,
      COLORS.orange,
    ]);
  });
});

describe('barcolor', () => {
  it('colors the chart’s bars, not the pane: a background marked as bars', () => {
    const source = indicator(
      'barcolor(close > open ? color.yellow : na, offset = 1, title = "Up bars")',
    );
    const [background] = program(source).describe([]).backgrounds;
    expect(background).toMatchObject({
      bars: true,
      colorChanges: true,
      offset: 1,
      title: 'Up bars',
    });
    const run = runScript(source, bars);
    const colors = Array.from(run.backgrounds[0] ?? []).slice(0, bars.length);
    expect(colors.map((color) => (Number.isNaN(color) ? null : color))).toEqual([
      null,
      COLORS.yellow,
      null,
      COLORS.yellow,
      null,
    ]);
  });

  it('keeps bgcolor() a background', () => {
    const [background] = program(indicator('bgcolor(color.red)')).describe([]).backgrounds;
    expect(background?.bars).toBe(false);
  });
});
