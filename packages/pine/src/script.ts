import type { Bar } from '@tradingnerd/core';
import { type BarChange, isSourceName } from '@tradingnerd/indicators';
import type { Script } from './ast.ts';
import {
  DISPLAY,
  FORMATS,
  LINE_STYLES,
  type LineStyle,
  PLOT_STYLES,
  type PlotStyle,
  type ScriptFormat,
} from './builtins.ts';
import {
  type CompiledProgram,
  type CompileOptions,
  Compiler,
  type InputDef,
  type PlotKind,
} from './compiler.ts';
import { PineCompileError, type PineDiagnostic } from './diagnostics.ts';
import { upgrade } from './dialect.ts';
import { type DrawingSnapshot, EMPTY_DRAWINGS } from './drawings.ts';
import { spanText } from './edits.ts';
import { CHECKS, Execution, type RunClock, type ScriptError, scaledBar } from './execution.ts';
import { LOCATIONS, SHAPES, SIZES } from './marks.ts';
import { parse } from './parser.ts';
import {
  alignBar,
  type ContextData,
  type ContextPlan,
  ContextStore,
  canonicalTimeframe,
  isLower,
  RequestBroker,
  type RequestFeed,
  type RequestKey,
  timesOf,
} from './requests.ts';
import { DEFAULT_SYMBOL, type LogEntry, type ScriptSymbol } from './runtime.ts';
import type { FoldEnv, Qual } from './types.ts';
import type { OutputRef, Value } from './values.ts';
import { Agreement, drawnFrom } from './warmup.ts';

export type { ScriptError };

/** The newest Pine Script® version: TradingView's current one. Older ones run by their own rules. */
export const PINE_VERSION = 6;

/** Compile passes at most before every variable's qualifier is known (see compileScript). */
const MAX_PASSES = 8;

// ---- compiling ----

export type CompileResult =
  | { ok: true; program: ScriptProgram; warnings: PineDiagnostic[] }
  | { ok: false; errors: PineDiagnostic[]; warnings: PineDiagnostic[] };

/**
 * Compiles a script as the Pine Editor's Add to chart does: an error stops it, with where it is
 * (TradingView's Pine docs, Errors). Qualifiers need a few passes: a later `:=` can make a
 * variable a series after code above it has used it (Pine docs, Type system), so each pass
 * starts from the strongest qualifiers the one before found, and the last pass reports.
 */
export function compileScript(source: string, options: CompileOptions = {}): CompileResult {
  try {
    const parsed = parse(source);
    checkVersion(parsed, source);
    const script = upgrade(
      parsed,
      options.edits ? { edits: options.edits, text: spanText(source) } : undefined,
    );
    let floors: ReadonlyMap<object, Qual> = new Map();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const found = new Compiler(script, source, floors, false, options).compile().quals;
      const settled = sameQuals(found, floors);
      floors = found;
      if (settled) break;
    }
    const program = new ScriptProgram(script, source, floors, options);
    return { ok: true, program, warnings: program.warnings };
  } catch (error) {
    if (error instanceof PineCompileError) {
      return {
        ok: false,
        errors: [
          {
            severity: 'error',
            message: error.message,
            ...error.span,
            ...(error.library ? { library: error.library } : {}),
          },
        ],
        warnings: [],
      };
    }
    throw error;
  }
}

/** How many sources compileCached remembers. */
const CACHE_SIZE = 32;
const cache = new Map<string, CompileResult>();

/**
 * compileScript, remembered for the last few sources: the chart, its legend and its dialogs
 * all compile the same code, and a compile result is never changed. `revision` names the
 * libraries the code may import, so a changed library compiles the script again.
 */
export function compileCached(
  source: string,
  options: CompileOptions & { revision?: string } = {},
): CompileResult {
  const key = options.revision ? `${options.revision}\u0000${source}` : source;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = compileScript(source, options);
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return result;
}

function sameQuals(a: ReadonlyMap<object, Qual>, b: ReadonlyMap<object, Qual>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, qual] of a) if (b.get(key) !== qual) return false;
  return true;
}

/** Versions 1 to 6 (no annotation is version 1, as Pine assumes); none newer exists. */
function checkVersion(script: Script, source: string): void {
  if (script.version === null || (script.version >= 1 && script.version <= PINE_VERSION)) return;
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*\/\/@version/.test(line));
  const line = at < 0 ? 1 : at + 1;
  const span = {
    line,
    column: 1,
    endLine: line,
    endColumn: Math.max(2, (lines[line - 1] ?? '').length + 1),
  };
  throw new PineCompileError(
    `Pine Script® v${script.version} doesn't exist: the versions are 1 to ${PINE_VERSION}`,
    span,
  );
}

// ---- what a script draws ----

/** An input, as the Inputs tab shows it, with its value and whether it's enabled. */
export interface ScriptInput extends Omit<InputDef, 'active' | 'span'> {
  value: Value;
  /** False when its `active` argument greys it out. */
  active: boolean;
}

/** One plot(), as these inputs make it (the v6 reference's arguments). */
/** A mark's look, as plotshape(), plotchar() and plotarrow() give it. */
export interface ScriptMark {
  /** plotshape's shape ("xcross" …); null for a char or an arrow. */
  shape: Shape | null;
  /** plotchar's character; null otherwise. */
  char: string | null;
  location: MarkLocation;
  size: MarkSize;
  text: string;
  /** Packed, or null for na; ignored when it changes from bar to bar (its part has them). */
  textColor: number | null;
  /**
   * The run's plot holding its text colors bar by bar (its own, when the text takes the mark's
   * color); null when they don't change.
   */
  textPart: number | null;
  minheight: number;
  maxheight: number;
}

export type Shape = (typeof SHAPES)[number];
export type MarkLocation = (typeof LOCATIONS)[number];
export type MarkSize = (typeof SIZES)[number];

export interface ScriptPlot {
  /**
   * plot()'s line or columns, a mark, a candle or bar, or a hidden part of one (its values,
   * at its own index in the run, aren't drawn by themselves).
   */
  kind: PlotKind;
  title: string;
  /** Packed color, or null for na (the plot doesn't show). */
  color: number | null;
  /** Its color changes from bar to bar (ScriptRun.plotColors). */
  colorChanges: boolean;
  linewidth: number;
  style: PlotStyle;
  linestyle: LineStyle;
  trackprice: boolean;
  histbase: number;
  offset: number;
  join: boolean;
  editable: boolean;
  /** Only the last this many bars show; null for all. */
  showLast: number | null;
  /** Pine's display flags (DISPLAY). */
  display: number;
  /** null: the indicator's. */
  format: ScriptFormat | null;
  /** null: the indicator's. */
  precision: number | null;
  mark: ScriptMark | null;
  /** A candle's or bar's high, low and close: the parts' indices. */
  parts: readonly [number, number, number] | null;
}

export interface ScriptHline {
  price: number;
  title: string;
  color: number | null;
  linestyle: LineStyle;
  linewidth: number;
  editable: boolean;
  display: number;
}

export interface ScriptFill {
  /** The two plots or two hlines it fills between. */
  between: readonly [OutputRef, OutputRef];
  /** A solid fill's color (null for na); a gradient's top color. */
  color: number | null;
  colorChanges: boolean;
  /** A gradient fill's values and its bottom color (TradingView's blog, 2022). */
  gradient: { top: number; bottom: number; bottomColor: number | null } | null;
  title: string;
  editable: boolean;
  showLast: number | null;
  fillgaps: boolean;
  display: number;
}

export interface ScriptBackground {
  /** barcolor(): it colors the chart's bars rather than the pane behind them. */
  bars: boolean;
  /** Its color when it doesn't change from bar to bar; null otherwise or for na. */
  color: number | null;
  colorChanges: boolean;
  offset: number;
  title: string;
  editable: boolean;
  showLast: number | null;
  display: number;
}

export interface ScriptDescription {
  title: string;
  shorttitle: string;
  /** On the price pane rather than a pane of its own. */
  overlay: boolean;
  format: ScriptFormat;
  /** Decimals; null for the format's own. */
  precision: number | null;
  inputs: ScriptInput[];
  plots: ScriptPlot[];
  hlines: ScriptHline[];
  fills: ScriptFill[];
  backgrounds: ScriptBackground[];
}

const isNumber = (value: Value): value is number =>
  typeof value === 'number' && !Number.isNaN(value);
const numberOr = (value: Value, fallback: number): number => (isNumber(value) ? value : fallback);
const colorOf = (value: Value): number | null => (isNumber(value) ? value : null);
const countOf = (value: Value): number | null =>
  isNumber(value) && value >= 0 ? Math.round(value) : null;
const oneOf = <T extends string>(options: readonly T[], value: Value, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;
const formatOf = (value: Value): ScriptFormat | null =>
  (FORMATS as readonly Value[]).includes(value) ? (value as ScriptFormat) : null;

/**
 * A compiled script: its inputs, what it draws for given input values, and fresh instances to
 * run over the bars. The source's parse and its qualifiers are kept, so each instance compiles
 * again quickly into variables and state of its own.
 */
export class ScriptProgram {
  readonly source: string;
  readonly inputs: readonly InputDef[];
  readonly warnings: PineDiagnostic[];
  private readonly script: Script;
  private readonly floors: ReadonlyMap<object, Qual>;
  private readonly compiled: CompiledProgram;

  private readonly options: CompileOptions;

  constructor(
    script: Script,
    source: string,
    floors: ReadonlyMap<object, Qual>,
    options: CompileOptions = {},
  ) {
    this.script = script;
    this.source = source;
    this.floors = floors;
    this.options = options;
    this.compiled = new Compiler(script, source, floors, true, options).compile();
    this.inputs = this.compiled.inputs;
    this.warnings = this.compiled.warnings;
  }

  /** Whether it calls log.info(), log.warning() or log.error() (Pine docs, Debugging). */
  get logging(): boolean {
    return this.compiled.logging;
  }

  /** The inputs' defaults, by input. */
  defaults(): Value[] {
    return this.inputs.map((input) => input.defval);
  }

  /**
   * Input values from settings, checked: each of its input's kind, within its options and
   * limits, or else its default.
   */
  sanitize(values: readonly unknown[]): Value[] {
    return this.inputs.map((input) => sanitizeInput(input, values[input.index]));
  }

  /** What the script draws with these input values (sanitized first). */
  describe(raw: readonly unknown[]): ScriptDescription {
    const values = this.sanitize(raw);
    const env: FoldEnv = { inputs: values };
    const p = this.compiled;
    return {
      title: p.indicator.title,
      shorttitle: p.indicator.shorttitle,
      overlay: p.indicator.overlay,
      format: formatOf(p.indicator.format) ?? 'inherit',
      precision: p.indicator.precision,
      inputs: p.inputs.map(({ active, span: _span, ...input }) => ({
        ...input,
        value: values[input.index] ?? input.defval,
        active: active ? active(env) : true,
      })),
      plots: p.plots.map((plot) => ({
        kind: plot.kind,
        title: plot.title,
        color: plot.color.dynamic ? null : colorOf(plot.color.fold(env)),
        colorChanges: plot.color.dynamic,
        linewidth: Math.max(1, Math.round(numberOr(plot.linewidth(env), 1))),
        style: oneOf(PLOT_STYLES, plot.style(env), 'line'),
        linestyle: oneOf(LINE_STYLES, plot.linestyle(env), 'solid'),
        trackprice: plot.trackprice(env) === true,
        histbase: numberOr(plot.histbase(env), 0),
        offset: Math.round(numberOr(plot.offset(env), 0)),
        join: plot.join(env) === true,
        editable: plot.editable(env) !== false,
        showLast: countOf(plot.showLast(env)),
        display: Math.round(numberOr(plot.display(env), DISPLAY.all)),
        format: formatOf(plot.format(env)),
        precision: countOf(plot.precision(env)),
        mark: plot.mark
          ? {
              shape: plot.kind === 'shape' ? oneOf(SHAPES, plot.mark.shape(env), 'xcross') : null,
              char: plot.kind === 'char' ? String(plot.mark.char(env) ?? '★') : null,
              location: oneOf(LOCATIONS, plot.mark.location(env), 'abovebar'),
              size: oneOf(SIZES, plot.mark.size(env), 'auto'),
              text: plot.mark.text,
              textColor: plot.mark.textColor.dynamic
                ? null
                : colorOf(plot.mark.textColor.fold(env)),
              textPart: plot.mark.textPart,
              minheight: Math.max(0, numberOr(plot.mark.minheight(env), 5)),
              maxheight: Math.max(0, numberOr(plot.mark.maxheight(env), 100)),
            }
          : null,
        parts: plot.parts ?? null,
      })),
      hlines: p.hlines.map((hline) => ({
        price: numberOr(hline.price(env), Number.NaN),
        title: hline.title,
        color: colorOf(hline.color(env)),
        linestyle: oneOf(LINE_STYLES, hline.linestyle(env), 'dashed'),
        linewidth: Math.max(1, Math.round(numberOr(hline.linewidth(env), 1))),
        editable: hline.editable(env) !== false,
        display: Math.round(numberOr(hline.display(env), DISPLAY.all)),
      })),
      fills: p.fills.map((fill) => ({
        between: [fill.a, fill.b] as const,
        color: fill.gradient
          ? colorOf(fill.gradient.topColor(env))
          : fill.color && !fill.color.dynamic
            ? colorOf(fill.color.fold(env))
            : null,
        colorChanges: fill.color?.dynamic ?? false,
        gradient: fill.gradient
          ? {
              top: numberOr(fill.gradient.top(env), Number.NaN),
              bottom: numberOr(fill.gradient.bottom(env), Number.NaN),
              bottomColor: colorOf(fill.gradient.bottomColor(env)),
            }
          : null,
        title: fill.title,
        editable: fill.editable(env) !== false,
        showLast: countOf(fill.showLast(env)),
        fillgaps: fill.fillgaps,
        display: Math.round(numberOr(fill.display(env), DISPLAY.all)),
      })),
      backgrounds: p.bgcolors.map((bg) => ({
        bars: bg.bars,
        color: bg.color.dynamic ? null : colorOf(bg.color.fold(env)),
        colorChanges: bg.color.dynamic,
        offset: Math.round(numberOr(bg.offset(env), 0)),
        title: bg.title,
        editable: bg.editable(env) !== false,
        showLast: countOf(bg.showLast(env)),
        display: Math.round(numberOr(bg.display(env), DISPLAY.all)),
      })),
    };
  }

  /** A fresh compile of the script, with its own variables and state, for one run. */
  instance(): CompiledProgram {
    return new Compiler(this.script, this.source, this.floors, true, this.options).compile();
  }

  /** A request's context program: the code its expression depends on (requests.ts). */
  contextProgram(plan: ContextPlan): CompiledProgram {
    return new Compiler(this.script, this.source, this.floors, true, {
      ...this.options,
      context: plan,
    }).compile();
  }

  /** Whether it asks for other symbols' or timeframes' data (request.*() calls). */
  get requests(): boolean {
    return this.compiled.requests.length > 0;
  }

  /**
   * The timeframe it runs on, when its declaration gives one (`timeframe =`) and its Timeframe
   * input isn't the chart's (""), and whether it waits for that timeframe's closes.
   */
  timeframeOf(raw: readonly unknown[]): { timeframe: string; gaps: boolean } | null {
    const decl = this.compiled.indicator.timeframe;
    if (!decl) return null;
    const values = this.sanitize(raw);
    const timeframe = String(values[decl.input] ?? '');
    if (!timeframe) return null;
    return { timeframe, gaps: values[decl.gaps] !== false };
  }

  /** The script's Pine version (1 when it has no annotation). */
  get version(): number {
    return this.script.version ?? 1;
  }

  /** Declared with library(). */
  get isLibrary(): boolean {
    return this.compiled.indicator.library;
  }
}

function sanitizeInput(input: InputDef, value: unknown): Value {
  switch (input.kind) {
    case 'int':
    case 'float': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return input.defval;
      let v = input.kind === 'int' ? Math.round(value) : value;
      if (input.options) return input.options.includes(v) ? v : input.defval;
      if (input.minval !== undefined && v < input.minval) v = input.minval;
      if (input.maxval !== undefined && v > input.maxval) v = input.maxval;
      return v;
    }
    case 'bool':
      return typeof value === 'boolean' ? value : input.defval;
    case 'string':
    case 'timeframe':
    case 'session':
    case 'symbol':
    case 'text_area':
    case 'enum':
      return typeof value === 'string' && (!input.options || input.options.includes(value))
        ? value
        : input.defval;
    case 'time':
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : input.defval;
    case 'price':
      return typeof value === 'number' && Number.isFinite(value) ? value : input.defval;
    case 'color':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 32
        ? value
        : input.defval;
    case 'source':
      return isSourceName(value) ? value : input.defval;
    default:
      return typeof value === typeof input.defval ? (value as Value) : input.defval;
  }
}

// ---- running ----

/** A feed with nothing loaded: a script's requests then wait for the app's (requests.ts). */
const NO_DATA: RequestFeed = { data: () => null };

/** Per output, its agreement with each check run, by check. */
interface OutputAgreements {
  plots: Agreement[][];
  plotColors: (Agreement[] | null)[];
  backgrounds: Agreement[][];
  fillColors: (Agreement[] | null)[];
}

/**
 * A script over the chart's bars, kept in step with them as Pine runs one (TradingView's Pine
 * docs, Execution model): closed bars commit, the live bar runs again on every update from the
 * last commit, a new bar commits the one before it. A correction of that bar redoes it from the
 * commit before; anything else (a new page of history, a refill, other inputs) runs it afresh,
 * as TradingView reloads a script.
 */
export class ScriptRun {
  readonly program: ScriptProgram;
  readonly inputs: readonly Value[];
  readonly symbol: ScriptSymbol;
  readonly description: ScriptDescription;
  /**
   * One array per plot: its value on each bar, NaN where it has none. The arrays run past the
   * last bar (NaN there): `length` says how many bars there are.
   */
  values: Float64Array[] = [];
  /** Per plot whose color changes from bar to bar, its packed color on each bar (NaN = na). */
  plotColors: (Float64Array | null)[] = [];
  /** Per bgcolor(), its packed color on each bar (NaN = none). */
  backgrounds: Float64Array[] = [];
  /** Per fill whose color changes from bar to bar, its packed color on each bar. */
  fillColors: (Float64Array | null)[] = [];
  /**
   * The first bar each plot, background and fill is drawn from (the warm-up rule): 0 from our
   * first bar, Infinity when none of its values can be trusted yet.
   */
  plotStarts: number[] = [];
  backgroundStarts: number[] = [];
  fillStarts: number[] = [];
  /** The runtime error that stopped the script, if one did. */
  error: ScriptError | null = null;
  /**
   * The contexts its requests asked for that the feed hasn't loaded yet: the app loads them and
   * sets the bars again. Nothing is drawn meanwhile.
   */
  missing: readonly RequestKey[] = [];
  /** Every context its requests ask for (the app keeps them loaded and live). */
  requested: readonly RequestKey[] = [];
  private main: Execution | null = null;
  private store: ContextStore | null = null;
  /**
   * Set when it runs on another timeframe (indicator()'s `timeframe =`): that timeframe's bars,
   * which its own run is over, and whether to wait for their closes; its values are then merged
   * onto the chart's bars (`merge`).
   */
  private on: { key: RequestKey; gaps: boolean; data: ContextData | null } | null = null;
  /** The chart's bars, when it runs on another timeframe's. */
  private chartBars: readonly Bar[] = [];
  /** Whether the bars it runs over start at the symbol's listing (the chart's, or the timeframe's). */
  private ownListing = false;
  private checks: Execution[] = [];
  /** Per output, its agreement with each check run (by check). */
  private agreements: OutputAgreements = {
    plots: [],
    plotColors: [],
    backgrounds: [],
    fillColors: [],
  };
  private fromListing = false;
  private readonly feed: RequestFeed;

  constructor(
    program: ScriptProgram,
    inputs: readonly unknown[],
    symbol: ScriptSymbol = DEFAULT_SYMBOL,
    feed: RequestFeed = NO_DATA,
  ) {
    this.program = program;
    this.inputs = program.sanitize(inputs);
    this.symbol = symbol;
    this.feed = feed;
    this.description = program.describe(this.inputs);
  }

  /** Whether some of its requests' data hasn't loaded yet (it draws nothing until it has). */
  get waiting(): boolean {
    return this.missing.length > 0;
  }

  get length(): number {
    return this.on ? this.chartBars.length : (this.main?.length ?? 0);
  }

  /** The script's Pine Logs from its run over the chart's bars, oldest first (Pine docs, Debugging). */
  get logs(): readonly LogEntry[] {
    return this.main?.logs ?? [];
  }

  /** How many messages this run has logged in all: it changes when there are new ones. */
  get logsWritten(): number {
    return this.main?.logsWritten ?? 0;
  }

  /** Whether the script calls log.info(), log.warning() or log.error() (its More menu's Pine Logs). */
  get logging(): boolean {
    return this.program.logging;
  }

  /**
   * Runs the script afresh over every bar. When our first bar is the symbol's listing,
   * TradingView's history starts there too, and every value is drawn without checking.
   */
  setBars(bars: readonly Bar[], fromListing: boolean): void {
    this.fromListing = fromListing;
    this.chartBars = bars;
    const timeframe = this.ownTimeframe();
    if (timeframe) {
      this.loadTimeframe(bars, timeframe);
      return;
    }
    this.on = null;
    this.load(bars, fromListing, this.symbol, Math.max(0, bars.length - 1));
  }

  /** Runs the script afresh over `bars`: the chart's, or its own timeframe's. */
  private load(
    bars: readonly Bar[],
    fromListing: boolean,
    symbol: ScriptSymbol,
    realtimeFrom: number,
  ): void {
    this.ownListing = fromListing;
    // One clock and seed for the whole load: the check runs must see what the main run sees.
    const clock: RunClock = { now: Date.now(), seed: (Math.random() * 2 ** 31) | 0 };
    // The contexts its requests use, shared by all its runs (requests.ts).
    const store = new ContextStore(
      this.feed,
      (plan) => this.program.contextProgram(plan),
      this.inputs,
      this.symbol,
      clock,
    );
    this.store = store;
    const make = (start: number, changed: readonly Bar[]) => {
      const execution = new Execution(
        this.program.instance(),
        this.inputs,
        symbol,
        start,
        changed,
        realtimeFrom,
        clock,
      );
      execution.runtime.requests = new RequestBroker(store);
      return execution;
    };
    this.main = make(0, []);
    this.main.all(bars);
    this.checks =
      fromListing || bars.length < 2 || this.main.error
        ? []
        : CHECKS.map((check) =>
            make(
              check.start,
              check.scales.map((scale, i) => scaledBar(bars[i] as Bar, scale)),
            ),
          );
    for (const check of this.checks) check.all(bars);
    this.adopt();
    this.agreements = this.compare(bars.length);
    this.settle(bars.length);
  }

  /**
   * Follows a change the chart made to its bars, at `index`. Returns the bars whose values
   * changed, or 'all' when the script ran afresh.
   */
  update(bars: readonly Bar[], change: BarChange, index: number): number[] | 'all' {
    if (this.on) return this.updateTimeframe(bars);
    const main = this.main;
    const last = bars.length - 1;
    if (!main || last < 0) {
      this.setBars(bars, this.fromListing);
      return 'all';
    }
    const runs = [main, ...this.checks];
    let changed: number[] | null = null;
    if (change === 'tick' && index === last && main.length === bars.length) {
      for (const run of runs) run.tick(bars);
      changed = [last];
      this.adopt();
    } else if (change === 'new' && index === last && last >= 1 && main.length === bars.length - 1) {
      for (const run of runs) run.next(bars);
      changed = [last - 1, last];
      this.adopt();
      this.eachAgreement((agreement, own, theirs) => agreement.extend(own, theirs, last));
    } else if (
      change === 'correction' &&
      index === last - 1 &&
      main.length === bars.length &&
      runs.every((run) => run.canCorrect)
    ) {
      for (const run of runs) run.correct(bars);
      changed = [last - 1, last];
      this.adopt();
      this.eachAgreement((agreement, own, theirs) => agreement.rebuild(own, theirs, last));
    }
    if (!changed) {
      this.setBars(bars, this.fromListing);
      return 'all';
    }
    this.settle(bars.length);
    return changed;
  }

  /** The timeframe it runs on, when its declaration asks for one other than the chart's. */
  private ownTimeframe(): { key: RequestKey; gaps: boolean } | null {
    const asked = this.program.timeframeOf(this.inputs);
    if (!asked) return null;
    const timeframe = canonicalTimeframe(asked.timeframe);
    if (!timeframe || timeframe === canonicalTimeframe(this.symbol.timeframe)) return null;
    const key: RequestKey = {
      symbol: this.symbol.tickerid.toUpperCase(),
      timeframe,
      ...(this.symbol.session === 'extended' ? { session: 'extended' as const } : {}),
    };
    return { key, gaps: asked.gaps };
  }

  /**
   * Runs it on its own timeframe's bars, then merges its values onto the chart's (Pine docs, FAQ:
   * Using timeframe; Help Center, multi-timeframe analysis: "Wait for timeframe closes" shows a
   * value once its bar closes, unticked the gaps take the latest value, live too).
   */
  private loadTimeframe(chart: readonly Bar[], asked: { key: RequestKey; gaps: boolean }): void {
    const data = this.feed.data(asked.key);
    if (data === null || data === 'invalid') {
      this.on = { ...asked, data: null };
      this.main = null;
      this.checks = [];
      this.store = null;
      this.missing = data === null ? [asked.key] : [];
      this.requested = [asked.key];
      this.error =
        data === 'invalid'
          ? { message: `Invalid timeframe "${asked.key.timeframe}"`, span: null, bar: 0 }
          : null;
      const empty = () => new Float64Array(chart.length).fill(Number.NaN);
      const d = this.description;
      this.values = d.plots.map(empty);
      this.plotColors = d.plots.map((plot) => (plot.colorChanges ? empty() : null));
      this.backgrounds = d.backgrounds.map(empty);
      this.fillColors = d.fills.map((fill) => (fill.colorChanges ? empty() : null));
      this.plotStarts = d.plots.map(() => Number.POSITIVE_INFINITY);
      this.backgroundStarts = d.backgrounds.map(() => Number.POSITIVE_INFINITY);
      this.fillStarts = d.fills.map(() => Number.POSITIVE_INFINITY);
      return;
    }
    this.on = { ...asked, data };
    const symbol: ScriptSymbol = { ...this.symbol, timeframe: asked.key.timeframe };
    const realtimeFrom = data.live ? Math.max(0, data.bars.length - 1) : data.bars.length;
    this.load(data.bars, data.fromListing, symbol, realtimeFrom);
    this.requested = [asked.key, ...this.requested];
    this.merge(chart);
  }

  /** The chart's bars moved: its own timeframe's bars may have too. */
  private updateTimeframe(chart: readonly Bar[]): number[] | 'all' {
    const on = this.on as NonNullable<ScriptRun['on']>;
    const main = this.main;
    const data = this.feed.data(on.key);
    const before = on.data;
    if (
      !main ||
      !before ||
      data === null ||
      data === 'invalid' ||
      data.history !== before.history ||
      data.bars.length < main.length
    ) {
      this.setBars(chart, this.fromListing);
      return 'all';
    }
    if (data.version !== before.version) {
      const runs = [main, ...this.checks];
      if (data.bars.length === main.length) {
        for (const run of runs) run.tick(data.bars);
      } else {
        for (let n = main.length + 1; n <= data.bars.length; n++) {
          const upTo = n === data.bars.length ? data.bars : data.bars.slice(0, n);
          for (const run of runs) run.next(upTo);
        }
      }
      on.data = data;
      this.adopt();
      this.agreements = this.compare(data.bars.length);
      this.settle(data.bars.length);
    }
    this.chartBars = chart;
    this.merge(chart);
    return 'all';
  }

  /** Its own timeframe's values onto the chart's bars, as request.security() merges them. */
  private merge(chart: readonly Bar[]): void {
    const on = this.on as NonNullable<ScriptRun['on']>;
    const data = on.data as ContextData;
    const main = this.main as Execution;
    const own = timesOf(data.bars, data.symbol, on.key.timeframe);
    const charted = timesOf(chart, this.symbol, this.symbol.timeframe);
    const lower = isLower(on.key.timeframe, this.symbol.timeframe);
    const map = new Int32Array(chart.length);
    const context = {
      opens: own.opens,
      closes: own.closes,
      count: data.bars.length,
      live: data.live,
    };
    for (let i = 0; i < chart.length; i++) {
      map[i] = alignBar(
        {
          open: charted.opens[i] as number,
          close: charted.closes[i] as number,
          prevOpen: i > 0 ? (charted.opens[i - 1] as number) : Number.NaN,
          prevClose: i > 0 ? (charted.closes[i - 1] as number) : Number.NaN,
          realtime: i >= chart.length - 1,
        },
        context,
        lower,
        { gaps: on.gaps, lookahead: false },
      );
    }
    const pick = (values: Float64Array): Float64Array => {
      const out = new Float64Array(chart.length).fill(Number.NaN);
      for (let i = 0; i < chart.length; i++) {
        const j = map[i] as number;
        if (j >= 0) out[i] = values[j] as number;
      }
      return out;
    };
    const o = main.outputs;
    this.values = o.plots.map(pick);
    this.plotColors = o.plotColors.map((colors) => colors && pick(colors));
    this.backgrounds = o.backgrounds.map(pick);
    this.fillColors = o.fillColors.map((colors) => colors && pick(colors));
    // Where each output is drawn from, in the chart's bars: the first whose bar is trusted.
    const toChart = (start: number): number => {
      if (!Number.isFinite(start)) return start;
      for (let i = 0; i < chart.length; i++) if ((map[i] as number) >= start) return i;
      return Number.POSITIVE_INFINITY;
    };
    this.plotStarts = this.plotStarts.map(toChart);
    this.backgroundStarts = this.backgroundStarts.map(toChart);
    this.fillStarts = this.fillStarts.map(toChart);
  }

  /** Each plot's value on a bar (NaN where it has none, or past either end). */
  valuesAt(index: number): number[] {
    const inside = index >= 0 && index < this.length;
    return this.values.map((plot) => (inside ? (plot[index] as number) : Number.NaN));
  }

  private adopt(): void {
    const main = this.main as Execution;
    const store = this.store;
    if (store) {
      this.missing = [...store.missing.values()];
      this.requested = [...store.used.values()];
    }
    this.values = main.outputs.plots;
    this.plotColors = main.outputs.plotColors;
    this.backgrounds = main.outputs.backgrounds;
    this.fillColors = main.outputs.fillColors;
    this.error = main.error;
    // Its drawings as they stand, copied only when they changed (each change bumps the version).
    const drawn = main.runtime.drawings;
    if (drawn.version !== this.drawingsVersion) {
      this.drawings = drawn.snapshot();
      this.drawingsVersion = drawn.version;
    }
  }

  /** Its labels, lines, boxes, tables, polylines and linefills at the last bar it ran. */
  drawings: DrawingSnapshot = EMPTY_DRAWINGS;
  private drawingsVersion = -1;

  /** Each output's agreement with each check run, over the closed bars. */
  private compare(length: number): OutputAgreements {
    const memory = (c: number) => CHECKS[c]?.memory ?? false;
    const make = (colors: boolean, own: Float64Array, theirs: (check: Execution) => Float64Array) =>
      this.checks.map((check, c) => {
        const agreement = new Agreement(colors, memory(c));
        agreement.rebuild(own, theirs(check), length - 1);
        return agreement;
      });
    return {
      plots: this.values.map((own, p) =>
        make(false, own, (check) => check.outputs.plots[p] as Float64Array),
      ),
      plotColors: this.plotColors.map(
        (own, p) => own && make(true, own, (check) => check.outputs.plotColors[p] as Float64Array),
      ),
      backgrounds: this.backgrounds.map((own, b) =>
        make(true, own, (check) => check.outputs.backgrounds[b] as Float64Array),
      ),
      fillColors: this.fillColors.map(
        (own, f) => own && make(true, own, (check) => check.outputs.fillColors[f] as Float64Array),
      ),
    };
  }

  /** Visits each output's agreement with each check run, with the two runs' arrays. */
  private eachAgreement(
    visit: (agreement: Agreement, own: Float64Array, theirs: Float64Array) => void,
  ): void {
    const a = this.agreements;
    const pairs = (
      lists: readonly (readonly Agreement[] | null)[],
      own: readonly (Float64Array | null)[],
      theirs: readonly (Float64Array | null)[],
      c: number,
    ) => {
      lists.forEach((list, i) => {
        const mine = own[i];
        const other = theirs[i];
        if (list && mine && other) visit(list[c] as Agreement, mine, other);
      });
    };
    this.checks.forEach((check, c) => {
      const o = check.outputs;
      pairs(a.plots, this.values, o.plots, c);
      pairs(a.plotColors, this.plotColors, o.plotColors, c);
      pairs(a.backgrounds, this.backgrounds, o.backgrounds, c);
      pairs(a.fillColors, this.fillColors, o.fillColors, c);
    });
  }

  /** Works out where each output is drawn from (see CHECKS), and what requests allow. */
  private settle(length: number): void {
    this.settleOwn(length);
    // While a request's data is loading nothing is drawn; a value from a context's bar that still
    // depends on its bars not loaded isn't either, nor anything after it on that chart bar.
    const waiting = this.waiting;
    const unsettled = this.main?.runtime.requests?.unsettledUntil ?? -1;
    if (!waiting && unsettled < 0) return;
    const from = (start: number) =>
      waiting ? Number.POSITIVE_INFINITY : Math.max(start, unsettled + 1);
    this.plotStarts = this.plotStarts.map(from);
    this.backgroundStarts = this.backgroundStarts.map(from);
    this.fillStarts = this.fillStarts.map(from);
  }

  private settleOwn(length: number): void {
    // A check that stopped on an error (a script that refuses a far-off bar 0, say) can't
    // compare; the others still do (provisional, §11).
    const usable = this.checks.map((check) => check.error === null);
    const from = (
      series: readonly (readonly [
        Float64Array,
        readonly Agreement[] | null,
        (check: Execution) => Float64Array,
      ])[],
    ): number => {
      if (this.ownListing) return 0;
      if (length < 2 || !usable.includes(true)) return Number.POSITIVE_INFINITY;
      let last = -1;
      let remembers = false;
      for (const [own, agreements, theirs] of series) {
        if (!agreements) continue;
        this.checks.forEach((check, c) => {
          if (!usable[c]) return;
          const agreement = agreements[c] as Agreement;
          if (agreement.memory) remembers ||= agreement.remembers(own, theirs(check), length);
          else last = Math.max(last, agreement.lastDisagreement(own, theirs(check), length));
        });
      }
      return drawnFrom(last, remembers, length);
    };
    const a = this.agreements;
    this.plotStarts = this.values.map((own, p) => {
      const colors = this.plotColors[p];
      return from([
        [own, a.plots[p] as Agreement[], (check) => check.outputs.plots[p] as Float64Array],
        ...(colors
          ? [
              [
                colors,
                a.plotColors[p] ?? null,
                (check: Execution) => check.outputs.plotColors[p] as Float64Array,
              ] as const,
            ]
          : []),
      ]);
    });
    this.backgroundStarts = this.backgrounds.map((own, b) =>
      from([
        [
          own,
          a.backgrounds[b] as Agreement[],
          (check) => check.outputs.backgrounds[b] as Float64Array,
        ],
      ]),
    );
    this.fillStarts = this.description.fills.map((fill, f) => {
      const own = this.fillColors[f];
      const colorStart = own
        ? from([
            [own, a.fillColors[f] ?? null, (check) => check.outputs.fillColors[f] as Float64Array],
          ])
        : 0;
      const edges = fill.between.map((edge) =>
        edge.output === 'plot' ? (this.plotStarts[edge.index] ?? 0) : 0,
      );
      return Math.max(colorStart, ...edges);
    });
  }
}
