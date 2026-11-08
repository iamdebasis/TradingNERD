import { Args, type Call, constant, type Fold, type Handler, type NumEv } from './args.ts';
import type { Compiler, MarkDef, PlotDef } from './compiler.ts';
import type { Span } from './diagnostics.ts';
import { CONST, type Compiled, INPUT, isNumeric } from './types.ts';
import { COLORS, hexColor } from './values.ts';

/**
 * A candle's wick and border unless the script gives them: dark gray and black, as TradingView's
 * figures of plotcandle in the Pine manual draw them (Bar plotting, Figure 99; Custom contexts,
 * Figure 192) and as the Charting Library's example of OHLC plots sets them (measured 2026-11-01;
 * provisional on the dark theme, docs/SPEC.md §11).
 */
export const CANDLE_WICK = hexColor('#737375');
export const CANDLE_BORDER = hexColor('#000000');

/**
 * Pine's marks and bars (Pine docs: Text and shapes; Bar plotting; Bar coloring; the v6
 * reference): plotshape, plotchar and plotarrow draw a mark on the bars a series picks;
 * plotcandle and plotbar draw candles and bars of four series; barcolor colors the chart's own
 * bars. They are plots to the engine: one value per bar (what the legend shows) and a color.
 */

/** plotshape's styles (shape.*), in the manual's order. */
export const SHAPES = [
  'xcross',
  'cross',
  'circle',
  'triangleup',
  'triangledown',
  'flag',
  'arrowup',
  'arrowdown',
  'square',
  'diamond',
  'labelup',
  'labeldown',
] as const;
/** Where a mark sits (location.*). */
export const LOCATIONS = ['abovebar', 'belowbar', 'top', 'bottom', 'absolute'] as const;
/** Mark sizes (size.*). */
export const SIZES = ['auto', 'tiny', 'small', 'normal', 'large', 'huge'] as const;

/**
 * shape.*, location.* and size.* constants by name; null when the name isn't one. Each is a
 * plain "const string" in TradingView's v6 reference, so a script can keep one in a string
 * variable or offer them in input.string()'s options. Their text, the member's name, is ours:
 * the reference doesn't give it (provisional, docs/SPEC.md §11).
 */
export function markConstant(space: string, member: string, span: Span): Compiled | null {
  if (space === 'shape' && (SHAPES as readonly string[]).includes(member)) {
    return constant('string', member, span);
  }
  if (space === 'location' && (LOCATIONS as readonly string[]).includes(member)) {
    return constant('string', member, span);
  }
  if (space === 'size' && (SIZES as readonly string[]).includes(member)) {
    return constant('string', member, span);
  }
  return null;
}

/**
 * A mark's style, location or size: text that must be one of its constants' values. One that
 * isn't draws as the default would, with a warning when the script spells it out.
 */
function markText(
  c: Compiler,
  args: Args,
  name: string,
  allowed: readonly string[],
  fallback: string,
): Fold {
  const given = args.get(name);
  if (given?.literal && given.fold) {
    const value = given.fold({ inputs: [] });
    if (typeof value === 'string' && !allowed.includes(value)) {
      c.warn(`"${value}" isn't a value '${name}' knows: it draws as "${fallback}"`, given.span);
    }
  }
  const fold = args.foldedAs(name, 'string', fallback);
  return (env) => {
    const value = fold(env);
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
  };
}

/** A color argument: folded when it can't change from bar to bar, else read on each bar. */
function colorOf(args: Args, name: string, fallback: number) {
  const value = args.color(name);
  if (!value) return { fold: (() => fallback) as Fold, dynamic: false, ev: null };
  if (value.qual > INPUT) return { fold: (() => Number.NaN) as Fold, dynamic: true, ev: value.ev };
  return { fold: args.folded(name, fallback), dynamic: false, ev: null };
}

const constTitle = (args: Args) => String(args.constant('title', '', 'string') ?? '');
const constEditable = (args: Args) => args.constant('editable', true, 'bool') !== false;

/** A plot entry's fields that marks and bars don't use, at plot()'s defaults. */
function plotLike(
  c: Compiler,
  args: Args,
  call: Call,
  names: readonly string[],
): Omit<PlotDef, 'index' | 'kind' | 'title' | 'color'> {
  if (args.has('force_overlay') && args.constant('force_overlay', false, 'bool') === true) {
    c.warn("force_overlay comes later: this draws in the script's own pane", call.calleeSpan);
  }
  return {
    linewidth: () => 1,
    style: () => 'line',
    linestyle: () => 'solid',
    trackprice: () => false,
    histbase: () => 0,
    offset: names.includes('offset') ? args.foldedAs('offset', 'int', 0) : () => 0,
    join: () => false,
    editable: constEditable(args),
    showLast: args.foldedAs('show_last', 'int', Number.NaN),
    display: args.foldedAs('display', 'int', 31),
    format: args.foldedAs('format', 'string', null),
    precision: args.foldedAs('precision', 'int', Number.NaN),
    span: call.span,
  };
}

/** A hidden part: one more value array (and color array) for an output. */
function part(c: Compiler, color: { fold: Fold; dynamic: boolean }, span: Span): number {
  const index = c.plots.length;
  c.plots.push({
    index,
    kind: 'part',
    title: '',
    color,
    linewidth: () => 1,
    style: () => 'line',
    linestyle: () => 'solid',
    trackprice: () => false,
    histbase: () => 0,
    offset: () => 0,
    join: () => false,
    editable: false,
    showLast: () => Number.NaN,
    display: () => 0,
    format: () => null,
    precision: () => Number.NaN,
    span,
  });
  return index;
}

const MARK_NAMES = {
  shape: [
    'series',
    'title',
    'style',
    'location',
    'color',
    'offset',
    'text',
    'textcolor',
    'editable',
    'size',
    'show_last',
    'display',
    'format',
    'precision',
    'force_overlay',
  ],
  char: [
    'series',
    'title',
    'char',
    'location',
    'color',
    'offset',
    'text',
    'textcolor',
    'editable',
    'size',
    'show_last',
    'display',
    'format',
    'precision',
    'force_overlay',
  ],
  arrow: [
    'series',
    'title',
    'colorup',
    'colordown',
    'offset',
    'minheight',
    'maxheight',
    'editable',
    'show_last',
    'display',
    'format',
    'precision',
    'force_overlay',
  ],
} as const;

/**
 * plotshape(), plotchar() and plotarrow(). The value each bar keeps is the series' own (a bool's
 * 1 or 0, as TradingView's legend shows "1.00": Pine manual, Text and shapes); a shape or char
 * shows where it's true (not na nor 0), or at the value with location.absolute; an arrow points
 * up for a positive value, down for a negative one.
 */
function markCall(kind: 'shape' | 'char' | 'arrow'): Handler {
  return (c, call, scope) => {
    const args = new Args(c, call, scope, MARK_NAMES[kind], 1);
    const seriesArg = args.get('series') as Compiled;
    const isBool = seriesArg.base === 'bool';
    c.needType(
      seriesArg,
      isBool || isNumeric(seriesArg.base) || seriesArg.base === 'na',
      call.callee,
      'series',
      kind === 'arrow' ? 'series float' : 'series bool',
    );
    const ev = seriesArg.ev;
    const value: NumEv = isBool ? (rt) => ((ev(rt) as boolean) ? 1 : 0) : (rt) => ev(rt) as number;
    const index = c.plots.length;
    // color.blue is the default color (the manual's images of every shape show it).
    const color =
      kind === 'arrow'
        ? { fold: (() => Number.NaN) as Fold, dynamic: true, ev: null }
        : colorOf(args, 'color', COLORS.blue as number);
    // The text takes the mark's color unless given: the Pine manual's "Lift text" figure writes
    // each letter in its shape's color (measured 2026-11-01; provisional for plotchar, §11).
    const textColor =
      kind === 'arrow'
        ? { fold: (() => Number.NaN) as Fold, dynamic: false, ev: null }
        : args.has('textcolor')
          ? colorOf(args, 'textcolor', COLORS.blue as number)
          : color;
    const sameText = textColor === color;
    // plotarrow's colors, not in the reference's text: color.lime and color.red, as the Pine
    // manual's Figure 289 draws plotarrow(osc) in pure lime and red, which those constants were
    // when it was made (measured 2026-11-01; provisional, §11).
    const up = kind === 'arrow' ? colorOf(args, 'colorup', COLORS.lime as number) : null;
    const down = kind === 'arrow' ? colorOf(args, 'colordown', COLORS.red as number) : null;
    const mark: MarkDef = {
      shape: kind === 'shape' ? markText(c, args, 'style', SHAPES, 'xcross') : () => null,
      // plotchar's default character isn't in the reference's text: ★ (provisional, §11).
      char: kind === 'char' ? args.foldedAs('char', 'string', '★') : () => null,
      location:
        kind === 'arrow' ? () => 'absolute' : markText(c, args, 'location', LOCATIONS, 'abovebar'),
      size: kind === 'arrow' ? () => 'auto' : markText(c, args, 'size', SIZES, 'auto'),
      text: kind === 'arrow' ? '' : String(args.constant('text', '', 'string') ?? ''),
      textColor: { fold: textColor.fold, dynamic: textColor.dynamic },
      textPart: null,
      // The reference's defaults: 5 and 100 px.
      minheight: kind === 'arrow' ? args.foldedAs('minheight', 'int', 5) : () => 5,
      maxheight: kind === 'arrow' ? args.foldedAs('maxheight', 'int', 100) : () => 100,
    };
    c.plots.push({
      index,
      kind,
      title: constTitle(args),
      color: { fold: color.fold, dynamic: color.dynamic },
      mark,
      ...plotLike(c, args, call, MARK_NAMES[kind]),
    });
    // Text colors that change from bar to bar: the mark's own when they are its color, else a
    // part of their own.
    if (textColor.dynamic) {
      mark.textPart = sameText
        ? index
        : part(c, { fold: () => Number.NaN, dynamic: true }, call.span);
    }
    const textPart = mark.textPart;
    const colorEv = color.ev;
    const textEv = sameText ? null : textColor.ev;
    const upEv = up?.ev ?? null;
    const downEv = down?.ev ?? null;
    const upFold = up?.fold;
    const downFold = down?.fold;
    return {
      base: 'void',
      qual: CONST,
      ev: (rt) => {
        const v = value(rt);
        (rt.outputs.plots[index] as Float64Array)[rt.index] = v;
        if (kind === 'arrow') {
          // An arrow's color follows its direction.
          const pick =
            v >= 0
              ? upEv
                ? (upEv(rt) as number)
                : ((upFold as Fold)({ inputs: rt.inputs }) as number)
              : downEv
                ? (downEv(rt) as number)
                : ((downFold as Fold)({ inputs: rt.inputs }) as number);
          (rt.outputs.plotColors[index] as Float64Array)[rt.index] = pick;
        } else if (colorEv) {
          (rt.outputs.plotColors[index] as Float64Array)[rt.index] = colorEv(rt) as number;
        }
        if (textEv && textPart !== null) {
          (rt.outputs.plotColors[textPart] as Float64Array)[rt.index] = textEv(rt) as number;
        }
        return null;
      },
      span: call.span,
    };
  };
}

const CANDLE_NAMES = [
  'open',
  'high',
  'low',
  'close',
  'title',
  'color',
  'wickcolor',
  'editable',
  'show_last',
  'bordercolor',
  'display',
  'format',
  'precision',
  'force_overlay',
] as const;
const BAR_NAMES = [
  'open',
  'high',
  'low',
  'close',
  'title',
  'color',
  'editable',
  'show_last',
  'display',
  'format',
  'precision',
  'force_overlay',
] as const;

/**
 * plotcandle() and plotbar(): a candle or bar of four series on each bar, none where one is na;
 * the largest of the four is its high and the smallest its low (the v6 reference). The opens are
 * the entry's own values; the high, low and close are its parts', whose color arrays carry the
 * wick and border colors.
 */
function candleCall(kind: 'candle' | 'bar'): Handler {
  return (c, call, scope) => {
    const names = kind === 'candle' ? CANDLE_NAMES : BAR_NAMES;
    const args = new Args(c, call, scope, names, 4);
    const series = (['open', 'high', 'low', 'close'] as const).map((name) => {
      const value = args.get(name) as Compiled;
      c.needType(
        value,
        isNumeric(value.base) || value.base === 'na',
        call.callee,
        name,
        'series float',
      );
      return value.ev as NumEv;
    }) as [NumEv, NumEv, NumEv, NumEv];
    // "This plots simple candles, all in blue" (Pine manual, Bar plotting).
    const color = colorOf(args, 'color', COLORS.blue as number);
    const index = c.plots.length;
    c.plots.push({
      index,
      kind,
      title: constTitle(args),
      color: { fold: color.fold, dynamic: color.dynamic },
      ...plotLike(c, args, call, names),
    });
    // A candle's wick and border: the script's, else dark gray and black (CANDLE_WICK,
    // CANDLE_BORDER); a bar has neither, its parts carry its own color.
    const wick =
      kind === 'candle' && args.has('wickcolor') ? colorOf(args, 'wickcolor', Number.NaN) : null;
    const border =
      kind === 'candle' && args.has('bordercolor')
        ? colorOf(args, 'bordercolor', Number.NaN)
        : null;
    const fixed = (value: number) => ({ fold: () => value, dynamic: false });
    const high = part(
      c,
      wick
        ? { fold: wick.fold, dynamic: wick.dynamic }
        : kind === 'candle'
          ? fixed(CANDLE_WICK)
          : { fold: color.fold, dynamic: color.dynamic },
      call.span,
    );
    const low = part(
      c,
      border
        ? { fold: border.fold, dynamic: border.dynamic }
        : kind === 'candle'
          ? fixed(CANDLE_BORDER)
          : { fold: color.fold, dynamic: color.dynamic },
      call.span,
    );
    const close = part(c, { fold: () => Number.NaN, dynamic: false }, call.span);
    (c.plots[index] as PlotDef & { parts?: readonly [number, number, number] }).parts = [
      high,
      low,
      close,
    ];
    const [o, h, l, cl] = series;
    const colorEv = color.ev;
    // Per-bar colors only where they change: the defaults are fixed.
    const wickEv = wick ? (wick.ev ?? null) : kind === 'candle' ? null : colorEv;
    const borderEv = border ? (border.ev ?? null) : kind === 'candle' ? null : colorEv;
    return {
      base: 'void',
      qual: CONST,
      ev: (rt) => {
        const values = [o(rt), h(rt), l(rt), cl(rt)];
        const na = values.some((v) => Number.isNaN(v));
        const plots = rt.outputs.plots;
        const at = rt.index;
        (plots[index] as Float64Array)[at] = na ? Number.NaN : (values[0] as number);
        (plots[high] as Float64Array)[at] = na ? Number.NaN : Math.max(...values);
        (plots[low] as Float64Array)[at] = na ? Number.NaN : Math.min(...values);
        (plots[close] as Float64Array)[at] = na ? Number.NaN : (values[3] as number);
        const colors = rt.outputs.plotColors;
        if (colorEv) (colors[index] as Float64Array)[at] = colorEv(rt) as number;
        if (wickEv && colors[high]) (colors[high] as Float64Array)[at] = wickEv(rt) as number;
        if (borderEv && colors[low]) (colors[low] as Float64Array)[at] = borderEv(rt) as number;
        return null;
      },
      span: call.span,
    };
  };
}

/** barcolor(): the chart's bars take the color, from any pane (Pine docs, Bar coloring). */
const barcolorCall: Handler = (c, call, scope) => {
  const names = ['color', 'offset', 'editable', 'show_last', 'title', 'display'];
  const args = new Args(c, call, scope, names, 1);
  const color = args.color('color') as Compiled;
  const index = c.bgcolors.length;
  const dynamic = color.qual > INPUT;
  c.bgcolors.push({
    index,
    bars: true,
    color: { fold: dynamic ? () => Number.NaN : args.folded('color', Number.NaN), dynamic },
    offset: args.foldedAs('offset', 'int', 0),
    editable: constEditable(args),
    showLast: args.foldedAs('show_last', 'int', Number.NaN),
    title: constTitle(args),
    display: args.foldedAs('display', 'int', 31),
    span: call.span,
  });
  const ev = color.ev;
  return {
    base: 'void',
    qual: CONST,
    ev: (rt) => {
      (rt.outputs.backgrounds[index] as Float64Array)[rt.index] = ev(rt) as number;
      return null;
    },
    span: call.span,
  };
};

export function markCalls(): Record<string, Handler> {
  return {
    plotshape: markCall('shape'),
    plotchar: markCall('char'),
    plotarrow: markCall('arrow'),
    plotcandle: candleCall('candle'),
    plotbar: candleCall('bar'),
    barcolor: barcolorCall,
  };
}
