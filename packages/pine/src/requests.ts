import {
  type Bar,
  formatResolution,
  parseResolution,
  type Resolution,
  resolutionDurationMs,
} from '@tradingnerd/core';
import type { Expr, Stmt } from './ast.ts';
import type { CompiledProgram } from './compiler.ts';
import { PineRuntimeError, type Span } from './diagnostics.ts';
import { CHECKS, Execution, type RunClock, type ScriptError, scaledBar } from './execution.ts';
import type { Runtime, ScriptSymbol } from './runtime.ts';
import { parseTickerId } from './tickers.ts';
import { type Base, elemOf, naOf } from './types.ts';
import { PineArray, PineMap, PineMatrix, PineObject, type Value } from './values.ts';
import { Agreement, drawnFrom } from './warmup.ts';

/**
 * Data from other symbols and timeframes: request.security() and its family (TradingView's Pine
 * docs, Other timeframes and data; docs/SPEC.md §6.18).
 *
 * Each request evaluates its expression in another context: a copy of the code before the call
 * that the expression depends on runs over that context's own bars (the compiler finds that code
 * and compiles it as a context program: compiler.ts, ContextPlan). The values it gives on each of
 * those bars are then merged onto the chart's bars by TradingView's rules (alignBar).
 */

/** A context a request asks for: a symbol on a timeframe, and its hours and adjustment. */
export interface RequestKey {
  /** The symbol, upper case ("BINANCE:BTCUSDT"); the chart's when the script gives "". */
  readonly symbol: string;
  /** The timeframe in TradingView's notation, written the standard way ("60", "1D", "1W"). */
  readonly timeframe: string;
  /** Intraday bars with the hours before and after the session (ticker.new's session.extended). */
  readonly session?: 'extended';
  /** A stock's prices adjusted otherwise than for splits alone: "dividends" too, or "none". */
  readonly adjustment?: 'none' | 'dividends';
}

export const requestKeyText = (key: RequestKey): string =>
  `${key.symbol}@${key.timeframe}${key.session ? ':extended' : ''}${key.adjustment ? `:${key.adjustment}` : ''}`;

/** A context's bars, as the app has them. */
export interface ContextData {
  /**
   * What syminfo.* and timeframe.* say inside the request: the requested symbol's, on the
   * requested timeframe (its `timeframe`).
   */
  readonly symbol: ScriptSymbol;
  /** Oldest first; the last may still be forming. */
  readonly bars: readonly Bar[];
  /** Whether the last bar is still forming. */
  readonly live: boolean;
  /** Whether the first bar is the symbol's listing: nothing earlier exists, as on TradingView. */
  readonly fromListing: boolean;
  /** Changes whenever the bars do, so a run can tell there's something new. */
  readonly version: number;
  /**
   * Changes when the bars change other than by the live bar moving or new bars opening after it
   * (a page of history, a reload, a correction): a run then starts afresh.
   */
  readonly history: number;
}

/** Where a script's requests get their data: the app's loader, or a test's bars. */
export interface RequestFeed {
  /**
   * A context's bars; 'invalid' when the symbol or timeframe doesn't exist; null while it isn't
   * loaded yet (the run then lists it as missing, and the app loads it and runs the script again).
   */
  data(key: RequestKey): ContextData | 'invalid' | null;
  /**
   * How prices in `from` convert into `to`: the currency pairs whose daily closes do it, each
   * read as its price or its inverse (TRY to KRW might go through USD, as the Pine docs'
   * request.currency_rate() example does); null when there's no way. Absent: none convert.
   */
  rates?(from: string, to: string): readonly CurrencyLeg[] | null;
}

/** One step of a currency conversion: a pair's daily close, or its inverse. */
export interface CurrencyLeg {
  readonly symbol: string;
  readonly invert: boolean;
}

/**
 * How a context program is made (compiler.ts): the request call it captures, the statements
 * before it that its expression depends on, and the way down to it through blocks and functions.
 */
export interface ContextPlan {
  /** The request call whose expression the context program captures. */
  readonly target: Extract<Expr, { kind: 'call' }>;
  /** The statements before it its expression depends on (Pine docs: "duplicates all preceding code"). */
  readonly keep: ReadonlySet<Stmt>;
  /** Its path: each statement or expression on the way to it, to the next one. */
  readonly next: ReadonlyMap<object, object>;
  /** Each input call's index in the script, by where it is: a copy reads the same inputs. */
  readonly inputs: ReadonlyMap<string, number>;
}

/** One request call in a compiled program. */
export interface RequestSite {
  /** Unique in the script: where the call is, and the calls of the functions it's in. */
  readonly id: string;
  readonly plan: ContextPlan;
  /**
   * The expression's code, when it depends on no code of the script's: identical requests share
   * their context then (Pine counts them as one).
   */
  readonly shared: string | null;
  readonly base: Base;
  readonly items: readonly Base[] | undefined;
  readonly span: Span;
}

/** How a request.security() call merges its values onto the chart's bars. */
export interface SecurityOptions {
  /** barmerge.gaps_on: a value only where it first becomes available, na elsewhere. */
  readonly gaps: boolean;
  /** barmerge.lookahead_on: a higher timeframe's bar from its start (Pine docs: a future leak). */
  readonly lookahead: boolean;
  /** ignore_invalid_symbol: na for a symbol that doesn't exist, rather than an error. */
  readonly ignoreInvalid: boolean;
  /** calc_bars_count: only this many of the context's latest bars count, null for all. */
  readonly calcBars: number | null;
  /** `currency`: the currency to convert the context's prices to; "" for its own. */
  readonly currency?: string;
}

/** "A script can use up to 40 unique calls to the functions in the request.*() namespace" (Pine docs, Limitations). */
export const MAX_REQUESTS = 40;

// ---- values ----

/** A request's value when there is none: na, false for a bool, a tuple of them. */
export function requestNa(base: Base, items: readonly Base[] | undefined): Value {
  return base === 'tuple' ? (items ?? []).map(naOf) : naOf(base);
}

/**
 * A copy of a value that holds collections or objects, so the context's later changes don't
 * reach what it gave (and the script's don't reach the context's).
 */
export function copyValue(value: Value, seen: Map<object, Value> = new Map()): Value {
  if (value === null || typeof value !== 'object') return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (Array.isArray(value)) {
    const out: Value[] = [];
    seen.set(value, out);
    for (const item of value) out.push(copyValue(item, seen));
    return out;
  }
  if (value instanceof PineArray) {
    const out = new PineArray(value.elem, []);
    seen.set(value, out);
    out.items = value.items.map((item) => copyValue(item, seen));
    return out;
  }
  if (value instanceof PineMatrix) {
    const out = new PineMatrix(value.elem, value.rows, value.cols, []);
    seen.set(value, out);
    out.data = value.data.map((item) => copyValue(item, seen));
    return out;
  }
  if (value instanceof PineMap) {
    const out = new PineMap(value.key, value.value);
    seen.set(value, out);
    for (const [k, v] of value.entries) out.entries.set(k, copyValue(v, seen));
    return out;
  }
  if (value instanceof PineObject) {
    const out = new PineObject(value.type, []);
    seen.set(value, out);
    for (const field of value.fields) out.fields.push(copyValue(field, seen));
    return out;
  }
  // Enum members are the same objects in every compile (values.ts); output handles never change.
  return value;
}

/** Whether a value holds collections or objects, which a copy must take apart. */
function holdsObjects(value: Value): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(holdsObjects);
  return !('ordinal' in value) && !('output' in value);
}

/** A value as a context gives it on: its own copy when it holds objects. */
export const capturedValue = (value: Value): Value =>
  holdsObjects(value) ? copyValue(value) : value;

// ---- merging onto the chart's bars ----

/** A chart bar, and the one before it, for alignBar. */
export interface ChartBarTimes {
  /** Its opening and closing times, ms. */
  readonly open: number;
  readonly close: number;
  /** The bar before it's, NaN for the first bar. */
  readonly prevOpen: number;
  readonly prevClose: number;
  /** A realtime bar (the live one, and those that have closed since the script loaded). */
  readonly realtime: boolean;
}

/** A context's bars' times, for alignBar. */
export interface ContextTimes {
  readonly opens: ArrayLike<number>;
  readonly closes: ArrayLike<number>;
  readonly count: number;
  /** Whether its last bar is still forming. */
  readonly live: boolean;
}

/** The last index whose value is ≤ (or <, when `strict`) `x` in an ascending list; -1 for none. */
function lastAtMost(list: ArrayLike<number>, count: number, x: number, strict: boolean): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid] as number;
    if (strict ? v < x : v <= x) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Which of the context's bars gives a chart bar its value, or -1 for na (Pine docs, Other
 * timeframes and data: `gaps`, `lookahead`, Higher timeframes, Lower timeframes, Historical and
 * realtime behavior; the v6 reference, request.security).
 *
 * - A timeframe at least the chart's: on history, the last bar that has closed by the chart bar's
 *   close ("a new historical value at the end of each period"); with lookahead the bar the chart
 *   bar opens in ("at the start"). On realtime bars, the context's latest bar, still forming
 *   ("recalculated values on each chart bar"); lookahead "has no effect on realtime values".
 * - A lower timeframe: of the bars inside the chart bar, the last; with lookahead the first; on
 *   realtime bars the latest, "regardless of the lookahead value" (measured by others on
 *   TradingView: the first or the last 5-minute close of each hour on 2,999 of 2,999 bars).
 * - gaps_on: the value only on the chart bar where it first becomes available, na elsewhere;
 *   gaps_off fills the rest with the latest value.
 * Between sessions (a stock's bars on a crypto chart) the latest bar fills in, as gaps_off does.
 * How bars of different sessions line up beyond that isn't documented: provisional (§11).
 */
export function alignBar(
  chart: ChartBarTimes,
  ctx: ContextTimes,
  lower: boolean,
  options: { readonly gaps: boolean; readonly lookahead: boolean },
): number {
  const { opens, closes, count } = ctx;
  if (count === 0) return -1;
  // The bars that have closed: all but a live one.
  const closed = ctx.live ? count - 1 : count;
  if (lower) {
    // Intrabars: the context's bars opening inside [open, close).
    const last = lastAtMost(opens, count, chart.close, true);
    if (chart.realtime) {
      if (last < 0) return -1;
      return options.gaps && (opens[last] as number) < chart.open ? -1 : last;
    }
    const first = lastAtMost(opens, count, chart.open, true) + 1;
    if (first <= last) return options.lookahead ? first : last;
    // None inside this bar: the latest before it, unless gaps are asked for.
    return options.gaps ? -1 : last;
  }
  if (chart.realtime) {
    const latest = lastAtMost(opens, count, chart.close, true);
    if (!options.gaps) return latest;
    // gaps_on on a realtime bar: only a bar confirmed during this one (provisional, §11).
    const done = lastAtMost(closes, closed, chart.close, false);
    if (done < 0) return -1;
    const since = Number.isNaN(chart.prevClose) ? chart.open : chart.prevClose;
    return (closes[done] as number) > since ? done : -1;
  }
  if (options.lookahead) {
    const j = lastAtMost(opens, count, chart.open, false);
    if (j < 0 || !options.gaps) return j;
    // gaps_on: only on the first chart bar of the period.
    return Number.isNaN(chart.prevOpen) || (opens[j] as number) > chart.prevOpen ? j : -1;
  }
  const j = lastAtMost(closes, closed, chart.close, false);
  if (j < 0 || !options.gaps) return j;
  const since = Number.isNaN(chart.prevClose) ? chart.open : chart.prevClose;
  return (closes[j] as number) > since ? j : -1;
}

/** How long a timeframe's bars are, ms, to tell higher from lower (a month as 30 days, a tick as 0). */
function spanOf(resolution: Resolution): number {
  if (resolution.unit === 'tick') return 0;
  if (resolution.unit === 'month') return resolution.count * 30 * 86_400_000;
  return resolutionDurationMs(resolution) ?? 0;
}

/** A timeframe in TradingView's notation written the standard way ("D" → "1D"), or null. */
export function canonicalTimeframe(text: string): string | null {
  const resolution = parseResolution(text);
  return resolution ? formatResolution(resolution) : null;
}

/** Whether bars of `a` are shorter than bars of `b` (two timeframes in TradingView's notation). */
export function isLower(a: string, b: string): boolean {
  const ra = parseResolution(a);
  const rb = parseResolution(b);
  return ra !== null && rb !== null && spanOf(ra) < spanOf(rb);
}

/** Bars' opening and closing times, ms, by their symbol's clock. */
export function timesOf(
  bars: readonly Bar[],
  symbol: ScriptSymbol,
  timeframe: string,
): { opens: Float64Array; closes: Float64Array } {
  const resolution = parseResolution(timeframe) ?? { count: 1, unit: 'day' };
  const opens = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) opens[i] = openOf(bars[i] as Bar);
  return { opens, closes: closesOf(bars, symbol, resolution) };
}

/** A bar's opening time, ms (a tick bar's `time` is its number; `start` its time). */
const openOf = (bar: Bar): number => bar.start ?? bar.time * 1000;

/** When each bar of a list closes, ms: by its clock, a tick bar where the next opens. */
function closesOf(
  bars: readonly Bar[],
  symbol: ScriptSymbol,
  resolution: Resolution,
): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const open = openOf(bars[i] as Bar);
    if (resolution.unit === 'tick') {
      const next = bars[i + 1];
      out[i] = next ? openOf(next) : Number.POSITIVE_INFINITY;
    } else out[i] = symbol.clock.close(resolution, open);
  }
  return out;
}

// ---- non-standard bars ----

/**
 * Heikin Ashi's bars from a symbol's own (Pine docs, Non-standard charts data): the close is the
 * bar's average price, the open the middle of the one before's open and close (the first's, of
 * its own open and close), and the high and low the extremes of those and the bar's.
 */
export function heikinAshiBars(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let open = Number.NaN;
  let close = Number.NaN;
  for (const bar of bars) {
    const haClose = (bar.open + bar.high + bar.low + bar.close) / 4;
    const haOpen = Number.isNaN(open) ? (bar.open + bar.close) / 2 : (open + close) / 2;
    out.push({
      ...bar,
      open: haOpen,
      close: haClose,
      high: Math.max(bar.high, haOpen, haClose),
      low: Math.min(bar.low, haOpen, haClose),
    });
    open = haOpen;
    close = haClose;
  }
  return out;
}

/**
 * How many of Heikin Ashi's bars its first bar still shows in: each open halves the one before's
 * weight, so after this many it's below the warm-up rule's SETTLED_WEIGHT (1e-9).
 */
const HEIKIN_ASHI_WARMUP = 30;

/** A request whose prices nothing converts to the currency it asks for. */
const noRate = (symbol: string, currency: string, span: Span): PineRuntimeError =>
  new PineRuntimeError(`Cannot convert ${symbol}'s prices to ${currency}: no rate is known`, span);

// ---- contexts ----

/**
 * One context's run: the context program over the context's bars, its values bar by bar, and the
 * warm-up rule's checks (script.ts), so a value that still depends on bars not loaded isn't
 * trusted.
 */
export class ContextRun {
  readonly resolution: Resolution;
  /** The first of its bars whose values no longer depend on bars not loaded (Infinity: none). */
  settledFrom = 0;
  opens: Float64Array = new Float64Array(0);
  closes: Float64Array = new Float64Array(0);
  live = false;
  /** The currency its prices are in (syminfo.currency inside it). */
  currency = '';
  private main: Execution | null = null;
  private checks: Execution[] = [];
  private data: ContextData | null = null;
  /** Where its bars start in the data (calc_bars_count keeps only the latest). */
  private from = 0;
  private readonly store: ContextStore;
  private readonly plan: ContextPlan;
  private readonly calcBars: number | null;
  /** Bars its data's own making needs before it's trusted (Heikin Ashi's opens): 0 for none. */
  private readonly warmup: number;

  constructor(
    store: ContextStore,
    plan: ContextPlan,
    resolution: Resolution,
    calcBars: number | null,
    warmup = 0,
  ) {
    this.store = store;
    this.plan = plan;
    this.resolution = resolution;
    this.calcBars = calcBars;
    this.warmup = warmup;
  }

  get error(): ScriptError | null {
    return this.main?.error ?? null;
  }

  get count(): number {
    return this.opens.length;
  }

  /** Its value on its bar `j`, copied when it holds objects. */
  value(j: number, base: Base, items: readonly Base[] | undefined): Value {
    const captured = this.main?.runtime.captured[j];
    if (captured === undefined) return requestNa(base, items);
    return capturedValue(captured);
  }

  /** Brings the run up to the data's version: the live bar again, new bars, or afresh. */
  ensure(data: ContextData): void {
    const before = this.data;
    const main = this.main;
    if (main && before && before.version === data.version && before.history === data.history) {
      return;
    }
    this.data = data;
    const lastFrom = this.from;
    const bars = this.window(data);
    const incremental = main && before && before.history === data.history && this.from === lastFrom;
    if (incremental && bars.length >= main.length && main.length > 0) {
      if (bars.length === main.length) {
        for (const run of this.runs()) run.tick(bars);
      } else {
        // Each new bar commits the one before it, as the chart's own do.
        for (let n = main.length + 1; n <= bars.length; n++) {
          const upTo = n === bars.length ? bars : bars.slice(0, n);
          for (const run of this.runs()) run.next(upTo);
        }
      }
      this.times(bars, data);
      return;
    }
    this.full(bars, data);
  }

  /** The bars that count: all of them, or the latest calc_bars_count (and the live one). */
  private window(data: ContextData): readonly Bar[] {
    const bars = data.bars;
    const limit = this.calcBars;
    if (limit === null || limit <= 0) {
      this.from = 0;
      return bars;
    }
    const historical = data.live ? bars.length - 1 : bars.length;
    this.from = Math.max(0, historical - limit);
    return this.from === 0 ? bars : bars.slice(this.from);
  }

  private *runs(): Generator<Execution> {
    if (this.main) yield this.main;
    yield* this.checks;
  }

  private full(bars: readonly Bar[], data: ContextData): void {
    const realtimeFrom = data.live ? Math.max(0, bars.length - 1) : bars.length;
    const make = (start: number, changed: readonly Bar[]) => {
      const program = this.store.compile(this.plan);
      const execution = new Execution(
        program,
        this.store.inputs,
        data.symbol,
        start,
        changed,
        realtimeFrom,
        this.store.clock,
      );
      const rt = program.runtime;
      rt.secondary = true;
      rt.main = this.store.main;
      rt.requests = new RequestBroker(this.store);
      return execution;
    };
    this.main = make(0, []);
    this.main.all(bars);
    // The warm-up rule's checks, unless nothing earlier exists (or this history is too short).
    const checking = !data.fromListing && this.from === 0 && bars.length >= 2 && !this.main.error;
    this.checks = checking
      ? CHECKS.map((check) =>
          make(
            check.start,
            check.scales.map((scale, i) => scaledBar(bars[i] as Bar, scale)),
          ),
        )
      : [];
    for (const check of this.checks) check.all(bars);
    this.times(bars, data);
    this.settledFrom = this.settle(bars.length, data.fromListing || this.from > 0);
    if (!data.fromListing) this.settledFrom = Math.max(this.settledFrom, this.warmup);
  }

  private times(bars: readonly Bar[], data: ContextData): void {
    this.live = data.live;
    this.currency = data.symbol.currency;
    if (this.opens.length === bars.length) return;
    const opens = new Float64Array(bars.length);
    for (let i = 0; i < bars.length; i++) opens[i] = openOf(bars[i] as Bar);
    this.opens = opens;
    this.closes = closesOf(bars, data.symbol, this.resolution);
  }

  /**
   * Where its values are trusted from: every numeric part of what it gives (a number, a bool, a
   * color, a tuple's items) agrees with each check from there on (warmup.ts). Strings and objects
   * aren't compared.
   */
  private settle(length: number, whole: boolean): number {
    if (whole) return 0;
    const main = this.main as Execution;
    const usable = this.checks.filter((check) => check.error === null);
    if (length < 2 || usable.length === 0) return Number.POSITIVE_INFINITY;
    const parts = numericParts(main.runtime.captured, length);
    let last = -1;
    let remembers = false;
    for (const [k, own] of parts) {
      this.checks.forEach((check, c) => {
        if (check.error !== null) return;
        const theirs = project(check.runtime.captured, length, k);
        const memory = CHECKS[c]?.memory ?? false;
        const agreement = new Agreement(false, memory);
        agreement.rebuild(own, theirs, length - 1);
        if (memory) remembers ||= agreement.remembers(own, theirs, length);
        else last = Math.max(last, agreement.lastDisagreement(own, theirs, length));
      });
    }
    return drawnFrom(last, remembers, length);
  }
}

/** A captured value's numeric parts by index (-1 for the value itself): numbers, bools, colors. */
function numericParts(captured: readonly Value[], length: number): [number, Float64Array][] {
  let sample: Value | undefined;
  for (let i = length - 1; i >= 0 && sample === undefined; i--) sample = captured[i];
  if (sample === undefined) return [];
  const keys: number[] = [];
  if (Array.isArray(sample)) {
    sample.forEach((item, k) => {
      if (typeof item === 'number' || typeof item === 'boolean') keys.push(k);
    });
  } else if (typeof sample === 'number' || typeof sample === 'boolean') keys.push(-1);
  return keys.map((k) => [k, project(captured, length, k)]);
}

function project(captured: readonly Value[], length: number, k: number): Float64Array {
  const out = new Float64Array(length).fill(Number.NaN);
  for (let i = 0; i < length; i++) {
    const value = captured[i];
    const part = k < 0 ? value : Array.isArray(value) ? value[k] : undefined;
    if (typeof part === 'number') out[i] = part;
    else if (typeof part === 'boolean') out[i] = part ? 1 : 0;
  }
  return out;
}

/**
 * Every context one load of a script uses, shared by its runs (the script's own and the warm-up
 * checks', and requests inside requests): each context runs once however many runs read it.
 */
export class ContextStore {
  readonly feed: RequestFeed;
  readonly compile: (plan: ContextPlan) => CompiledProgram;
  readonly inputs: readonly Value[];
  /** The chart's symbol: syminfo.main_tickerid and timeframe.main_period inside a request. */
  readonly main: ScriptSymbol;
  readonly clock: RunClock;
  /** Contexts asked for that the feed hasn't loaded yet, by their text. */
  readonly missing = new Map<string, RequestKey>();
  /** Every context asked for, by its text. */
  readonly used = new Map<string, RequestKey>();
  /** Each request's contexts asked for on the chart's history: realtime bars may read only these. */
  readonly history = new Set<string>();
  private readonly runs = new Map<string, ContextRun>();
  /** Each unique request: Pine's limit counts them. */
  private readonly unique = new Set<string>();

  constructor(
    feed: RequestFeed,
    compile: (plan: ContextPlan) => CompiledProgram,
    inputs: readonly Value[],
    main: ScriptSymbol,
    clock: RunClock,
  ) {
    this.feed = feed;
    this.compile = compile;
    this.inputs = inputs;
    this.main = main;
    this.clock = clock;
  }

  /** Bars made from the feed's (Heikin Ashi's), by the key's text, with what they came from. */
  private readonly made = new Map<string, { from: ContextData; data: ContextData }>();
  /** Prices converted to another currency, by the key's text, with what they came from. */
  private readonly converted = new Map<
    string,
    { from: ContextData; legs: readonly ContextData[]; data: ContextData }
  >();
  /** Each currency pair's way, by "FROM>TO". */
  private readonly ways = new Map<string, readonly CurrencyLeg[] | null>();
  /** Each pair's days' closing times. */
  private readonly legCloses = new WeakMap<ContextData, Float64Array>();

  /**
   * The run of a context for a request, or why there's none. `type` asks for non-standard bars
   * made from the symbol's own ("heikinashi").
   */
  run(
    site: RequestSite,
    key: RequestKey,
    options: SecurityOptions,
    type: string | null = null,
  ): ContextRun | 'missing' | 'invalid' | 'no rate' {
    const currency = (options.currency ?? '').toUpperCase();
    const text = `${requestKeyText(key)}${type ? `#${type}` : ''}${currency ? `$${currency}` : ''}`;
    this.used.set(text, key);
    const resolution = parseResolution(key.timeframe);
    if (!resolution) return 'invalid';
    const call = `${site.shared ?? site.id}|${text}|${options.gaps}|${options.lookahead}|${options.calcBars}`;
    if (!this.unique.has(call)) {
      this.unique.add(call);
      if (this.unique.size > MAX_REQUESTS) {
        throw new PineRuntimeError(
          `Script requests too many securities: ${this.unique.size}. The limit is ${MAX_REQUESTS}`,
          site.span,
        );
      }
    }
    const fed = this.feed.data(key);
    if (fed === null) {
      this.missing.set(requestKeyText(key), key);
      return 'missing';
    }
    if (fed === 'invalid') return 'invalid';
    if (type !== null && type !== 'heikinashi') return 'invalid';
    let data = fed;
    if (currency && currency !== fed.symbol.currency.toUpperCase()) {
      const made = this.convert(text, fed, currency);
      if (made === 'missing' || made === 'no rate')
        return made === 'missing' ? 'missing' : 'no rate';
      data = made;
    }
    if (type === 'heikinashi') data = this.heikinAshi(text, data);
    const id = `${site.shared ?? site.id}|${text}|${options.calcBars}`;
    let run = this.runs.get(id);
    if (!run) {
      const warmup = type === 'heikinashi' ? HEIKIN_ASHI_WARMUP : 0;
      run = new ContextRun(this, site.plan, resolution, options.calcBars, warmup);
      this.runs.set(id, run);
    }
    run.ensure(data);
    return run;
  }

  /**
   * A currency's rate into another at a moment: the product of its pairs' last daily closes
   * before it ("the previous daily value", the v6 reference), so it never repaints. 'missing'
   * while a pair's days load; 'no rate' when nothing converts them.
   */
  rateAt(from: string, to: string, ms: number): number | 'missing' | 'no rate' {
    const legs = this.legs(from, to);
    if (legs === 'missing' || legs === 'no rate') return legs;
    return this.rateWith(legs, ms);
  }

  private rateWith(
    legs: readonly { leg: CurrencyLeg; data: ContextData; closes: Float64Array }[],
    ms: number,
  ): number {
    let rate = 1;
    for (const { leg, data, closes } of legs) {
      const closed = data.live ? data.bars.length - 1 : data.bars.length;
      const j = lastAtMost(closes, closed, ms, false);
      if (j < 0) return Number.NaN;
      const close = (data.bars[j] as Bar).close;
      rate *= leg.invert ? 1 / close : close;
    }
    return rate;
  }

  /** The pairs that convert `from` into `to`, with their days, or why there are none. */
  private legs(
    from: string,
    to: string,
  ): { leg: CurrencyLeg; data: ContextData; closes: Float64Array }[] | 'missing' | 'no rate' {
    const name = `${from.toUpperCase()}>${to.toUpperCase()}`;
    let way = this.ways.get(name);
    if (way === undefined) {
      way = this.feed.rates?.(from.toUpperCase(), to.toUpperCase()) ?? null;
      this.ways.set(name, way);
    }
    if (!way) return 'no rate';
    const out: { leg: CurrencyLeg; data: ContextData; closes: Float64Array }[] = [];
    let missing = false;
    for (const leg of way) {
      const key: RequestKey = { symbol: leg.symbol.toUpperCase(), timeframe: '1D' };
      const data = this.feed.data(key);
      if (data === null) {
        this.missing.set(requestKeyText(key), key);
        missing = true;
        continue;
      }
      if (data === 'invalid') return 'no rate';
      this.used.set(requestKeyText(key), key);
      let closes = this.legCloses.get(data);
      if (!closes) {
        closes = timesOf(data.bars, data.symbol, '1D').closes;
        this.legCloses.set(data, closes);
      }
      out.push({ leg, data, closes });
    }
    return missing ? 'missing' : out;
  }

  /**
   * A context's prices in another currency: each bar's open, high, low and close times the
   * rate before it, so what the code computes from them is in that currency and "literal values
   * such as 200 are not converted" (the v6 reference, request.security's currency).
   */
  private convert(
    text: string,
    from: ContextData,
    currency: string,
  ): ContextData | 'missing' | 'no rate' {
    const legs = this.legs(from.symbol.currency, currency);
    if (legs === 'missing' || legs === 'no rate') return legs;
    const known = this.converted.get(text);
    if (
      known &&
      known.from === from &&
      known.legs.length === legs.length &&
      known.legs.every((data, i) => data === legs[i]?.data)
    ) {
      return known.data;
    }
    const bars = from.bars.map((bar) => {
      const k = this.rateWith(legs, openOf(bar));
      return {
        ...bar,
        open: bar.open * k,
        high: bar.high * k,
        low: bar.low * k,
        close: bar.close * k,
      };
    });
    // A pair's history changing changes these bars' history too.
    let history = from.history;
    for (const { data } of legs) history = history * 31 + data.history;
    const data: ContextData = {
      ...from,
      symbol: { ...from.symbol, currency },
      bars,
      history,
    };
    this.converted.set(text, { from, legs: legs.map((l) => l.data), data });
    return data;
  }

  /** A context's Heikin Ashi bars, made again only when the feed's change. */
  private heikinAshi(text: string, from: ContextData): ContextData {
    const known = this.made.get(text);
    if (known && known.from === from) return known.data;
    const data: ContextData = { ...from, bars: heikinAshiBars(from.bars) };
    this.made.set(text, { from, data });
    return data;
  }
}

/**
 * A runtime's view of the store: the request calls of one run (the script's own, a check's, or a
 * context's) ask it for their values on the bar being run.
 */
export class RequestBroker {
  private readonly store: ContextStore;
  /**
   * The last chart bar a value was read for that came from a context bar not yet trusted (the
   * warm-up rule): nothing is drawn up to it. -1 for none.
   */
  unsettledUntil = -1;
  private chartResolution: Resolution | null = null;
  private chartTimeframe = '';

  constructor(store: ContextStore) {
    this.store = store;
  }

  get missing(): ReadonlyMap<string, RequestKey> {
    return this.store.missing;
  }

  /**
   * request.security()'s value on the bar `rt` is running. `currency`, when given, is the one its
   * values should be converted to.
   */
  security(
    site: RequestSite,
    symbol: string,
    timeframe: string,
    options: SecurityOptions,
    rt: Runtime,
    currency = '',
  ): Value {
    const asking = this.key(symbol, timeframe, rt);
    if (!asking) return this.invalid(site, `Invalid timeframe "${timeframe}"`, options);
    const { key, type } = asking;
    // A realtime bar can't ask for a new context (Pine docs, Dynamic requests).
    this.sealed(site, key, rt);
    const run = this.store.run(site, key, { ...options, currency }, type);
    if (run === 'missing') return requestNa(site.base, site.items);
    if (run === 'invalid') return this.invalid(site, `Invalid symbol "${key.symbol}"`, options);
    if (run === 'no rate') throw noRate(key.symbol, currency, site.span);
    this.checked(run);
    const chart = this.chartBar(rt);
    const lower = spanOf(run.resolution) < spanOf(this.resolution(rt));
    const j = alignBar(chart, run, lower, options);
    if (j < 0) return requestNa(site.base, site.items);
    if (j < run.settledFrom) this.unsettledUntil = Math.max(this.unsettledUntil, rt.index);
    return run.value(j, site.base, site.items);
  }

  /**
   * request.security_lower_tf()'s value: every bar of a timeframe at most the chart's inside the
   * chart bar, oldest first, as an array (a tuple of arrays for a tuple), empty for none (Pine
   * docs, request.security_lower_tf(): Intrabar data arrays). On the realtime bar, those so far.
   */
  lowerTf(
    site: RequestSite,
    symbol: string,
    timeframe: string,
    options: SecurityOptions & { readonly ignoreInvalidTimeframe: boolean },
    rt: Runtime,
    currency = '',
  ): Value {
    const asking = this.key(symbol, timeframe, rt);
    if (!asking) return this.invalid(site, `Invalid timeframe "${timeframe}"`, options);
    const { key, type } = asking;
    this.sealed(site, key, rt);
    const resolution = parseResolution(key.timeframe);
    if (resolution && spanOf(resolution) > spanOf(this.resolution(rt))) {
      if (options.ignoreInvalidTimeframe) return requestNa(site.base, site.items);
      throw new PineRuntimeError(
        `The timeframe of 'request.security_lower_tf' must be the chart's or lower: "${key.timeframe}" is higher than "${rt.symbol.timeframe}"`,
        site.span,
      );
    }
    const run = this.store.run(site, key, { ...options, currency }, type);
    if (run === 'missing') return requestNa(site.base, site.items);
    if (run === 'invalid') return this.invalid(site, `Invalid symbol "${key.symbol}"`, options);
    if (run === 'no rate') throw noRate(key.symbol, currency, site.span);
    this.checked(run);
    const chart = this.chartBar(rt);
    const first = lastAtMost(run.opens, run.count, chart.open, true) + 1;
    const last = lastAtMost(run.opens, run.count, chart.close, true);
    if (first <= last && first < run.settledFrom) {
      this.unsettledUntil = Math.max(this.unsettledUntil, rt.index);
    }
    const values: Value[] = [];
    for (let j = first; j <= last; j++) values.push(run.value(j, 'na', undefined));
    if (site.base === 'tuple') {
      const items = site.items ?? [];
      return items.map(
        (item, k) =>
          new PineArray(
            elemOf(item),
            values.map((v) => (Array.isArray(v) ? (v[k] ?? null) : null)),
          ),
      );
    }
    return new PineArray(elemOf(site.base), values);
  }

  /** "scripts must request all required datasets while executing on historical bars". */
  private sealed(site: RequestSite, key: RequestKey, rt: Runtime): void {
    const asked = `${site.shared ?? site.id}|${requestKeyText(key)}`;
    if (rt.index < rt.realtimeFrom) this.store.history.add(asked);
    else if (rt.realtimeFrom > 0 && !this.store.history.has(asked)) {
      throw new PineRuntimeError(
        `A request on a realtime bar can only use data requested on the chart's history: ${key.symbol} on ${key.timeframe} wasn't`,
        site.span,
      );
    }
  }

  /** A context's own runtime error stops the script, as one script (Pine docs, Runtime errors). */
  private checked(run: ContextRun): void {
    const error = run.error;
    if (error) throw new PineRuntimeError(error.message, error.span);
  }

  /**
   * request.currency_rate()'s value on the bar being run: the daily rate before the bar opened
   * (Pine docs, request.currency_rate(): "it ensures non-repainting results"), 1 for a currency
   * into itself; na while a pair loads, or for no rate with ignore_invalid_currency.
   */
  currencyRate(from: string, to: string, ignore: boolean, rt: Runtime, span: Span): number {
    if (!from || !to) return Number.NaN;
    if (from.toUpperCase() === to.toUpperCase()) return 1;
    const rate = this.store.rateAt(from, to, this.chartBar(rt).open);
    if (rate === 'missing') return Number.NaN;
    if (rate === 'no rate') {
      if (ignore) return Number.NaN;
      throw new PineRuntimeError(`Cannot convert ${from} to ${to}: no rate is known`, span);
    }
    return rate;
  }

  private invalid(site: RequestSite, message: string, options: SecurityOptions): Value {
    if (options.ignoreInvalid) return requestNa(site.base, site.items);
    throw new PineRuntimeError(message, site.span);
  }

  /**
   * The context asked for: "" and syminfo.tickerid are this run's own symbol and timeframe, with
   * its hours; a ticker id's settings (ticker.new, ticker.modify) its hours, adjustment and type.
   */
  key(
    symbol: string,
    timeframe: string,
    rt: Runtime,
  ): { key: RequestKey; type: string | null } | null {
    const own = rt.symbol;
    const id = parseTickerId(symbol ?? '');
    const sym = id.symbol.trim().toUpperCase() || own.tickerid.toUpperCase();
    const tf = (timeframe ?? '').trim() || own.timeframe;
    const canonical = canonicalTimeframe(tf);
    if (!canonical) return null;
    const inherits = sym === own.tickerid.toUpperCase();
    const session = id.session ?? (inherits ? own.session : undefined);
    const adjustment =
      id.adjustment === 'none' || id.adjustment === 'dividends' ? id.adjustment : undefined;
    return {
      key: {
        symbol: sym,
        timeframe: canonical,
        ...(session === 'extended' ? { session: 'extended' as const } : {}),
        ...(adjustment ? { adjustment } : {}),
      },
      type: id.type ?? null,
    };
  }

  private resolution(rt: Runtime): Resolution {
    if (this.chartResolution && this.chartTimeframe === rt.symbol.timeframe) {
      return this.chartResolution;
    }
    this.chartTimeframe = rt.symbol.timeframe;
    this.chartResolution = parseResolution(rt.symbol.timeframe) ?? { count: 1, unit: 'day' };
    return this.chartResolution;
  }

  private chartBar(rt: Runtime): ChartBarTimes {
    const i = rt.index;
    const resolution = this.resolution(rt);
    const timesOf = (k: number): [number, number] => {
      const bar = rt.bars[k];
      if (!bar) return [Number.NaN, Number.NaN];
      const open = openOf(bar);
      if (resolution.unit === 'tick') {
        const next = rt.bars[k + 1];
        return [open, next ? openOf(next) : Number.POSITIVE_INFINITY];
      }
      return [open, rt.symbol.clock.close(resolution, open)];
    };
    const [open, close] = timesOf(i);
    const [prevOpen, prevClose] = i > 0 ? timesOf(i - 1) : [Number.NaN, Number.NaN];
    return { open, close, prevOpen, prevClose, realtime: i >= rt.realtimeFrom };
  }
}
