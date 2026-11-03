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
import type { Compiler, EnumDef, Scope } from './compiler.ts';
import { PineRuntimeError, type Span } from './diagnostics.ts';
import { markCalls, markConstant } from './marks.ts';
import { requestCalls } from './requestCalls.ts';
import { DEFAULT_SYMBOL, type Runtime } from './runtime.ts';
import { stringCalls } from './strings.ts';
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
  DynamicVwma,
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
  WindowStdevFn,
  WmaFn,
} from './ta.ts';
import {
  AllTimeFn,
  AlmaFn,
  CogFn,
  CorrelationFn,
  LinregFn,
  MedianFn,
  ModeFn,
  PercentileLinearFn,
  PercentileNearestFn,
  PercentrankFn,
  RangeFn,
  RciFn,
} from './taStats.ts';
import {
  BAR_STEPS,
  BarSeriesFn,
  BbwFn,
  CmoFn,
  DmiFn,
  HmaFn,
  KcFn,
  MfiFn,
  PivotLevelsFn,
  SarFn,
  SupertrendFn,
  TsiFn,
  VwapFn,
  WprFn,
} from './taTrend.ts';
import { barCloseTime, calendarValue, sessionOf, timeCalls, timeName } from './timeBuiltins.ts';
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
  PineArray,
  PineEnum,
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
    /^(label|line|box|table|polyline|linefill|chart\.point)\./,
    "isn't supported in tradingNerd yet: drawings (labels, lines, boxes, tables) come in a later update",
  ],
  [
    /^request\.(financial|earnings|dividends|splits|economic)$/,
    "isn't supported in tradingNerd yet: companies' financial data comes in a later update",
  ],
  [
    /^request\.(seed|quandl|footprint)$/,
    "isn't supported in tradingNerd yet: this data comes from TradingView's own feeds",
  ],
  [
    /^request\.(security_lower_tf|currency_rate)$/,
    "isn't supported in tradingNerd yet: it comes in the next update",
  ],
  [
    /^strategy(\.|$)/,
    "isn't supported in tradingNerd yet: strategies come with the Strategy Tester in a later update",
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
  if (name === 'time_close') return barCloseTime;
  return calendarValue(name);
}

/** The int ones among the bar values: times, bar_index and the calendar's. */
const INT_BAR_VALUES = new Set([
  'time',
  'time_close',
  'bar_index',
  'year',
  'month',
  'weekofyear',
  'dayofmonth',
  'dayofweek',
  'hour',
  'minute',
  'second',
]);

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
  if (bar) return series(INT_BAR_VALUES.has(name) ? 'int' : 'float', (rt) => bar(rt, 0), span);
  const time = timeName(c, name, span);
  if (time) return time;
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
    case 'chart':
      return chart(member, span);
    case 'scale':
      if (member === 'right' || member === 'left' || member === 'none') {
        return constant('scale_style', member, span);
      }
      break;
    case 'barmerge':
      // request.security()'s merge settings (the v6 reference, barmerge.*).
      if (member === 'gaps_on' || member === 'gaps_off') {
        return constant('barmerge_gaps', member, span);
      }
      if (member === 'lookahead_on' || member === 'lookahead_off') {
        return constant('barmerge_lookahead', member, span);
      }
      break;
    case 'shape':
    case 'location':
    case 'size': {
      const mark = markConstant(space, member, span);
      if (mark) return mark;
      break;
    }
    case 'alert':
      if (
        member === 'freq_all' ||
        member === 'freq_once_per_bar' ||
        member === 'freq_once_per_bar_close'
      ) {
        return constant('string', member.slice(5), span);
      }
      break;
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
      if (name in BAR_STEPS) {
        const fn = barSeries(c, name);
        return series('float', (rt) => readBarSeries(fn, rt, 0), span);
      }
      if (member === 'vwap') {
        // The variable: hlc3's VWAP from each session's start (the v6 reference).
        const fn = c.rt.register(new VwapFn());
        return series(
          'float',
          (rt) =>
            fn.call(
              sourceValue(rt.bar, 'hlc3'),
              rt.symbol.hasVolume ? rt.bar.volume : Number.NaN,
              sessionOf(rt),
              0,
              rt.final,
            )[0] as number,
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
    case 'minmove':
      return simple('int', () => 1, span);
    case 'pointvalue':
      return simple('float', () => 1, span);
    case 'prefix':
      return simple('string', (rt) => rt.symbol.tickerid.split(':')[0] ?? '', span);
    case 'root':
      // Futures have a root of their own; spot pairs and stocks are their ticker.
      return simple('string', (rt) => rt.symbol.ticker, span);
    case 'main_tickerid':
      // The chart's own, even inside a request (the v6 reference).
      return simple('string', (rt) => (rt.main ?? rt.symbol).tickerid, span);
    case 'volumetype':
      // Provisional (docs/SPEC.md §11): our pairs' volume is in the base asset, stocks' in shares.
      return simple('string', (rt) => (rt.symbol.hasVolume ? 'base' : 'n/a'), span);
    case 'country':
    case 'sector':
    case 'industry':
    case 'current_contract':
    case 'isin':
      // Not known for our symbols: the na string (strings.ts).
      return simple('string', () => '', span);
    case 'mincontract':
    case 'shares_outstanding_total':
    case 'shares_outstanding_float':
    case 'target_price_average':
    case 'target_price_high':
    case 'target_price_low':
    case 'target_price_median':
      return simple('float', () => Number.NaN, span);
    case 'expiration_date':
    case 'employees':
    case 'shareholders':
    case 'target_price_date':
    case 'target_price_estimates':
    case 'recommendations_buy':
    case 'recommendations_buy_strong':
    case 'recommendations_date':
    case 'recommendations_hold':
    case 'recommendations_sell':
    case 'recommendations_sell_strong':
    case 'recommendations_total':
      return simple('int', () => Number.NaN, span);
    default:
      return null;
  }
}

/** A color that reads on `background`: white on a dark one, black on a light one (provisional). */
function contrast(background: number): number {
  const { r, g, b } = unpackColor(background);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
    ? (COLORS.white ?? 0xffffff00)
    : (COLORS.black ?? 0);
}

/**
 * chart.*: the chart's colors (the background, and a color that reads on it: TradingView doesn't
 * say which, so white on our dark chart, provisional), its type (always standard bars here), and
 * its visible range (provisional: the loaded bars', docs/SPEC.md §11).
 */
function chart(member: string, span: Span): Compiled | null {
  switch (member) {
    case 'bg_color':
      return {
        base: 'color',
        qual: INPUT,
        ev: (rt) => rt.symbol.background,
        fold: () => DEFAULT_SYMBOL.background,
        span,
      };
    case 'fg_color':
      return {
        base: 'color',
        qual: INPUT,
        ev: (rt) => contrast(rt.symbol.background),
        fold: () => contrast(DEFAULT_SYMBOL.background),
        span,
      };
    case 'is_standard':
      return simple('bool', () => true, span);
    case 'is_heikinashi':
    case 'is_kagi':
    case 'is_linebreak':
    case 'is_pnf':
    case 'is_range':
    case 'is_renko':
      return simple('bool', () => false, span);
    case 'left_visible_bar_time':
      return series('int', (rt) => barTimeAt(rt, rt.start), span);
    case 'right_visible_bar_time':
      return series('int', (rt) => barTimeAt(rt, rt.bars.length - 1), span);
    default:
      return null;
  }
}

const barTimeAt = (rt: Runtime, i: number): number => {
  const bar = rt.bars[i];
  return bar ? (bar.start ?? bar.time * 1000) : Number.NaN;
};

/** One series per ta.* volume variable per compile: `ta.obv` and `ta.obv[24]` share it. */
const barSeriesOf = new WeakMap<Compiler, Map<string, BarSeriesFn>>();

function barSeries(c: Compiler, name: string): BarSeriesFn {
  let byName = barSeriesOf.get(c);
  if (!byName) {
    byName = new Map();
    barSeriesOf.set(c, byName);
  }
  let fn = byName.get(name);
  if (!fn) {
    fn = c.rt.register(new BarSeriesFn(BAR_STEPS[name] as (typeof BAR_STEPS)[string]));
    byName.set(name, fn);
  }
  return fn;
}

const readBarSeries = (fn: BarSeriesFn, rt: Runtime, k: number): number =>
  fn.at(rt.index, k, (i) => rt.barBack(rt.index - i), rt.symbol.hasVolume, rt.final);

/** `close[3]`, `bar_index[1]`: straight from the chart's bars. */
export function compileHistoryOfBuiltin(
  _c: Compiler,
  name: string,
  offset: Compiled,
  span: Span,
): Compiled | null {
  if (name in BAR_STEPS) {
    // ta.obv[24]: the series is kept on every bar, so any bar back can be read.
    const fn = barSeries(_c, name);
    const back = offset.ev as NumEv;
    return series(
      'float',
      (rt) => {
        const n = back(rt);
        // An na offset reads na, a negative one stops (compiler.ts, historyError).
        if (Number.isNaN(n)) return Number.NaN;
        if (n < 0)
          throw new PineRuntimeError(
            `Invalid history reference [${n}]: the offset must be 0 or more`,
            span,
          );
        return readBarSeries(fn, rt, Math.floor(n));
      },
      span,
    );
  }
  const bar = barValue(name);
  if (!bar) return null;
  const k = offset.ev as NumEv;
  const base: Base = INT_BAR_VALUES.has(name) ? 'int' : 'float';
  return series(
    base,
    (rt) => {
      const n = k(rt);
      if (Number.isNaN(n)) return Number.NaN;
      if (n < 0)
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
  'input.timeframe': (c, call, scope) => inputCall(c, call, scope, 'timeframe'),
  'input.session': (c, call, scope) => inputCall(c, call, scope, 'session'),
  'input.symbol': (c, call, scope) => inputCall(c, call, scope, 'symbol'),
  'input.time': (c, call, scope) => inputCall(c, call, scope, 'time'),
  'input.price': (c, call, scope) => inputCall(c, call, scope, 'price'),
  'input.text_area': (c, call, scope) => inputCall(c, call, scope, 'text_area'),
  'input.enum': (c, call, scope) => inputCall(c, call, scope, 'enum'),
  plot: plotCall,
  hline: hlineCall,
  fill: fillCall,
  bgcolor: bgcolorCall,
  alertcondition: (c, call, scope) => {
    c.otherOutputs++;
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
          : x.base === 'string'
            ? // The na string is "": na("") is true (measured on TradingView, strings.ts).
              (v: Value) => v === '' || v === null
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
      const missing = isString
        ? value === null || value === ''
        : typeof value === 'number' && Number.isNaN(value);
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
  ...mathCalls(),
  ...colorCalls(),
  ...taCalls(),
  ...collectionCalls(),
  ...timeCalls(),
  ...stringCalls(),
  ...markCalls(),
  ...requestCalls(),
};

/** Whether a built-in function of this full name exists (`array.push`, `ta.sma`). */
export const isBuiltinNamespace = (name: string): boolean => name in CALLS;

/** Every built-in function's full name (the editor's help, catalog.ts). */
export const builtinCallNames = (): readonly string[] => Object.keys(CALLS);

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
  timeframe: [
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
  session: [
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
  symbol: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  time: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  price: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  text_area: ['defval', 'title', 'tooltip', 'group', 'confirm', 'display', 'active'],
  enum: [
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
};

/** The type each kind of input gives the script (the v6 reference's input.* returns). */
const INPUT_BASES: Readonly<Record<string, Base>> = {
  timeframe: 'string',
  session: 'string',
  symbol: 'string',
  text_area: 'string',
  time: 'int',
  price: 'float',
};

type InputKind =
  | 'int'
  | 'float'
  | 'bool'
  | 'string'
  | 'color'
  | 'source'
  | 'timeframe'
  | 'session'
  | 'symbol'
  | 'time'
  | 'price'
  | 'text_area'
  | 'enum';

/** input(), input.int() …: one field of the Inputs tab; its value comes from the settings. */
function inputCall(c: Compiler, call: Call, scope: Scope, kind: InputKind | null): Compiled {
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
    if (actual === 'enum') {
      // input.enum: the default is one of an enum's members; the settings keep its name.
      const def = c.enums.get(base);
      if (!def)
        return c.fail(
          `input.enum's default must be an enum's member, not '${typeName(value)}'`,
          value.span,
        );
      const member = args.constant('defval', null);
      return enumInput(c, call, args, names, def, member, scope);
    }
    if (actual !== null && actual in INPUT_BASES) {
      const want = INPUT_BASES[actual] as Base;
      const ok = base === want || (want === 'float' && base === 'int');
      c.needType(value, ok, call.callee, 'defval', `const ${want}`);
      defval = args.constant('defval', null);
    } else {
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
  }
  const index = c.inputIndex(call.span);
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
  const base = INPUT_BASES[actual] ?? (actual as Base);
  return {
    base,
    qual: INPUT,
    ev: (rt) => rt.inputs[index] ?? defval,
    fold: (env) => env.inputs[index] ?? defval,
    span: call.span,
  };
}

/**
 * input.enum(): a menu of the enum's members, by their titles (Pine docs, Inputs: Enum input);
 * the settings keep the chosen member's name, the script gets the member.
 */
function enumInput(
  c: Compiler,
  call: Call,
  args: Args,
  names: readonly string[],
  def: EnumDef,
  member: Value,
  scope: Scope,
): Compiled {
  if (!(member instanceof PineEnum)) {
    return c.fail("input.enum's default must be one of the enum's members", call.span);
  }
  let members = def.members;
  const optionsArg = names.includes('options') ? args.raw('options') : undefined;
  if (optionsArg) {
    if (optionsArg.value.kind !== 'list') {
      c.fail(`'options' takes a list in brackets: options = [E.a, E.b]`, optionsArg.span);
    } else {
      members = optionsArg.value.items.map((item) => {
        const value = c.expr(item, scope).fold?.({ inputs: [] });
        if (!(value instanceof PineEnum) || value.type !== def.key) {
          c.fail(`Each option must be a member of the enum "${def.name}"`, item.span);
        }
        return value as PineEnum;
      });
      if (!members.includes(member)) {
        c.fail(`The default "${member.name}" isn't one of the options`, call.span);
      }
    }
  }
  const text = (name: string) => {
    const value = args.constant(name, null, 'string');
    return typeof value === 'string' ? value : undefined;
  };
  const index = c.inputIndex(call.span);
  const activeArg = args.get('active');
  const activeFold = activeArg?.fold;
  c.inputs.push({
    index,
    kind: 'enum',
    title: text('title') ?? '',
    defval: member.name,
    options: members.map((m) => m.name),
    optionTitles: members.map((m) => m.title),
    tooltip: text('tooltip'),
    inline: text('inline'),
    group: text('group'),
    display: Number(args.foldedAs('display', 'int', DISPLAY.all)({ inputs: [] })),
    active: activeFold ? (env) => activeFold(env) === true : undefined,
    span: call.span,
  });
  const byName = new Map(def.members.map((m) => [m.name, m]));
  const pick = (name: Value) => byName.get(String(name)) ?? member;
  return {
    base: def.key,
    qual: INPUT,
    ev: (rt) => pick(rt.inputs[index] ?? member.name),
    fold: (env) => pick(env.inputs[index] ?? member.name),
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
    kind: 'plot',
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
  // v4 and older styles were ints, and old scripts give hline a plot style: `linestyle = line`
  // (a v3 community script) draws solid, both being their function's first style (provisional,
  // docs/SPEC.md §11).
  const plotStyle = c.version <= 4 && args.get('linestyle')?.base === 'plot_style';
  c.hlines.push({
    index,
    price: args.foldedAs('price', 'float', Number.NaN),
    title: constTitle(args),
    // Not in TradingView's docs: gray and dashed, provisional (docs/SPEC.md §11).
    color: args.foldedAs('color', 'color', COLORS.gray as number),
    linestyle: plotStyle ? () => 'solid' : args.foldedAs('linestyle', 'hline_style', 'dashed'),
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
    bars: false,
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

/** Each math.random() call site's number in the script, so its sequence is its own. */
const randomSites = new WeakMap<Compiler, number>();

function randomSite(c: Compiler): number {
  const site = randomSites.get(c) ?? 0;
  randomSites.set(c, site + 1);
  return site;
}

/**
 * A number in [0, 1) from a seed, a call site, a bar and a call count: the same for the same
 * seed (math.random's `seed`: the same sequence; the v6 reference), else for one load of the
 * script, so its check runs agree (script.ts). A 32-bit mix (Mulberry32's), not cryptographic.
 */
function random01(seed: number, site: number, bar: number, count: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(site + 1, 0x85ebca6b)) >>> 0;
  h = (h ^ Math.imul(bar + 1, 0xc2b2ae35) ^ Math.imul(count + 1, 0x27d4eb2f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

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
    'math.random': (c, call, scope) => {
      const args = new Args(c, call, scope, ['min', 'max', 'seed'], 0);
      const min = args.number('min') ?? (() => 0);
      const max = args.number('max') ?? (() => 1);
      const seed = args.int('seed', SIMPLE);
      const site = randomSite(c);
      let run = -1;
      let count = 0;
      return series(
        'float',
        (rt) => {
          // Each call in one execution of a bar gives another number (a loop's calls too).
          if (rt.run !== run) {
            run = rt.run;
            count = 0;
          }
          const u = random01(seed ? seed(rt) : rt.seed, site, rt.index, count++);
          return min(rt) + (max(rt) - min(rt)) * u;
        },
        call.span,
      );
    },
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
  make: () => { call(value: number, length: number, final: boolean, index: number): number },
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
  // The bar goes too: the functions that read their source by bar inside an `if` need it.
  return series('float', (rt) => fn.call(source(rt), length(rt), rt.final, rt.index), call.span);
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
    'ta.wma': (c, call, scope) => sourceLength(c, call, scope, SERIES, () => new WmaFn()),
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
        return series('bool', (rt) => fn.call(value(rt), rt.final, rt.index), call.span);
      }
      return sourceLength(c, call, scope, SERIES, () => new ChangeFn('change'), 'length', 1, 1);
    },
    'ta.vwma': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'length'], 2);
      const source = args.number('source') as NumEv;
      const lengthArg = args.get('length') as Compiled;
      const length = args.int('length') as NumEv;
      // A length that can't change keeps the kernel; one that can, the values themselves.
      const fn =
        lengthArg.qual <= SIMPLE ? c.rt.register(new VwmaFn()) : c.rt.register(new DynamicVwma());
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
      return series('float', (rt) => fn.call(source(rt), rt.final, rt.index), call.span);
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
        (rt) =>
          fn.call(rt.bar.high, rt.bar.low, rt.bar.close, handle(rt), rt.final, closeBefore(rt)),
        call.span,
      );
    },
    'ta.atr': (c, call, scope) => {
      const args = new Args(c, call, scope, ['length'], 1);
      const length = args.int('length', SIMPLE) as NumEv;
      const fn = c.rt.register(new AtrFn());
      return series(
        'float',
        (rt) =>
          fn.call(rt.bar.high, rt.bar.low, rt.bar.close, length(rt), rt.final, closeBefore(rt)),
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
        (rt) => fn.call(source(rt), high(rt), low(rt), length(rt), rt.final, rt.index),
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
    ...moreTaCalls(),
    'ta.bb': (c, call, scope) => {
      const args = new Args(c, call, scope, ['series', 'length', 'mult'], 3);
      const source = args.number('series') as NumEv;
      const lengthArg = args.get('length') as Compiled;
      const length = args.int('length') as NumEv;
      const mult = args.number('mult', SIMPLE) as NumEv;
      const fn = c.rt.register(new BbFn(lengthArg.qual > SIMPLE));
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
  const lengthArg = args.get('length') as Compiled;
  const length = args.int('length') as NumEv;
  const biased = args.bool('biased', SIMPLE) ?? (() => true);
  // A length that can't change keeps the window kernel; one that can, the values themselves.
  const fn =
    lengthArg.qual <= SIMPLE
      ? c.rt.register(new StdevFn(variance))
      : c.rt.register(new WindowStdevFn(variance));
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
    (rt) => fn.call(source(rt), length(rt), rt.final, rt.index),
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
  return series(
    'float',
    (rt) => fn.call(source(rt), left(rt), right(rt), rt.final, rt.index),
    call.span,
  );
}

/** The previous bar's close (na on the first), which ta.tr and ta.atr read by bar. */
const closeBefore = (rt: Runtime): number => rt.barBack(1)?.close ?? Number.NaN;

/** A ta.* call returning a tuple of floats. */
const floats = (items: number, ev: (rt: Runtime) => number[], span: Span): Compiled => ({
  base: 'tuple',
  items: Array.from({ length: items }, () => 'float'),
  qual: SERIES,
  ev,
  span,
});

/** The ta.* functions added in P2 (taStats.ts, taTrend.ts). */
function moreTaCalls(): Record<string, Handler> {
  /** f(source, length, …): one source and a length, the rest given by `extra`. */
  const windowed = (
    names: readonly string[],
    required: number,
    make: () => { call(...args: never[]): number },
    read: (args: Args) => NumEv[],
  ): Handler => {
    return (c, call, scope) => {
      const args = new Args(c, call, scope, names, required);
      const evs = read(args);
      const fn = c.rt.register(
        make() as unknown as Parameters<typeof c.rt.register>[0],
      ) as unknown as {
        call(...args: unknown[]): number;
      };
      return series(
        'float',
        (rt) => fn.call(...evs.map((ev) => ev(rt)), rt.final, rt.index),
        call.span,
      );
    };
  };
  const sourceAnd =
    (
      source: string,
      ...rest: [
        name: string,
        kind: 'int' | 'float' | 'bool',
        qual: Qual,
        fallback?: number | boolean,
      ][]
    ) =>
    (args: Args): NumEv[] => [
      args.number(source) as NumEv,
      ...rest.map(([name, kind, qual, fallback]) => {
        const ev =
          kind === 'int'
            ? args.int(name, qual)
            : kind === 'bool'
              ? (args.bool(name, qual) as NumEv | undefined)
              : args.number(name, qual);
        return ev ?? ((() => fallback ?? Number.NaN) as NumEv);
      }),
    ];
  return {
    'ta.alma': windowed(
      ['series', 'length', 'offset', 'sigma', 'floor'],
      4,
      () => new AlmaFn(),
      sourceAnd(
        'series',
        ['length', 'int', SERIES],
        ['offset', 'float', SIMPLE],
        ['sigma', 'float', SIMPLE],
        ['floor', 'bool', SIMPLE, false],
      ),
    ),
    'ta.median': windowed(
      ['source', 'length'],
      2,
      () => new MedianFn(),
      sourceAnd('source', ['length', 'int', SERIES]),
    ),
    'ta.mode': windowed(
      ['source', 'length'],
      2,
      () => new ModeFn(),
      sourceAnd('source', ['length', 'int', SERIES]),
    ),
    'ta.percentile_linear_interpolation': windowed(
      ['source', 'length', 'percentage'],
      3,
      () => new PercentileLinearFn(),
      sourceAnd('source', ['length', 'int', SERIES], ['percentage', 'float', SIMPLE]),
    ),
    'ta.percentile_nearest_rank': windowed(
      ['source', 'length', 'percentage'],
      3,
      () => new PercentileNearestFn(),
      sourceAnd('source', ['length', 'int', SERIES], ['percentage', 'float', SIMPLE]),
    ),
    'ta.percentrank': windowed(
      ['source', 'length'],
      2,
      () => new PercentrankFn(),
      sourceAnd('source', ['length', 'int', SERIES]),
    ),
    'ta.range': windowed(
      ['source', 'length'],
      2,
      () => new RangeFn(),
      sourceAnd('source', ['length', 'int', SERIES]),
    ),
    'ta.rci': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'length'], 2);
      const source = args.number('source') as NumEv;
      const lengthArg = args.get('length') as Compiled;
      const length = args.int('length') as NumEv;
      // A length that can't change reads slots by bar inside an `if`, as TradingView's (taStats).
      const fn = c.rt.register(new RciFn(lengthArg.qual <= SIMPLE));
      return series(
        'float',
        (rt) => fn.call(source(rt), length(rt), rt.final, rt.index),
        call.span,
      );
    },
    'ta.linreg': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'length', 'offset'], 3);
      const source = args.number('source') as NumEv;
      const lengthArg = args.get('length') as Compiled;
      const length = args.int('length') as NumEv;
      const offset = args.int('offset', SIMPLE) as NumEv;
      const fn = c.rt.register(new LinregFn(lengthArg.qual <= SIMPLE));
      return series(
        'float',
        (rt) => fn.call(source(rt), length(rt), offset(rt), rt.final, rt.index),
        call.span,
      );
    },
    'ta.cog': windowed(
      ['source', 'length'],
      2,
      () => new CogFn(),
      sourceAnd('source', ['length', 'int', SERIES]),
    ),
    'ta.cmo': windowed(
      ['series', 'length'],
      2,
      () => new CmoFn(),
      sourceAnd('series', ['length', 'int', SERIES]),
    ),
    'ta.hma': windowed(
      ['source', 'length'],
      2,
      () => new HmaFn(),
      sourceAnd('source', ['length', 'int', SIMPLE]),
    ),
    'ta.bbw': windowed(
      ['series', 'length', 'mult'],
      3,
      () => new BbwFn(),
      sourceAnd('series', ['length', 'int', SERIES], ['mult', 'float', SIMPLE]),
    ),
    'ta.tsi': windowed(
      ['source', 'short_length', 'long_length'],
      3,
      () => new TsiFn(),
      sourceAnd('source', ['short_length', 'int', SIMPLE], ['long_length', 'int', SIMPLE]),
    ),
    'ta.max': windowed(['source'], 1, () => new AllTimeFn(true), sourceAnd('source')),
    'ta.min': windowed(['source'], 1, () => new AllTimeFn(false), sourceAnd('source')),
    'ta.correlation': windowed(
      ['source1', 'source2', 'length'],
      3,
      () => new CorrelationFn(),
      (args) => [
        args.number('source1') as NumEv,
        args.number('source2') as NumEv,
        args.int('length') as NumEv,
      ],
    ),
    'ta.mfi': (c, call, scope) => {
      const args = new Args(c, call, scope, ['series', 'length'], 2);
      const source = args.number('series') as NumEv;
      const length = args.int('length') as NumEv;
      const fn = c.rt.register(new MfiFn());
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
    'ta.wpr': (c, call, scope) => {
      const args = new Args(c, call, scope, ['length'], 1);
      const length = args.int('length') as NumEv;
      const fn = c.rt.register(new WprFn());
      return series('float', (rt) => fn.call(rt.bar, length(rt), rt.final), call.span);
    },
    'ta.sar': (c, call, scope) => {
      const args = new Args(c, call, scope, ['start', 'inc', 'max'], 3);
      const start = args.number('start', SIMPLE) as NumEv;
      const inc = args.number('inc', SIMPLE) as NumEv;
      const max = args.number('max', SIMPLE) as NumEv;
      const fn = c.rt.register(new SarFn());
      return series(
        'float',
        (rt) => fn.call(rt.bar, start(rt), inc(rt), max(rt), rt.final),
        call.span,
      );
    },
    'ta.dmi': (c, call, scope) => {
      const args = new Args(c, call, scope, ['diLength', 'adxSmoothing'], 2);
      const di = args.int('diLength', SIMPLE) as NumEv;
      const adx = args.int('adxSmoothing', SIMPLE) as NumEv;
      const fn = c.rt.register(new DmiFn());
      return floats(3, (rt) => fn.call(rt.bar, di(rt), adx(rt), rt.final), call.span);
    },
    'ta.supertrend': (c, call, scope) => {
      const args = new Args(c, call, scope, ['factor', 'atrPeriod'], 2);
      const factor = args.number('factor') as NumEv;
      const period = args.int('atrPeriod', SIMPLE) as NumEv;
      const fn = c.rt.register(new SupertrendFn());
      return floats(
        2,
        (rt) => fn.call(rt.bar, closeBefore(rt), factor(rt), period(rt), rt.final),
        call.span,
      );
    },
    'ta.kc': (c, call, scope) => {
      const args = new Args(c, call, scope, ['series', 'length', 'mult', 'useTrueRange'], 3);
      const source = args.number('series') as NumEv;
      const length = args.int('length', SIMPLE) as NumEv;
      const mult = args.number('mult', SIMPLE) as NumEv;
      const trueRange = args.bool('useTrueRange', SIMPLE) ?? (() => true);
      const fn = c.rt.register(new KcFn());
      return floats(
        3,
        (rt) =>
          fn.call(
            source(rt),
            rt.bar,
            closeBefore(rt),
            length(rt),
            mult(rt),
            trueRange(rt),
            rt.final,
          ),
        call.span,
      );
    },
    'ta.kcw': (c, call, scope) => {
      const args = new Args(c, call, scope, ['series', 'length', 'mult', 'useTrueRange'], 3);
      const source = args.number('series') as NumEv;
      const length = args.int('length', SIMPLE) as NumEv;
      const mult = args.number('mult', SIMPLE) as NumEv;
      const trueRange = args.bool('useTrueRange', SIMPLE) ?? (() => true);
      const fn = c.rt.register(new KcFn());
      return series(
        'float',
        (rt) => {
          const [basis, upper, lower] = fn.call(
            source(rt),
            rt.bar,
            closeBefore(rt),
            length(rt),
            mult(rt),
            trueRange(rt),
            rt.final,
          ) as [number, number, number];
          return (upper - lower) / basis;
        },
        call.span,
      );
    },
    'ta.vwap': (c, call, scope) => {
      const args = new Args(c, call, scope, ['source', 'anchor', 'stdev_mult'], 1);
      const source = args.number('source') as NumEv;
      const anchor = args.bool('anchor');
      const mult = args.number('stdev_mult');
      const fn = c.rt.register(new VwapFn());
      // Without an anchor it starts afresh with each session (the variable's rule).
      const read = (rt: Runtime) =>
        fn.call(
          source(rt),
          rt.symbol.hasVolume ? rt.bar.volume : Number.NaN,
          anchor ? anchor(rt) : sessionOf(rt),
          mult ? mult(rt) : 0,
          rt.final,
        );
      if (mult) return floats(3, read, call.span);
      return series('float', (rt) => read(rt)[0] as number, call.span);
    },
    'ta.pivot_point_levels': (c, call, scope) => {
      const args = new Args(c, call, scope, ['type', 'anchor', 'developing'], 2);
      const type = (args.string('type') as Compiled).ev;
      const anchor = args.bool('anchor') as (rt: Runtime) => boolean;
      const developing = args.bool('developing', SIMPLE) ?? (() => false);
      const fn = c.rt.register(new PivotLevelsFn());
      return {
        base: 'array<float>',
        qual: SERIES,
        ev: (rt) => {
          rt.usesObjects = true;
          const levels = fn.call(
            rt.bar,
            String(type(rt) ?? ''),
            anchor(rt),
            developing(rt),
            rt.final,
          );
          return new PineArray('float', [...levels]);
        },
        span: call.span,
      };
    },
  };
}
