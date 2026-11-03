import { Args, type Call, type Handler } from './args.ts';
import type { Expr } from './ast.ts';
import type { Compiler, Scope, Var } from './compiler.ts';
import { capturedValue, requestNa, type SecurityOptions } from './requests.ts';
import type { Runtime } from './runtime.ts';
import {
  arrayOf,
  type Base,
  CONST,
  type Compiled,
  type FoldEnv,
  isCollection,
  maxQual,
  SERIES,
  SIMPLE,
} from './types.ts';
import type { Value } from './values.ts';

/**
 * request.security() and its family, compiled (TradingView's Pine docs, Other timeframes and
 * data; the v6 reference). The values come from the run's RequestBroker (requests.ts); in a
 * request's context program, the call being copied captures its expression instead.
 */

const SECURITY_PARAMS = [
  'symbol',
  'timeframe',
  'expression',
  'gaps',
  'lookahead',
  'ignore_invalid_symbol',
  'currency',
  'calc_bars_count',
] as const;

/**
 * "All the request.*() function calls in a script taken together cannot return more than 127
 * tuple elements" (Pine docs, Limitations).
 */
export const MAX_TUPLE_ELEMENTS = 127;

/** How many tuple elements the requests compiled so far return, per compile. */
const tupleElements = new WeakMap<Compiler, number>();

/** A request's expression: a tuple in brackets, or any value but a tuple of tuples. */
function expressionOf(c: Compiler, call: Call, scope: Scope, args: Args): Compiled {
  const raw = args.raw('expression');
  if (!raw) return c.fail(`'${call.callee}' needs an expression to request`, call.span);
  if (raw.value.kind === 'list') return tupleOf(c, raw.value, scope);
  const value = args.get('expression') as Compiled;
  if (value.base === 'void') {
    return c.fail(`The expression of '${call.callee}' has no value to request`, value.span);
  }
  return value;
}

function tupleOf(c: Compiler, list: Extract<Expr, { kind: 'list' }>, scope: Scope): Compiled {
  const items = list.items.map((item) => c.expr(item, scope));
  for (const item of items) {
    if (item.base === 'tuple' || item.base === 'void') {
      c.fail("A tuple's items can't be tuples", item.span);
    }
  }
  const evs = items.map((item) => item.ev);
  return {
    base: 'tuple',
    items: items.map((item): Base => (item.base === 'na' ? 'float' : item.base)),
    qual: maxQual(CONST, ...items.map((item) => item.qual)),
    ev: (rt) => evs.map((ev) => ev(rt)),
    span: list.span,
  };
}

/**
 * A merge setting: a barmerge constant, or in v4 and older a bool as well (`security(id, "D",
 * open, true, lookahead = true)`, as their scripts and the v3 migration guide write it).
 */
function merging(
  c: Compiler,
  args: Args,
  name: 'gaps' | 'lookahead',
  base: Base,
  on: string,
  fallback: string,
): (env: FoldEnv) => Value {
  const given = args.get(name);
  if (given && given.base === 'bool' && c.version <= 4) {
    const fold = args.foldedAs(name, 'bool', false);
    return (env) => (fold(env) === true ? on : on.replace('_on', '_off'));
  }
  return args.foldedAs(name, base, fallback, SIMPLE);
}

const securityCall: Handler = (c, call, scope) => {
  const args = new Args(c, call, scope, SECURITY_PARAMS, 3);
  // In a request's context program, the call being copied gives its expression's value on each
  // of the context's bars.
  if (c.capturing(call)) return capture(expressionOf(c, call, scope, args), call.span);
  const reads = new Set<Var>();
  const value = c.collectReads(reads, () => expressionOf(c, call, scope, args));
  countTuple(c, value);
  // Without dynamic requests, the context can't change from bar to bar (Pine docs, "series"
  // arguments): the symbol and the timeframe must be known by the first bar.
  const most = c.dynamicRequests() ? SERIES : SIMPLE;
  const symbol = (args.string('symbol', most) as Compiled).ev;
  const timeframe = (args.string('timeframe', most) as Compiled).ev;
  const gaps = merging(c, args, 'gaps', 'barmerge_gaps', 'gaps_on', 'gaps_off');
  // lookahead_off is the default from v3 on; v1 and v2 looked ahead (the v6 reference).
  const lookahead = merging(
    c,
    args,
    'lookahead',
    'barmerge_lookahead',
    'lookahead_on',
    c.version <= 2 ? 'lookahead_on' : 'lookahead_off',
  );
  const ignore = args.foldedAs('ignore_invalid_symbol', 'bool', false);
  const currency = args.string('currency')?.ev ?? null;
  const calcBars = args.foldedAs('calc_bars_count', 'int', Number.NaN, SIMPLE);
  const site = c.requestSite(call, reads, { base: value.base, items: value.items });
  const na = requestNa(value.base, value.items);
  // The options are the inputs' alone: worked out once a run.
  let seen: readonly Value[] | null = null;
  let options: SecurityOptions | null = null;
  const optionsOf = (rt: Runtime): SecurityOptions => {
    if (options && seen === rt.inputs) return options;
    const env: FoldEnv = { inputs: rt.inputs };
    const bars = calcBars(env);
    options = {
      gaps: gaps(env) === 'gaps_on',
      lookahead: lookahead(env) === 'lookahead_on',
      ignoreInvalid: ignore(env) === true,
      calcBars: typeof bars === 'number' && bars > 0 ? Math.floor(bars) : null,
    };
    seen = rt.inputs;
    return options;
  };
  return {
    base: value.base,
    items: value.items,
    qual: SERIES,
    ev: (rt) => {
      const broker = rt.requests;
      if (!broker) return na;
      const wanted = currency ? String(currency(rt) ?? '') : '';
      return broker.security(
        site,
        String(symbol(rt) ?? ''),
        String(timeframe(rt) ?? ''),
        optionsOf(rt),
        rt,
        wanted,
      );
    },
    span: call.span,
  };
};

const LOWER_TF_PARAMS = [
  'symbol',
  'timeframe',
  'expression',
  'ignore_invalid_symbol',
  'currency',
  'ignore_invalid_timeframe',
  'calc_bars_count',
] as const;

/**
 * request.security_lower_tf(): every intrabar's value in each chart bar, as an array (a tuple of
 * arrays for a tuple). Its expression can't be a collection: "arrays cannot directly reference
 * other collections" (Pine docs, request.security_lower_tf(): Requesting collections).
 */
const lowerTfCall: Handler = (c, call, scope) => {
  const args = new Args(c, call, scope, LOWER_TF_PARAMS, 3);
  if (c.capturing(call)) return capture(expressionOf(c, call, scope, args), call.span);
  const reads = new Set<Var>();
  const value = c.collectReads(reads, () => expressionOf(c, call, scope, args));
  const parts = value.base === 'tuple' ? (value.items ?? []) : [value.base];
  for (const part of parts) {
    if (isCollection(part)) {
      c.fail(
        `'request.security_lower_tf' can't request a collection: wrap it in a user-defined type's field`,
        value.span,
      );
    }
  }
  countTuple(c, value);
  const most = c.dynamicRequests() ? SERIES : SIMPLE;
  const symbol = (args.string('symbol', most) as Compiled).ev;
  const timeframe = (args.string('timeframe', most) as Compiled).ev;
  const ignore = args.foldedAs('ignore_invalid_symbol', 'bool', false);
  const ignoreTimeframe = args.foldedAs('ignore_invalid_timeframe', 'bool', false);
  const currency = args.string('currency')?.ev ?? null;
  const calcBars = args.foldedAs('calc_bars_count', 'int', Number.NaN, SIMPLE);
  const elem = (base: Base): Base => arrayOf(base === 'na' ? 'float' : base);
  const items = value.base === 'tuple' ? (value.items ?? []).map(elem) : undefined;
  const base: Base = value.base === 'tuple' ? 'tuple' : elem(value.base);
  const site = c.requestSite(call, reads, { base, items });
  const na = requestNa(base, items);
  let seen: readonly Value[] | null = null;
  let options: (SecurityOptions & { ignoreInvalidTimeframe: boolean }) | null = null;
  const optionsOf = (rt: Runtime) => {
    if (options && seen === rt.inputs) return options;
    const env: FoldEnv = { inputs: rt.inputs };
    const bars = calcBars(env);
    options = {
      gaps: false,
      lookahead: false,
      ignoreInvalid: ignore(env) === true,
      ignoreInvalidTimeframe: ignoreTimeframe(env) === true,
      calcBars: typeof bars === 'number' && bars > 0 ? Math.floor(bars) : null,
    };
    seen = rt.inputs;
    return options;
  };
  return {
    base,
    items,
    qual: SERIES,
    ev: (rt) => {
      const broker = rt.requests;
      if (!broker) return na;
      return broker.lowerTf(
        site,
        String(symbol(rt) ?? ''),
        String(timeframe(rt) ?? ''),
        optionsOf(rt),
        rt,
        currency ? String(currency(rt) ?? '') : '',
      );
    },
    span: call.span,
  };
};

/** In a context program, the request being copied: its expression's value on each bar. */
function capture(value: Compiled, span: Compiled['span']): Compiled {
  const ev = value.ev;
  return {
    base: 'void',
    qual: SERIES,
    ev: (rt) => {
      rt.capture(capturedValue(ev(rt)));
      return null;
    },
    span,
  };
}

/** Counts a request's tuple elements toward Pine's limit for the whole script. */
function countTuple(c: Compiler, value: Compiled): void {
  if (value.base !== 'tuple') return;
  const total = (tupleElements.get(c) ?? 0) + (value.items?.length ?? 0);
  tupleElements.set(c, total);
  if (total > MAX_TUPLE_ELEMENTS) {
    c.fail(
      `The requests return ${total} tuple elements in all: the limit is ${MAX_TUPLE_ELEMENTS}`,
      value.span,
    );
  }
}

/**
 * request.currency_rate(from, to, ignore_invalid_currency): the daily rate converting `from` into
 * `to`, from the day before each bar (Pine docs, request.currency_rate()).
 */
const currencyRateCall: Handler = (c, call, scope) => {
  const args = new Args(c, call, scope, ['from', 'to', 'ignore_invalid_currency'], 2);
  const from = (args.string('from') as Compiled).ev;
  const to = (args.string('to') as Compiled).ev;
  const ignore = args.foldedAs('ignore_invalid_currency', 'bool', false);
  return {
    base: 'float',
    qual: SERIES,
    ev: (rt) => {
      const broker = rt.requests;
      if (!broker) return Number.NaN;
      return broker.currencyRate(
        String(from(rt) ?? ''),
        String(to(rt) ?? ''),
        ignore({ inputs: rt.inputs }) === true,
        rt,
        call.span,
      );
    },
    span: call.span,
  };
};

/** The request.*() functions built so far. */
export function requestCalls(): Record<string, Handler> {
  return {
    'request.security': securityCall,
    'request.security_lower_tf': lowerTfCall,
    'request.currency_rate': currencyRateCall,
  };
}
