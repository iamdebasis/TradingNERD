import { SOURCES, type SourceName, sourceValue } from '@tradingnerd/indicators';
import {
  Args,
  type Call,
  constant,
  type Ev,
  type Fold,
  type Handler,
  type NumEv,
  series,
  simple,
} from './args.ts';
import type { Arg } from './ast.ts';
import { collectionCalls } from './collections.ts';
import type { Compiler, Scope } from './compiler.ts';
import { PineRuntimeError, type Span } from './diagnostics.ts';
import type { Runtime } from './runtime.ts';
import {
  AtrFn,
  BarssinceFn,
  BbFn,
  BoolChangeFn,
  CciFn,
  ChangeFn,
  CrossFn,
  CumFn,
  DevFn,
  DynamicSma,
  ExtremeFn,
  emaFn,
  FixnanFn,
  MacdFn,
  PivotFn,
  RsiFn,
  rmaFn,
  StdevFn,
  StochFn,
  SumFn,
  SwmaFn,
  smaFn,
  TrendFn,
  TrFn,
  ValuewhenFn,
  VwmaFn,
  wmaFn,
} from './ta.ts';
import {
  type Base,
  CONST,
  type Compiled,
  castTo,
  type FoldEnv,
  INPUT,
  isNumeric,
  maxQual,
  naOf,
  type Qual,
  SERIES,
  SIMPLE,
  typeName,
  unify,
} from './types.ts';
import {
  COLORS,
  fromGradient,
  hexColor,
  isOutputRef,
  type OutputRef,
  packColor,
  unpackColor,
  type Value,
  withTransparency,
} from './values.ts';

/** Pine's display flags (the v6 reference's display.* constants). */
export const DISPLAY = {
  none: 0,
  pane: 1,
  data_window: 2,
  status_line: 4,
  price_scale: 8,
  pine_screener: 16,
  all: 31,
} as const;

/** plot.style_*, as the constants' values (the v6 reference). */
export const PLOT_STYLES = [
  'line',
  'linebr',
  'stepline',
  'stepline_diamond',
  'steplinebr',
  'histogram',
  'cross',
  'area',
  'areabr',
  'columns',
  'circles',
] as const;
export type PlotStyle = (typeof PLOT_STYLES)[number];
/** hline.style_* and plot.linestyle_*. */
export const LINE_STYLES = ['solid', 'dotted', 'dashed'] as const;
export type LineStyle = (typeof LINE_STYLES)[number];
/** format.*: Pine's own strings. */
export const FORMATS = ['inherit', 'price', 'volume', 'percent', 'mintick'] as const;
export type ScriptFormat = (typeof FORMATS)[number];

/**
 * What tradingNerd doesn't run yet, in plain words (no milestone codes): the editor shows these
 * where TradingView would run the script.
 */
const LATER: readonly [RegExp, string][] = [
  [
    /^(plotshape|plotchar|plotarrow|plotbar|plotcandle|barcolor)$/,
    "isn't supported in tradingNerd yet",
  ],
  [
    /^(label|line|box|table|polyline|linefill|chart\.point)\./,
    "isn't supported in tradingNerd yet: drawings (labels, lines, boxes, tables) come in a later update",
  ],
  [
    /^request\./,
    "isn't supported in tradingNerd yet: data from other symbols and timeframes comes in a later update",
  ],
  [
    /^strategy(\.|$)/,
    "isn't supported in tradingNerd yet: strategies come with the Strategy Tester in a later update",
  ],
  [/^log\./, "isn't supported in tradingNerd yet"],
  [
    /^(str\.(format|split|replace|replace_all|contains|substring|length|lower|upper|pos|match|repeat|trim|startswith|endswith|tonumber)|str\.format_time)$/,
    "isn't supported in tradingNerd yet",
  ],
  [
    /^input\.(timeframe|symbol|session|time|price|text_area|enum)$/,
    "isn't supported in tradingNerd yet",
  ],
  [
    /^(time|time_close|timestamp|year|month|weekofyear|dayofmonth|dayofweek|hour|minute|second)$/,
    "isn't supported in tradingNerd yet",
  ],
];

/** A bar's value by name: open … hlcc4, time, bar_index. */
function barValue(name: string): ((rt: Runtime, k: number) => number) | null {
  if ((SOURCES as readonly string[]).includes(name) || name === 'volume') {
    return (rt, k) => {
      const bar = rt.barBack(k);
      if (!bar) return Number.NaN;
      if (name === 'volume') return rt.symbol.hasVolume ? bar.volume : Number.NaN;
      return sourceValue(bar, name as SourceName);
    };
  }
  if (name === 'time') {
    return (rt, k) => {
      const bar = rt.barBack(k);
      return bar ? (bar.start ?? bar.time * 1000) : Number.NaN;
    };
  }
  if (name === 'bar_index') {
    return (rt, k) => (rt.index - k >= rt.start ? rt.index - k - rt.start : Number.NaN);
  }
  return null;
}

const isIntraday = (tf: string) => /^\d+$/.test(tf) || /S$/.test(tf) || /T$/.test(tf);

/** Pine v5's values for the colors v6 changed (v6 migration guide: Color changes). */
const V5_COLORS: Readonly<Record<string, number>> = {
  red: hexColor('#FF5252'),
  teal: hexColor('#00897B'),
  yellow: hexColor('#FFEB3B'),
};

/** Built-in variables and constants by name; null when the name isn't one. */
export function compileBuiltinName(c: Compiler, name: string, span: Span): Compiled | null {
  const bar = barValue(name);
  if (bar) {
    const base: Base = name === 'time' || name === 'bar_index' ? 'int' : 'float';
    return series(base, (rt) => bar(rt, 0), span);
  }
  const dot = name.indexOf('.');
  const space = dot < 0 ? '' : name.slice(0, dot);
  const member = dot < 0 ? name : name.slice(dot + 1);
  switch (space) {
    case 'color': {
      // v5 and older had other values for three of them (v6 guide: Color changes).
      const value = (c.version <= 5 ? V5_COLORS[member] : undefined) ?? COLORS[member];
      if (value !== undefined) return constant('color', value, span);
      break;
    }
    case 'order':
      if (member === 'ascending' || member === 'descending') {
        return constant('order_style', member, span);
      }
      break;
    case 'plot':
      if (
        member.startsWith('style_') &&
        (PLOT_STYLES as readonly string[]).includes(member.slice(6))
      ) {
        return constant('plot_style', member.slice(6), span);
      }
      if (
        member.startsWith('linestyle_') &&
        (LINE_STYLES as readonly string[]).includes(member.slice(10))
      ) {
        return constant('plot_line_style', member.slice(10), span);
      }
      break;
    case 'hline':
      if (
        member.startsWith('style_') &&
        (LINE_STYLES as readonly string[]).includes(member.slice(6))
      ) {
        return constant('hline_style', member.slice(6), span);
      }
      break;
    case 'display':
      if (member in DISPLAY) return constant('int', DISPLAY[member as keyof typeof DISPLAY], span);
      break;
    case 'format':
      if ((FORMATS as readonly string[]).includes(member)) return constant('string', member, span);
      break;
    case 'math': {
      const values: Record<string, number> = {
        pi: Math.PI,
        e: Math.E,
        phi: (1 + Math.sqrt(5)) / 2,
        rphi: (Math.sqrt(5) - 1) / 2,
      };
      if (member in values) return constant('float', values[member] as number, span);
      break;
    }
    case 'barstate':
      return barstate(member, span);
    case 'timeframe':
      return timeframe(member, span, c.version);
    case 'syminfo':
      return syminfo(member, span);
    case 'ta':
      if (member === 'tr') {
        // The true range against the bar before; na on the first (ta.tr(false)).
        return series(
          'float',
          (rt) => {
            const bar = rt.bar;
            const before = rt.barBack(1);
            if (!before) return Number.NaN;
            return Math.max(
              bar.high - bar.low,
              Math.abs(bar.high - before.close),
              Math.abs(bar.low - before.close),
            );
          },
          span,
        );
      }
      break;
    default:
      if (name === 'last_bar_index')
        return series('int', (rt) => rt.bars.length - 1 - rt.start, span);
      break;
  }
  if (LATER.some(([pattern]) => pattern.test(name))) {
    return c.fail(`"${name}" ${laterMessage(name)}`, span);
  }
  return null;
}

function laterMessage(name: string): string {
  const match = LATER.find(([pattern]) => pattern.test(name));
  return match ? match[1] : "isn't supported yet";
}

function barstate(member: string, span: Span): Compiled | null {
  // The v6 reference's barstate.*: the last bar is the live one, realtime from the bar that was
  // live when the bars were loaded; its closing update is the confirmed one.
  const reads: Record<string, (rt: Runtime) => boolean> = {
    isfirst: (rt) => rt.index === rt.start,
    islast: (rt) => rt.index === rt.bars.length - 1,
    isconfirmed: (rt) => rt.final,
    isrealtime: (rt) => rt.index >= rt.realtimeFrom,
    ishistory: (rt) => rt.index < rt.realtimeFrom,
    isnew: (rt) => rt.isNew,
    islastconfirmedhistory: (rt) => rt.index === rt.realtimeFrom - 1,
  };
  const read = reads[member];
  return read ? series('bool', read, span) : null;
}

function timeframe(member: string, span: Span, version: number): Compiled | null {
  const tf = (rt: Runtime) => rt.symbol.timeframe;
  switch (member) {
    case 'period':
      // v5 and older wrote a multiplier of 1 as nothing: "D", not "1D" (v6 migration guide).
      return simple('string', version <= 5 ? (rt) => tf(rt).replace(/^1([DWM])$/, '$1') : tf, span);
    case 'multiplier':
      return simple('int', (rt) => Number.parseInt(tf(rt), 10) || 1, span);
    case 'isintraday':
      return simple('bool', (rt) => isIntraday(tf(rt)), span);
    case 'isdaily':
      return simple('bool', (rt) => /D$/.test(tf(rt)), span);
    case 'isweekly':
      return simple('bool', (rt) => /W$/.test(tf(rt)), span);
    case 'ismonthly':
      return simple('bool', (rt) => /M$/.test(tf(rt)), span);
    case 'isdwm':
      return simple('bool', (rt) => /[DWM]$/.test(tf(rt)), span);
    case 'isseconds':
      return simple('bool', (rt) => /S$/.test(tf(rt)), span);
    case 'isticks':
      return simple('bool', (rt) => /T$/.test(tf(rt)), span);
    case 'isminutes':
      return simple('bool', (rt) => /^\d+$/.test(tf(rt)), span);
    default:
      return null;
  }
}

function syminfo(member: string, span: Span): Compiled | null {
  switch (member) {
    case 'ticker':
    case 'tickerid':
    case 'description':
    case 'type':
    case 'basecurrency':
    case 'currency':
      return simple('string', (rt) => rt.symbol[member], span);
    case 'mintick':
      return simple('float', (rt) => rt.symbol.mintick, span);
    case 'pricescale':
      return simple('int', (rt) => Math.round(1 / rt.symbol.mintick), span);
    default:
      return null;
  }
}

/** `close[3]`, `bar_index[1]`: straight from the chart's bars. */
export function compileHistoryOfBuiltin(
  _c: Compiler,
  name: string,
  offset: Compiled,
  span: Span,
): Compiled | null {
  const bar = barValue(name);
  if (!bar) return null;
  const k = offset.ev as NumEv;
  const base: Base = name === 'time' || name === 'bar_index' ? 'int' : 'float';
  return series(
    base,
    (rt) => {
      const n = k(rt);
      if (!(n >= 0))
        throw new PineRuntimeError(
          `Invalid history reference [${n}]: the offset must be 0 or more`,
          span,
        );
      return bar(rt, Math.floor(n));
    },
    span,
  );
}

// ---- calls ----

export function compileCall(c: Compiler, call: Call, scope: Scope): Compiled {
  const fn = call.callee;
  const later = LATER.find(([pattern]) => pattern.test(fn));
  if (later) return c.fail(`"${fn}" ${later[1]}`, call.calleeSpan);
  const handler = CALLS[fn];
  if (!handler) {
    return c.fail(`Could not find function or function reference '${fn}'`, call.calleeSpan);
  }
  return handler(c, call, scope);
}

const CALLS: Record<string, Handler> = {
  indicator: indicatorCall,
  library: libraryCall,
  strategy: (c, call) =>
    c.fail(
      '"strategy" isn\'t supported in tradingNerd yet: strategies come with the Strategy Tester in a later update',
      call.calleeSpan,
    ),
  // v4's iff(): both values are worked out on every bar, then one picked (v5 guide).
  __iff: (c, call, scope) => {
    const args = new Args(c, call, scope, ['condition', 'then', 'else'], 3);
    const cond = c.condition(args.get('condition') as Compiled);
    const then = args.get('then') as Compiled;
    const otherwise = args.get('else') as Compiled;
    const base = unify(then.base, otherwise.base);
    if (!base) {
      return c.fail(
        `iff()'s two values must have the same type, not '${then.base}' and '${otherwise.base}'`,
        call.span,
      );
    }
    const cv = cond.ev;
    const t = castTo(then, base);
    const o = castTo(otherwise, base);
    return {
      base,
      qual: maxQual(cond.qual, then.qual, otherwise.qual),
      ev: (rt) => {
        const x = t(rt);
        const y = o(rt);
        return (cv(rt) as boolean) ? x : y;
      },
      span: call.span,
    };
  },
  // v4's rsi(x, y): RSI for an int length; with a float, MFI's formula (v5 guide).
  __rsi_v4: (c, call, scope) => {
    const second = call.args[1];
    const kind = second ? c.expr(second.value, scope).base : 'int';
    if (kind === 'int')
      return (CALLS['ta.rsi'] as Handler)(c, { ...call, callee: 'ta.rsi' }, scope);
    const args = new Args(c, call, scope, ['x', 'y'], 2);
    const x = args.number('x') as NumEv;
    const y = args.number('y') as NumEv;
    return series('float', (rt) => 100 - 100 / (1 + x(rt) / y(rt)), call.span);
  },
  input: (c, call, scope) => inputCall(c, call, scope, null),
  'input.int': (c, call, scope) => inputCall(c, call, scope, 'int'),
  'input.float': (c, call, scope) => inputCall(c, call, scope, 'float'),
  'input.bool': (c, call, scope) => inputCall(c, call, scope, 'bool'),
  'input.string': (c, call, scope) => inputCall(c, call, scope, 'string'),
  'input.color': (c, call, scope) => inputCall(c, call, scope, 'color'),
  'input.source': (c, call, scope) => inputCall(c, call, scope, 'source'),
  plot: plotCall,
  hline: hlineCall,
  fill: fillCall,
  bgcolor: bgcolorCall,
  alertcondition: (c, call, scope) => {
    const args = new Args(c, call, scope, ['condition', 'title', 'message'], 1);
    args.bool('condition');
    return { base: 'void', qual: CONST, ev: () => null, span: call.span };
  },
  max_bars_back: (_c, call) => ({ base: 'void', qual: CONST, ev: () => null, span: call.span }),
  'runtime.error': (c, call, scope) => {
    const args = new Args(c, call, scope, ['message'], 1);
    const message = args.string('message');
    const ev = message?.ev ?? (() => '');
    return {
      base: 'void',
      qual: SERIES,
      ev: (rt) => {
        throw new PineRuntimeError(String(ev(rt) ?? 'na'), call.span);
      },
      span: call.span,
    };
  },
  na: (c, call, scope) => {
    const args = new Args(c, call, scope, ['x'], 1);
    const x = args.get('x') as Compiled;
    const ev = x.ev;
    if (x.base === 'bool' && c.version >= 6) {
      c.fail("na() doesn't take a bool in Pine v6: a bool is always true or false", x.span);
    }
    const isNa =
      x.base === 'bool'
        ? () => false
        : isNumeric(x.base) || x.base === 'color'
          ? (v: Value) => typeof v === 'number' && Number.isNaN(v)
          : (v: Value) => v === null || (typeof v === 'number' && Number.isNaN(v));
    return {
      base: 'bool',
      qual: x.qual,
      ev: (rt) => isNa(ev(rt)),
      fold: x.fold && ((env) => isNa((x.fold as (env: FoldEnv) => Value)(env))),
      span: call.span,
    };
  },
  nz: (c, call, scope) => {
    const args = new Args(c, call, scope, ['source', 'replacement'], 1);
    const source = args.get('source') as Compiled;
    const replacement = args.get('replacement');
    const base: Base = source.base === 'na' ? (replacement?.base ?? 'float') : source.base;
    const isString = base === 'string';
    const fallback: Value = isString ? '' : base === 'bool' ? false : 0;
    const s = source.ev;
    const r = replacement?.ev ?? (() => fallback);
    const pick = (value: Value, rt: Runtime | null, env: FoldEnv | null): Value => {
      const missing = isString ? value === null : typeof value === 'number' && Number.isNaN(value);
      if (!missing) return value;
      if (rt) return r(rt);
      return replacement?.fold?.(env as FoldEnv) ?? fallback;
    };
    const resultBase: Base =
      replacement && replacement.base === 'float' && base === 'int' ? 'float' : base;
    return {
      base: resultBase,
      qual: maxQual(source.qual, replacement?.qual ?? CONST),
      ev: (rt) => pick(s(rt), rt, null),
      fold:
        source.fold && (!replacement || replacement.fold)
          ? (env) => pick((source.fold as (env: FoldEnv) => Value)(env), null, env)
          : undefined,
      span: call.span,
    };
  },
  fixnan: (c, call, scope) => {
    const args = new Args(c, call, scope, ['source'], 1);
    if (args.get('source')?.base === 'bool' && c.version >= 6) {
      c.fail("fixnan() doesn't take a bool in Pine v6", call.span);
    }
    const source = args.number('source') as NumEv;
    const fn = c.rt.register(new FixnanFn());
    return series('float', (rt) => fn.call(source(rt), rt.final), call.span);
  },
  int: (c, call, scope) => cast(c, call, scope, 'int'),
  float: (c, call, scope) => cast(c, call, scope, 'float'),
  bool: (c, call, scope) => cast(c, call, scope, 'bool'),
  color: (c, call, scope) => cast(c, call, scope, 'color'),
  string: (c, call, scope) => cast(c, call, scope, 'string'),
  'str.tostring': (c, call, scope) => {
    const args = new Args(c, call, scope, ['value', 'format'], 1);
    const value = args.get('value') as Compiled;
    const ev = value.ev;
    const show = (v: Value): Value =>
      v === null || (typeof v === 'number' && Number.isNaN(v))
        ? 'NaN'
        : typeof v === 'number'
          ? String(v)
          : String(v);
    return {
      base: 'string',
      qual: value.qual,
      ev: (rt) => show(ev(rt)),
      fold: value.fold && ((env) => show((value.fold as (env: FoldEnv) => Value)(env))),
      span: call.span,
    };
  },
  ...mathCalls(),
  ...colorCalls(),
  ...taCalls(),
  ...collectionCalls(),
};

/** Whether a built-in function of this full name exists (`array.push`, `ta.sma`). */
export const isBuiltinNamespace = (name: string): boolean => name in CALLS;

/** Where a value's built-in methods live: `arr.push()` is `array.push(arr)`. */
export function methodNamespace(base: Base): string | null {
  if (base.startsWith('array<')) return 'array';
  if (base.startsWith('matrix<')) return 'matrix';
  if (base.startsWith('map<')) return 'map';
  if (['label', 'line', 'box', 'table', 'linefill', 'polyline', 'chart.point'].includes(base)) {
    return base;
  }
  return null;
}

/** int(), float(), bool(), color(), string(): Pine's casts. */
function cast(c: Compiler, call: Call, scope: Scope, to: Base): Compiled {
  const args = new Args(c, call, scope, ['x'], 1);
  const x = args.get('x') as Compiled;
  const from = x.base;
  const ok =
    from === 'na' ||
    from === to ||
    (to === 'int' && from === 'float') ||
    (to === 'float' && from === 'int') ||
    (to === 'bool' && isNumeric(from));
  c.needType(x, ok, call.callee, 'x', to);
  const convert = (v: Value): Value => {
    if (from === 'na') return naOf(to);
    if (to === 'int') return Number.isNaN(v as number) ? Number.NaN : Math.trunc(v as number);
    if (to === 'bool' && from !== 'bool') return !Number.isNaN(v as number) && (v as number) !== 0;
    return v;
  };
  const ev = x.ev;
  return {
    base: to,
    qual: x.qual,
    ev: (rt) => convert(ev(rt)),
    fold: x.fold && ((env) => convert((x.fold as (env: FoldEnv) => Value)(env))),
    span: call.span,
  };
}

// ---- the declaration and inputs ----

function indicatorCall(c: Compiler, call: Call, scope: Scope): Compiled {
  if (c.indicator) c.fail('A script can only have one declaration statement', call.calleeSpan);
  const args = new Args(
    c,
    call,
    scope,
    [
      'title',
      'shorttitle',
      'overlay',
      'format',
      'precision',
      'scale',
      'max_bars_back',
      'timeframe',
      'timeframe_gaps',
      'explicit_plot_zorder',
      'max_lines_count',
      'max_labels_count',
      'max_boxes_count',
      'calc_bars_count',
      'max_polylines_count',
      'dynamic_requests',
      'behind_chart',
    ],
    1,
  );
  const title = String(args.constant('title', '', 'string') ?? '');
  const timeframe = args.constant('timeframe', '', 'string');
  if (timeframe !== '' && timeframe !== null) {
    c.fail(
      'An indicator on another timeframe isn\'t supported in tradingNerd yet: leave timeframe = ""',
      args.get('timeframe')?.span as Span,
    );
  }
  // scale and calc_bars_count are taken; the script draws on its own scale over every bar
  // (provisional, docs/SPEC.md §11).
  args.get('scale');
  args.get('calc_bars_count');
  const format = args.constant('format', 'inherit', 'string');
  if (!(FORMATS as readonly unknown[]).includes(format)) {
    c.fail(
      "'format' takes format.inherit, format.price, format.volume, format.percent or format.mintick",
      args.get('format')?.span as Span,
    );
  }
  // The v6 reference: a non-negative integer, at most 16.
  const precision = args.constant('precision', Number.NaN, 'int');
  if (
    typeof precision === 'number' &&
    !Number.isNaN(precision) &&
    !(precision >= 0 && precision <= 16)
  ) {
    c.fail("'precision' must be from 0 to 16", args.get('precision')?.span as Span);
  }
  c.indicator = {
    title,
    shorttitle: String(args.constant('shorttitle', '', 'string') ?? ''),
    overlay: args.constant('overlay', false, 'bool') === true,
    format: format as string,
    precision: typeof precision === 'number' && !Number.isNaN(precision) ? precision : null,
    library: false,
    span: call.span,
  };
  return { base: 'void', qual: CONST, ev: () => null, span: call.span };
}

/** library(): a library's declaration; on the chart it draws what its own code plots. */
function libraryCall(c: Compiler, call: Call, scope: Scope): Compiled {
  if (c.indicator) c.fail('A script can only have one declaration statement', call.calleeSpan);
  const args = new Args(c, call, scope, ['title', 'overlay', 'dynamic_requests'], 1);
  const title = String(args.constant('title', '', 'string') ?? '');
  c.indicator = {
    title,
    shorttitle: title,
    overlay: args.constant('overlay', false, 'bool') === true,
    format: 'inherit',
    precision: null,
    library: true,
    span: call.span,
  };
  return { base: 'void', qual: CONST, ev: () => null, span: call.span };
}

const INPUT_NAMES: Record<string, readonly string[]> = {
  int: [
    'defval',
    'title',
    'minval',
    'maxval',
    'step',
    'tooltip',
    'inline',
    'group',
    'confirm',
    'display',
    'active',
    'options',
  ],
  float: [
    'defval',
    'title',
    'minval',
    'maxval',
    'step',
    'tooltip',
    'inline',
    'group',
    'confirm',
    'display',
    'active',
    'options',
  ],
  bool: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  string: [
    'defval',
    'title',
    'options',
    'tooltip',
    'inline',
    'group',
    'confirm',
    'display',
    'active',
  ],
  color: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  source: ['defval', 'title', 'tooltip', 'inline', 'group', 'display', 'active'],
  generic: ['defval', 'title', 'tooltip', 'inline', 'group', 'display', 'active'],
};

/** input(), input.int() …: one field of the Inputs tab; its value comes from the settings. */
function inputCall(
  c: Compiler,
  call: Call,
  scope: Scope,
  kind: 'int' | 'float' | 'bool' | 'string' | 'color' | 'source' | null,
): Compiled {
  // input.int and input.float take options in third place when the call gives a list there.
  let names = INPUT_NAMES[kind ?? 'generic'] as readonly string[];
  // v4 and older: input() took minval, maxval, step and options whatever its type (v4 reference).
  if (kind === null && c.version <= 4) {
    names = [
      'defval',
      'title',
      'minval',
      'maxval',
      'confirm',
      'step',
      'options',
      'tooltip',
      'inline',
      'group',
      'display',
      'active',
    ];
  }
  const third = call.args[2];
  if (
    (kind === 'int' || kind === 'float') &&
    third &&
    third.name === null &&
    third.value.kind === 'list'
  ) {
    names = [
      'defval',
      'title',
      'options',
      'tooltip',
      'inline',
      'group',
      'confirm',
      'display',
      'active',
    ];
  }
  const args = new Args(c, call, scope, names, 1);
  const defvalArg = args.raw('defval') as Arg;
  let actual = kind;
  let defval: Value;
  if (
    actual === 'source' ||
    (actual === null && defvalArg.value.kind === 'name' && isSourceName(defvalArg.value.name))
  ) {
    if (defvalArg.value.kind !== 'name' || !isSourceName(defvalArg.value.name)) {
      return c.fail(
        `A source input's default must be one of ${SOURCES.join(', ')} (other indicators' outputs come later)`,
        defvalArg.span,
      );
    }
    actual = 'source';
    defval = defvalArg.value.name;
  } else {
    const value = args.get('defval') as Compiled;
    const base = value.base;
    if (actual === null) {
      if (
        base === 'int' ||
        base === 'float' ||
        base === 'bool' ||
        base === 'string' ||
        base === 'color'
      )
        actual = base;
      else return c.fail(`An input's default can't be '${typeName(value)}'`, value.span);
    }
    const ok = base === actual || (actual === 'float' && base === 'int');
    c.needType(value, ok, call.callee, 'defval', `const ${actual}`);
    defval = args.constant('defval', null);
  }
  const index = c.inputs.length;
  const optionsArg = names.includes('options') ? args.raw('options') : undefined;
  let options: Value[] | undefined;
  if (optionsArg) {
    if (optionsArg.value.kind !== 'list') {
      c.fail(`'options' takes a list in brackets: options = ["A", "B"]`, optionsArg.span);
    }
    options = optionsArg.value.items.map((item) => {
      const compiled = c.expr(item, scope);
      if (!compiled.fold || compiled.qual > CONST)
        c.fail('Each option must be a constant', item.span);
      return compiled.fold({ inputs: [] });
    });
    if (!options.includes(defval))
      c.fail(`The default "${String(defval)}" isn't one of the options`, defvalArg.span);
  }
  const num = (name: string) => {
    if (!names.includes(name)) return undefined;
    const value = args.constant(name, null, 'float');
    return typeof value === 'number' ? value : undefined;
  };
  const text = (name: string) => {
    if (!names.includes(name)) return undefined;
    const value = args.constant(name, null, 'string');
    return typeof value === 'string' ? value : undefined;
  };
  // Bool and color inputs stay out of the status line unless asked (Pine docs, Inputs).
  const displayFold = args.foldedAs(
    'display',
    'int',
    actual === 'bool' || actual === 'color' ? DISPLAY.none : DISPLAY.all,
  );
  const activeArg = args.get('active');
  if (activeArg) {
    c.needType(activeArg, activeArg.base === 'bool', call.callee, 'active', 'input bool');
    c.needQual(activeArg, INPUT, call.callee, 'active', 'bool');
  }
  const activeFold = activeArg?.fold;
  const def: (typeof c.inputs)[number] = {
    index,
    kind: actual,
    title: text('title') ?? '',
    defval,
    minval: num('minval'),
    maxval: num('maxval'),
    step: num('step'),
    options,
    tooltip: text('tooltip'),
    inline: text('inline'),
    group: text('group'),
    display: Number(displayFold({ inputs: [] })),
    active: activeFold ? (env) => activeFold(env) === true : undefined,
    span: call.span,
  };
  c.inputs.push(def);
  if (actual === 'source') {
    return {
      base: 'float',
      qual: SERIES,
      ev: (rt) => {
        const source = rt.inputs[index];
        return sourceValue(rt.bar, (isSourceName(source) ? source : 'close') as SourceName);
      },
      span: call.span,
    };
  }
  const base = actual as Base;
  return {
    base,
    qual: INPUT,
    ev: (rt) => rt.inputs[index] ?? defval,
    fold: (env) => env.inputs[index] ?? defval,
    span: call.span,
  };
}

const isSourceName = (value: unknown): boolean =>
  typeof value === 'string' && (SOURCES as readonly string[]).includes(value);

// ---- outputs ----

const PLOT_NAMES = [
  'series',
  'title',
  'color',
  'linewidth',
  'style',
  'trackprice',
  'histbase',
  'offset',
  'join',
  'editable',
  'show_last',
  'display',
  'force_overlay',
  'format',
  'precision',
  'linestyle',
] as const;

/**
 * A color argument: worked out from the inputs before the bars, or per bar when it's a series.
 * `na` hides what it colors (Pine docs, Plots: "plot values using na color").
 */
function colorArg(args: Args, name: string, fallback: number) {
  const value = args.color(name);
  if (!value) return { fold: (() => fallback) as Fold, dynamic: false, ev: null as Ev | null };
  if (value.qual > INPUT) return { fold: (() => Number.NaN) as Fold, dynamic: true, ev: value.ev };
  return { fold: args.folded(name, fallback), dynamic: false, ev: null as Ev | null };
}

const constTitle = (args: Args) => String(args.constant('title', '', 'string') ?? '');
const constEditable = (args: Args) => args.constant('editable', true, 'bool') !== false;

function plotCall(c: Compiler, call: Call, scope: Scope): Compiled {
  const args = new Args(c, call, scope, PLOT_NAMES, 1);
  const seriesArg = args.get('series') as Compiled;
  c.needType(seriesArg, isNumeric(seriesArg.base), 'plot', 'series', 'series float');
  const value = seriesArg.ev as NumEv;
  const index = c.plots.length;
  // color.blue is plot()'s default color (Pine docs, Colors).
  const color = colorArg(args, 'color', COLORS.blue as number);
  if (args.constant('force_overlay', false, 'bool') === true) {
    c.warn(
      "force_overlay comes later (P2): this plot draws in the script's own pane",
      call.calleeSpan,
    );
  }
  c.plots.push({
    index,
    title: constTitle(args),
    color: { fold: color.fold, dynamic: color.dynamic },
    linewidth: args.foldedAs('linewidth', 'int', 1),
    style: args.foldedAs('style', 'plot_style', 'line'),
    linestyle: args.foldedAs('linestyle', 'plot_line_style', 'solid'),
    trackprice: args.foldedAs('trackprice', 'bool', false),
    histbase: args.foldedAs('histbase', 'float', 0),
    offset: args.foldedAs('offset', 'int', 0),
    join: args.foldedAs('join', 'bool', false),
    editable: constEditable(args),
    showLast: args.foldedAs('show_last', 'int', Number.NaN),
    display: args.foldedAs('display', 'int', DISPLAY.all),
    format: args.foldedAs('format', 'string', null),
    precision: args.foldedAs('precision', 'int', Number.NaN),
    span: call.span,
  });
  const ref: OutputRef = { output: 'plot', index };
  const colorEv = color.ev;
  return {
    base: 'plot',
    qual: CONST,
    ev: colorEv
      ? (rt) => {
          (rt.outputs.plots[index] as Float64Array)[rt.index] = value(rt);
          (rt.outputs.plotColors[index] as Float64Array)[rt.index] = colorEv(rt) as number;
          return ref;
        }
      : (rt) => {
          (rt.outputs.plots[index] as Float64Array)[rt.index] = value(rt);
          return ref;
        },
    fold: () => ref,
    span: call.span,
  };
}

function hlineCall(c: Compiler, call: Call, scope: Scope): Compiled {
  const names = ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display'];
  const args = new Args(c, call, scope, names, 1);
  const index = c.hlines.length;
  c.hlines.push({
    index,
    price: args.foldedAs('price', 'float', Number.NaN),
    title: constTitle(args),
    // Not in TradingView's docs: gray and dashed, provisional (docs/SPEC.md §11).
    color: args.foldedAs('color', 'color', COLORS.gray as number),
    linestyle: args.foldedAs('linestyle', 'hline_style', 'dashed'),
    linewidth: args.foldedAs('linewidth', 'int', 1),
    editable: constEditable(args),
    display: args.foldedAs('display', 'int', DISPLAY.all),
    span: call.span,
  });
  const ref: OutputRef = { output: 'hline', index };
  return { base: 'hline', qual: CONST, ev: () => ref, fold: () => ref, span: call.span };
}

const SOLID_FILL = [
  'plot1',
  'plot2',
  'color',
  'title',
  'editable',
  'show_last',
  'fillgaps',
  'display',
];
const GRADIENT_FILL = [
  'plot1',
  'plot2',
  'top_value',
  'bottom_value',
  'top_color',
  'bottom_color',
  'title',
  'display',
  'fillgaps',
  'editable',
];

/** fill() between two plots or two hlines, solid or a gradient (TradingView's blog, 2022). */
function fillCall(c: Compiler, call: Call, scope: Scope): Compiled {
  const named = new Set(call.args.map((arg) => arg.name));
  const gradient =
    named.has('top_value') ||
    named.has('bottom_value') ||
    named.has('top_color') ||
    call.args.filter((arg) => arg.name === null).length >= 6;
  const args = new Args(c, call, scope, gradient ? GRADIENT_FILL : SOLID_FILL, gradient ? 6 : 2);
  const edge = (name: string): OutputRef => {
    const value = args.get(name) as Compiled;
    if ((value.base !== 'plot' && value.base !== 'hline') || !value.fold) {
      return c.fail(
        `fill() needs two plots or two hlines; '${name}' is '${typeName(value)}'`,
        value.span,
      );
    }
    const ref = value.fold({ inputs: [] });
    if (!isOutputRef(ref)) return c.fail(`fill() can't tell which plot '${name}' is`, value.span);
    return ref;
  };
  const a = edge('plot1');
  const b = edge('plot2');
  if (a.output !== b.output)
    c.fail('fill() takes two plots or two hlines, not one of each', call.span);
  const index = c.fills.length;
  // Not in TradingView's docs: blue at 90% transparency, provisional (docs/SPEC.md §11).
  const color = gradient
    ? null
    : colorArg(args, 'color', withTransparency(COLORS.blue as number, 90));
  if (gradient) {
    for (const name of ['top_value', 'bottom_value']) {
      const value = args.get(name) as Compiled;
      c.needType(value, isNumeric(value.base), 'fill', name, 'series float');
    }
    for (const name of ['top_color', 'bottom_color']) args.color(name);
    for (const name of ['top_value', 'bottom_value', 'top_color', 'bottom_color']) {
      const value = args.get(name) as Compiled;
      if (value.qual > INPUT) {
        c.fail(
          `Gradient fills that change from bar to bar come later (P2): '${name}' must be const or input`,
          value.span,
        );
      }
    }
  }
  c.fills.push({
    index,
    a,
    b,
    color: color ? { fold: color.fold, dynamic: color.dynamic } : null,
    gradient: gradient
      ? {
          top: args.folded('top_value', Number.NaN),
          bottom: args.folded('bottom_value', Number.NaN),
          topColor: args.folded('top_color', Number.NaN),
          bottomColor: args.folded('bottom_color', Number.NaN),
        }
      : null,
    title: constTitle(args),
    editable: constEditable(args),
    showLast: gradient ? () => Number.NaN : args.foldedAs('show_last', 'int', Number.NaN),
    fillgaps: args.constant('fillgaps', false, 'bool') === true,
    display: args.foldedAs('display', 'int', DISPLAY.all),
    span: call.span,
  });
  const colorEv = color?.ev ?? null;
  return {
    base: 'void',
    qual: CONST,
    ev: colorEv
      ? (rt) => {
          (rt.outputs.fillColors[index] as Float64Array)[rt.index] = colorEv(rt) as number;
          return null;
        }
      : () => null,
    span: call.span,
  };
}

function bgcolorCall(c: Compiler, call: Call, scope: Scope): Compiled {
  const names = ['color', 'offset', 'editable', 'show_last', 'title', 'force_overlay', 'display'];
  const args = new Args(c, call, scope, names, 1);
  const color = args.color('color') as Compiled;
  const index = c.bgcolors.length;
  const dynamic = color.qual > INPUT;
  if (args.constant('force_overlay', false, 'bool') === true) {
    c.warn(
      "force_overlay comes later (P2): this background shows in the script's own pane",
      call.calleeSpan,
    );
  }
  c.bgcolors.push({
    index,
    color: { fold: dynamic ? () => Number.NaN : args.folded('color', Number.NaN), dynamic },
    offset: args.foldedAs('offset', 'int', 0),
    editable: constEditable(args),
    showLast: args.foldedAs('show_last', 'int', Number.NaN),
    title: constTitle(args),
    display: args.foldedAs('display', 'int', DISPLAY.all),
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
}

// ---- math.* ----

function numbersCall(
  c: Compiler,
  call: Call,
  scope: Scope,
  names: readonly string[],
  required: number,
  result: (bases: Base[]) => Base,
  f: (...values: number[]) => number,
): Compiled {
  const args = new Args(c, call, scope, names, required);
  const compiled = names
    .map((name) => args.get(name))
    .filter((value): value is Compiled => value !== undefined);
  for (const [i, value] of compiled.entries()) {
    c.needType(value, isNumeric(value.base), call.callee, names[i] as string, 'float');
  }
  const evs = compiled.map((value) => value.ev as NumEv);
  const folds = compiled.map((value) => value.fold);
  const qual = maxQual(...compiled.map((value) => value.qual));
  const base = result(compiled.map((value) => value.base));
  const allFold = folds.every((fold) => fold !== undefined);
  return {
    base,
    qual,
    ev: (rt) => f(...evs.map((ev) => ev(rt))),
    fold: allFold
      ? (env) => f(...folds.map((fold) => (fold as (env: FoldEnv) => Value)(env) as number))
      : undefined,
    span: call.span,
  };
}

/** math.max(a, b, …): any number of arguments; `f2` for two. */
function variadic(
  c: Compiler,
  call: Call,
  scope: Scope,
  f: (values: number[]) => number,
  f2: (a: number, b: number) => number,
  average: boolean,
): Compiled {
  if (call.args.length < 2) c.fail(`'${call.callee}' needs at least two numbers`, call.span);
  if (call.args.some((arg) => arg.name !== null))
    c.fail(`'${call.callee}' takes no named arguments`, call.span);
  const compiled = call.args.map((arg) => c.expr(arg.value, scope));
  for (const value of compiled)
    c.needType(value, isNumeric(value.base), call.callee, 'number', 'float');
  const evs = compiled.map((value) => value.ev as NumEv);
  const folds = compiled.map((value) => value.fold);
  const ints = !average && compiled.every((value) => value.base === 'int');
  const [first, second] = evs as [NumEv, NumEv];
  return {
    base: ints ? 'int' : 'float',
    qual: maxQual(...compiled.map((value) => value.qual)),
    // Two numbers, the common case, without an array per bar.
    ev: evs.length === 2 ? (rt) => f2(first(rt), second(rt)) : (rt) => f(evs.map((ev) => ev(rt))),
    fold: folds.every((fold) => fold)
      ? (env) => f(folds.map((fold) => (fold as (env: FoldEnv) => Value)(env) as number))
      : undefined,
    span: call.span,
  };
}

const anyNa = (values: readonly number[]) => values.some((value) => Number.isNaN(value));

function mathCalls(): Record<string, Handler> {
  const unary =
    (f: (x: number) => number, base: 'int' | 'float' | 'same' = 'float'): Handler =>
    (c, call, scope) =>
      numbersCall(
        c,
        call,
        scope,
        ['number'],
        1,
        (b) => (base === 'same' ? (b[0] === 'int' ? 'int' : 'float') : base),
        f,
      );
  return {
    'math.abs': unary(Math.abs, 'same'),
    'math.sqrt': unary(Math.sqrt),
    'math.exp': unary(Math.exp),
    'math.log': unary(Math.log),
    'math.log10': unary(Math.log10),
    'math.sign': unary(Math.sign),
    'math.floor': unary(Math.floor, 'int'),
    'math.ceil': unary(Math.ceil, 'int'),
    'math.sin': unary(Math.sin),
    'math.cos': unary(Math.cos),
    'math.tan': unary(Math.tan),
    'math.asin': unary(Math.asin),
    'math.acos': unary(Math.acos),
    'math.atan': unary(Math.atan),
    'math.todegrees': unary((x) => (x * 180) / Math.PI),
    'math.toradians': unary((x) => (x * Math.PI) / 180),
    'math.pow': (c, call, scope) =>
      numbersCall(c, call, scope, ['base', 'exponent'], 2, () => 'float', Math.pow),
    'math.round': (c, call, scope) => {
      const withPrecision = call.args.length > 1;
      return numbersCall(
        c,
        call,
        scope,
        ['number', 'precision'],
        1,
        () => (withPrecision ? 'float' : 'int'),
        (x, precision) => {
          if (precision === undefined || Number.isNaN(precision)) return Math.round(x);
          const f = 10 ** precision;
          return Math.round(x * f) / f;
        },
      );
    },
    'math.round_to_mintick': (c, call, scope) => {
      const args = new Args(c, call, scope, ['number'], 1);
      const x = args.number('number') as NumEv;
      return series(
        'float',
        (rt) => Math.round(x(rt) / rt.symbol.mintick) * rt.symbol.mintick,
        call.span,
      );
    },
    // na in, na out (Math.max of NaN is NaN too).
    'math.max': (c, call, scope) =>
      variadic(c, call, scope, (v) => Math.max(...v), Math.max, false),
    'math.min': (c, call, scope) =>
      variadic(c, call, scope, (v) => Math.min(...v), Math.min, false),
    'math.avg': (c, call, scope) =>
      variadic(
        c,
        call,
        scope,
        (v) => v.reduce((sum, x) => sum + x, 0) / v.length,
        (a, b) => (a + b) / 2,
        true,
      ),
    'math.sum': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'length'], 2);
      const source = args.number('source') as NumEv;
      const length = args.int('length') as NumEv;
      const fn = c.rt.register(new SumFn());
      return series('float', (rt) => fn.call(source(rt), length(rt), rt.final), call.span);
    },
  };
}

// ---- color.* ----

function colorCalls(): Record<string, Handler> {
  const channel =
    (pick: (rgba: ReturnType<typeof unpackColor>) => number): Handler =>
    (c, call, scope) => {
      const args = new Args(c, call, scope, ['color'], 1);
      const color = args.color('color') as Compiled;
      const ev = color.ev as NumEv;
      const f = (v: number) => (Number.isNaN(v) ? Number.NaN : pick(unpackColor(v)));
      return {
        base: 'float',
        qual: color.qual,
        ev: (rt) => f(ev(rt)),
        fold: color.fold && ((env) => f((color.fold as (env: FoldEnv) => Value)(env) as number)),
        span: call.span,
      };
    };
  return {
    'color.new': (c, call, scope) => {
      const args = new Args(c, call, scope, ['color', 'transp'], 2);
      const color = args.color('color') as Compiled;
      const transp = args.get('transp') as Compiled;
      c.needType(transp, isNumeric(transp.base), 'color.new', 'transp', 'float');
      const a = color.ev as NumEv;
      const b = transp.ev as NumEv;
      return {
        base: 'color',
        qual: maxQual(color.qual, transp.qual),
        ev: (rt) => withTransparency(a(rt), b(rt)),
        fold:
          color.fold && transp.fold
            ? (env) =>
                withTransparency(
                  (color.fold as (env: FoldEnv) => Value)(env) as number,
                  (transp.fold as (env: FoldEnv) => Value)(env) as number,
                )
            : undefined,
        span: call.span,
      };
    },
    'color.rgb': (c, call, scope) =>
      ({
        ...numbersCall(
          c,
          call,
          scope,
          ['red', 'green', 'blue', 'transp'],
          3,
          () => 'color',
          (r, g, b, t) =>
            anyNa([r as number, g as number, b as number])
              ? Number.NaN
              : packColor(
                  Math.round(r as number),
                  Math.round(g as number),
                  Math.round(b as number),
                  t ?? 0,
                ),
        ),
      }) as Compiled,
    'color.r': channel((rgba) => rgba.r),
    'color.g': channel((rgba) => rgba.g),
    'color.b': channel((rgba) => rgba.b),
    'color.t': channel((rgba) => rgba.t),
    'color.from_gradient': (c, call, scope) => {
      const args = new Args(
        c,
        call,
        scope,
        ['value', 'bottom_value', 'top_value', 'bottom_color', 'top_color'],
        5,
      );
      const value = args.number('value') as NumEv;
      const bottom = args.number('bottom_value') as NumEv;
      const top = args.number('top_value') as NumEv;
      const bottomColor = args.color('bottom_color') as Compiled;
      const topColor = args.color('top_color') as Compiled;
      const bc = bottomColor.ev as NumEv;
      const tc = topColor.ev as NumEv;
      return series(
        'color',
        (rt) => fromGradient(value(rt), bottom(rt), top(rt), bc(rt), tc(rt)),
        call.span,
      );
    },
  };
}

// ---- ta.* ----

/** A ta.* call on one number and a length, through a stateful function. */
function sourceLength(
  c: Compiler,
  call: Call,
  scope: Scope,
  lengthQual: Qual,
  make: () => { call(value: number, length: number, final: boolean): number },
  lengthName = 'length',
  required = 2,
  lengthDefault = 1,
): Compiled {
  const args = new Args(c, call, scope, ['source', lengthName], required);
  const source = args.number('source') as NumEv;
  const length = args.int(lengthName, lengthQual) ?? (() => lengthDefault);
  const fn = c.rt.register(
    make() as unknown as Parameters<typeof c.rt.register>[0],
  ) as unknown as ReturnType<typeof make>;
  return series('float', (rt) => fn.call(source(rt), length(rt), rt.final), call.span);
}

function taCalls(): Record<string, Handler> {
  return {
    'ta.sma': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'length'], 2);
      const length = args.get('length') as Compiled;
      // A length that can't change uses the running sum; one that can, the window itself.
      return length.qual <= SIMPLE
        ? sourceLength(c, call, scope, SERIES, smaFn)
        : sourceLength(c, call, scope, SERIES, () => new DynamicSma());
    },
    'ta.ema': (c, call, scope) => sourceLength(c, call, scope, SIMPLE, emaFn),
    'ta.rma': (c, call, scope) => sourceLength(c, call, scope, SIMPLE, rmaFn),
    'ta.wma': (c, call, scope) => sourceLength(c, call, scope, SIMPLE, wmaFn),
    'ta.rsi': (c, call, scope) => sourceLength(c, call, scope, SIMPLE, () => new RsiFn()),
    'ta.mom': (c, call, scope) => sourceLength(c, call, scope, SERIES, () => new ChangeFn('mom')),
    'ta.roc': (c, call, scope) => sourceLength(c, call, scope, SERIES, () => new ChangeFn('roc')),
    'ta.dev': (c, call, scope) => sourceLength(c, call, scope, SERIES, () => new DevFn()),
    'ta.cci': (c, call, scope) => sourceLength(c, call, scope, SERIES, () => new CciFn()),
    'ta.change': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'length'], 1);
      const source = args.get('source') as Compiled;
      if (source.base === 'bool') {
        const value = source.ev as (rt: Runtime) => boolean;
        const fn = c.rt.register(new BoolChangeFn());
        return series('bool', (rt) => fn.call(value(rt), rt.final), call.span);
      }
      return sourceLength(c, call, scope, SERIES, () => new ChangeFn('change'), 'length', 1, 1);
    },
    'ta.vwma': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'length'], 2);
      const source = args.number('source') as NumEv;
      const length = args.int('length', SIMPLE) as NumEv;
      const fn = c.rt.register(new VwmaFn());
      return series(
        'float',
        (rt) =>
          fn.call(
            source(rt),
            rt.symbol.hasVolume ? rt.bar.volume : Number.NaN,
            length(rt),
            rt.final,
          ),
        call.span,
      );
    },
    'ta.swma': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source'], 1);
      const source = args.number('source') as NumEv;
      const fn = c.rt.register(new SwmaFn());
      return series('float', (rt) => fn.call(source(rt), rt.final), call.span);
    },
    'ta.stdev': (c, call, scope) => stdevCall(c, call, scope, false),
    'ta.variance': (c, call, scope) => stdevCall(c, call, scope, true),
    'ta.highest': (c, call, scope) => extremeCall(c, call, scope, true, false),
    'ta.lowest': (c, call, scope) => extremeCall(c, call, scope, false, false),
    'ta.highestbars': (c, call, scope) => extremeCall(c, call, scope, true, true),
    'ta.lowestbars': (c, call, scope) => extremeCall(c, call, scope, false, true),
    'ta.rising': (c, call, scope) => trendCall(c, call, scope, true),
    'ta.falling': (c, call, scope) => trendCall(c, call, scope, false),
    'ta.crossover': (c, call, scope) => crossCall(c, call, scope, 'over'),
    'ta.crossunder': (c, call, scope) => crossCall(c, call, scope, 'under'),
    'ta.cross': (c, call, scope) => crossCall(c, call, scope, 'any'),
    'ta.barssince': (c, call, scope) => {
      const args = new Args(c, call, scope, ['condition'], 1);
      const condition = args.bool('condition') as (rt: Runtime) => boolean;
      const fn = c.rt.register(new BarssinceFn());
      return series('int', (rt) => fn.call(condition(rt), rt.final), call.span);
    },
    'ta.valuewhen': (c, call, scope) => {
      const args = new Args(c, call, scope, ['condition', 'source', 'occurrence'], 3);
      const condition = args.bool('condition') as (rt: Runtime) => boolean;
      const source = args.number('source') as NumEv;
      const occurrence = args.int('occurrence') as NumEv;
      const fn = c.rt.register(new ValuewhenFn());
      return series(
        'float',
        (rt) => fn.call(condition(rt), source(rt), occurrence(rt), rt.final),
        call.span,
      );
    },
    'ta.pivothigh': (c, call, scope) => pivotCall(c, call, scope, true),
    'ta.pivotlow': (c, call, scope) => pivotCall(c, call, scope, false),
    'ta.tr': (c, call, scope) => {
      const args = new Args(c, call, scope, ['handle_na'], 0);
      const handle = args.bool('handle_na', SIMPLE) ?? (() => false);
      const fn = c.rt.register(new TrFn());
      return series(
        'float',
        (rt) => fn.call(rt.bar.high, rt.bar.low, rt.bar.close, handle(rt), rt.final),
        call.span,
      );
    },
    'ta.atr': (c, call, scope) => {
      const args = new Args(c, call, scope, ['length'], 1);
      const length = args.int('length', SIMPLE) as NumEv;
      const fn = c.rt.register(new AtrFn());
      return series(
        'float',
        (rt) => fn.call(rt.bar.high, rt.bar.low, rt.bar.close, length(rt), rt.final),
        call.span,
      );
    },
    'ta.cum': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source'], 1);
      const source = args.number('source') as NumEv;
      const fn = c.rt.register(new CumFn());
      return series('float', (rt) => fn.call(source(rt), rt.final), call.span);
    },
    'ta.stoch': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'high', 'low', 'length'], 4);
      const source = args.number('source') as NumEv;
      const high = args.number('high') as NumEv;
      const low = args.number('low') as NumEv;
      const length = args.int('length') as NumEv;
      const fn = c.rt.register(new StochFn());
      return series(
        'float',
        (rt) => fn.call(source(rt), high(rt), low(rt), length(rt), rt.final),
        call.span,
      );
    },
    'ta.macd': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'fastlen', 'slowlen', 'siglen'], 4);
      const source = args.number('source') as NumEv;
      const fast = args.int('fastlen', SIMPLE) as NumEv;
      const slow = args.int('slowlen', SIMPLE) as NumEv;
      const signal = args.int('siglen', SIMPLE) as NumEv;
      const fn = c.rt.register(new MacdFn());
      return {
        base: 'tuple',
        items: ['float', 'float', 'float'],
        qual: SERIES,
        ev: (rt) => fn.call(source(rt), fast(rt), slow(rt), signal(rt), rt.final),
        span: call.span,
      };
    },
    'ta.bb': (c, call, scope) => {
      const args = new Args(c, call, scope, ['series', 'length', 'mult'], 3);
      const source = args.number('series') as NumEv;
      const length = args.int('length', SIMPLE) as NumEv;
      const mult = args.number('mult', SIMPLE) as NumEv;
      const fn = c.rt.register(new BbFn());
      return {
        base: 'tuple',
        items: ['float', 'float', 'float'],
        qual: SERIES,
        ev: (rt) => fn.call(source(rt), length(rt), mult(rt), rt.final),
        span: call.span,
      };
    },
  };
}

function stdevCall(c: Compiler, call: Call, scope: Scope, variance: boolean): Compiled {
  const args = new Args(c, call, scope, ['source', 'length', 'biased'], 2);
  const source = args.number('source') as NumEv;
  const length = args.int('length', SIMPLE) as NumEv;
  const biased = args.bool('biased', SIMPLE) ?? (() => true);
  const fn = c.rt.register(new StdevFn(variance));
  return series('float', (rt) => fn.call(source(rt), length(rt), biased(rt), rt.final), call.span);
}

/** ta.highest(length) reads `high` (`low` for lowest); ta.highest(source, length) its source. */
function extremeCall(
  c: Compiler,
  call: Call,
  scope: Scope,
  highest: boolean,
  offset: boolean,
): Compiled {
  const oneArg = call.args.length === 1 && call.args[0]?.name !== 'source';
  const names = oneArg ? ['length'] : ['source', 'length'];
  const args = new Args(c, call, scope, names, names.length);
  const source: NumEv = oneArg
    ? (rt) => (highest ? rt.bar.high : rt.bar.low)
    : (args.number('source') as NumEv);
  const length = args.int('length') as NumEv;
  const fn = c.rt.register(new ExtremeFn(highest, offset));
  return series(
    offset ? 'int' : 'float',
    (rt) => fn.call(source(rt), length(rt), rt.final),
    call.span,
  );
}

function trendCall(c: Compiler, call: Call, scope: Scope, rising: boolean): Compiled {
  const args = new Args(c, call, scope, ['source', 'length'], 2);
  const source = args.number('source') as NumEv;
  const length = args.int('length') as NumEv;
  const fn = c.rt.register(new TrendFn(rising));
  return series('bool', (rt) => fn.call(source(rt), length(rt), rt.final), call.span);
}

function crossCall(
  c: Compiler,
  call: Call,
  scope: Scope,
  kind: 'over' | 'under' | 'any',
): Compiled {
  const args = new Args(c, call, scope, ['source1', 'source2'], 2);
  const a = args.number('source1') as NumEv;
  const b = args.number('source2') as NumEv;
  const fn = c.rt.register(new CrossFn(kind));
  return series('bool', (rt) => fn.call(a(rt), b(rt), rt.final), call.span);
}

/** ta.pivothigh(leftbars, rightbars) reads `high`; with a source first, that source. */
function pivotCall(c: Compiler, call: Call, scope: Scope, high: boolean): Compiled {
  const twoArgs = call.args.length === 2 && call.args[0]?.name !== 'source';
  const names = twoArgs ? ['leftbars', 'rightbars'] : ['source', 'leftbars', 'rightbars'];
  const args = new Args(c, call, scope, names, names.length);
  const source: NumEv = twoArgs
    ? (rt) => (high ? rt.bar.high : rt.bar.low)
    : (args.number('source') as NumEv);
  const left = args.int('leftbars') as NumEv;
  const right = args.int('rightbars') as NumEv;
  const fn = c.rt.register(new PivotFn(high));
  return series('float', (rt) => fn.call(source(rt), left(rt), right(rt), rt.final), call.span);
}
