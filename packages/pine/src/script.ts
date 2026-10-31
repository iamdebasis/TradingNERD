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
import { type CompiledProgram, Compiler, type InputDef } from './compiler.ts';
import {
  PineCompileError,
  type PineDiagnostic,
  PineRuntimeError,
  type Span,
} from './diagnostics.ts';
import { parse } from './parser.ts';
import { DEFAULT_SYMBOL, type Outputs, type ScriptSymbol } from './runtime.ts';
import type { FoldEnv, Qual } from './types.ts';
import type { OutputRef, Value } from './values.ts';
import { Agreement, drawnFrom } from './warmup.ts';

/** The Pine Script® version this engine runs: TradingView's current one. */
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
export function compileScript(source: string): CompileResult {
  try {
    const script = parse(source);
    checkVersion(script, source);
    let floors: ReadonlyMap<object, Qual> = new Map();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const found = new Compiler(script, source, floors, false).compile().quals;
      const settled = sameQuals(found, floors);
      floors = found;
      if (settled) break;
    }
    const program = new ScriptProgram(script, source, floors);
    return { ok: true, program, warnings: program.warnings };
  } catch (error) {
    if (error instanceof PineCompileError) {
      return {
        ok: false,
        errors: [{ severity: 'error', message: error.message, ...error.span }],
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
 * all compile the same code, and a compile result is never changed.
 */
export function compileCached(source: string): CompileResult {
  const hit = cache.get(source);
  if (hit) {
    cache.delete(source);
    cache.set(source, hit);
    return hit;
  }
  const result = compileScript(source);
  cache.set(source, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return result;
}

function sameQuals(a: ReadonlyMap<object, Qual>, b: ReadonlyMap<object, Qual>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, qual] of a) if (b.get(key) !== qual) return false;
  return true;
}

/** Only v6: v5 and older differ in ways that change results (Pine docs, v6 migration guide). */
function checkVersion(script: Script, source: string): void {
  if (script.version === PINE_VERSION) return;
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
    script.version === null
      ? 'Add //@version=6 as the first line: tradingNerd runs Pine Script® v6'
      : `This script is Pine Script® v${script.version}: tradingNerd runs v6 (older versions come later)`,
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
export interface ScriptPlot {
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

  constructor(script: Script, source: string, floors: ReadonlyMap<object, Qual>) {
    this.script = script;
    this.source = source;
    this.floors = floors;
    this.compiled = new Compiler(script, source, floors, true).compile();
    this.inputs = this.compiled.inputs;
    this.warnings = this.compiled.warnings;
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
        editable: plot.editable,
        showLast: countOf(plot.showLast(env)),
        display: Math.round(numberOr(plot.display(env), DISPLAY.all)),
        format: formatOf(plot.format(env)),
        precision: countOf(plot.precision(env)),
      })),
      hlines: p.hlines.map((hline) => ({
        price: numberOr(hline.price(env), Number.NaN),
        title: hline.title,
        color: colorOf(hline.color(env)),
        linestyle: oneOf(LINE_STYLES, hline.linestyle(env), 'dashed'),
        linewidth: Math.max(1, Math.round(numberOr(hline.linewidth(env), 1))),
        editable: hline.editable,
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
        editable: fill.editable,
        showLast: countOf(fill.showLast(env)),
        fillgaps: fill.fillgaps,
        display: Math.round(numberOr(fill.display(env), DISPLAY.all)),
      })),
      backgrounds: p.bgcolors.map((bg) => ({
        color: bg.color.dynamic ? null : colorOf(bg.color.fold(env)),
        colorChanges: bg.color.dynamic,
        offset: Math.round(numberOr(bg.offset(env), 0)),
        title: bg.title,
        editable: bg.editable,
        showLast: countOf(bg.showLast(env)),
        display: Math.round(numberOr(bg.display(env), DISPLAY.all)),
      })),
    };
  }

  /** A fresh compile of the script, with its own variables and state, for one run. */
  instance(): CompiledProgram {
    return new Compiler(this.script, this.source, this.floors, true).compile();
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
      return typeof value === 'string' && (!input.options || input.options.includes(value))
        ? value
        : input.defval;
    case 'color':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 32
        ? value
        : input.defval;
    case 'source':
      return isSourceName(value) ? value : input.defval;
  }
}

// ---- running ----

/** A runtime error: the script stops, as Pine's do, and the chart shows the message. */
export interface ScriptError {
  message: string;
  span: Span | null;
  /** The bar it stopped on. */
  bar: number;
}

/** Room for this many bars past the loaded ones, so live bars rarely need new arrays. */
const SPARE = 1024;
const NONE = new Float64Array(0);

/**
 * One execution of the script over the bars, from bar `start`, with bar 0 changed or not: its
 * outputs on each bar it has computed (NaN before `start` and past its last bar).
 */
class Execution {
  readonly start: number;
  readonly outputs: Outputs;
  error: ScriptError | null = null;
  /** How many bars it has seen. */
  length = 0;
  private capacity = 0;
  private readonly program: CompiledProgram;
  /** The state from before the last commit, to redo it after a correction. */
  private beforeLastCommit: unknown = null;

  constructor(
    program: CompiledProgram,
    inputs: readonly Value[],
    symbol: ScriptSymbol,
    start: number,
    changed: readonly Bar[],
    realtimeFrom: number,
  ) {
    this.program = program;
    this.start = start;
    this.outputs = {
      plots: program.plots.map(() => NONE),
      plotColors: program.plots.map((plot) => (plot.color.dynamic ? NONE : null)),
      backgrounds: program.bgcolors.map(() => NONE),
      fillColors: program.fills.map((fill) => (fill.color?.dynamic ? NONE : null)),
    };
    const rt = program.runtime;
    rt.inputs = inputs;
    rt.symbol = symbol;
    rt.start = start;
    rt.changed = changed;
    rt.realtimeFrom = realtimeFrom;
    rt.outputs = this.outputs;
  }

  /** Computes every bar: closed ones commit, the last (live) one is tentative. */
  all(bars: readonly Bar[]): void {
    this.room(bars.length);
    this.program.runtime.bars = bars;
    const last = bars.length - 1;
    for (let i = Math.max(0, this.start); i < last; i++) {
      if (i === last - 1) this.beforeLastCommit = this.program.runtime.save();
      this.run(i, true);
    }
    if (last >= this.start) this.run(last, false);
    this.length = bars.length;
  }

  /** The live bar moved. */
  tick(bars: readonly Bar[]): void {
    this.program.runtime.bars = bars;
    this.run(bars.length - 1, false);
  }

  /** A new bar opened: the one before it commits. */
  next(bars: readonly Bar[]): void {
    const last = bars.length - 1;
    this.room(bars.length);
    this.program.runtime.bars = bars;
    this.beforeLastCommit = this.program.runtime.save();
    this.run(last - 1, true);
    this.run(last, false);
    this.length = bars.length;
  }

  get canCorrect(): boolean {
    return this.beforeLastCommit !== null && this.error === null;
  }

  /** The bar before the live one was corrected: back one commit, then both again. */
  correct(bars: readonly Bar[]): void {
    const last = bars.length - 1;
    this.program.runtime.bars = bars;
    this.program.runtime.restore(this.beforeLastCommit);
    this.run(last - 1, true);
    this.run(last, false);
  }

  private run(index: number, final: boolean): void {
    if (this.error || index < this.start) return;
    const rt = this.program.runtime;
    rt.begin(index, final);
    try {
      this.program.run(rt);
      rt.end();
    } catch (error) {
      if (!(error instanceof PineRuntimeError)) throw error;
      this.error = { message: error.message, span: error.span, bar: index };
    }
  }

  /** Arrays long enough for `length` bars, the values so far kept. */
  private room(length: number): void {
    if (length <= this.capacity) return;
    this.capacity = length + SPARE;
    const grow = (old: Float64Array) => {
      const next = new Float64Array(this.capacity).fill(Number.NaN);
      next.set(old);
      return next;
    };
    const o = this.outputs;
    o.plots = o.plots.map(grow);
    o.plotColors = o.plotColors.map((colors) => colors && grow(colors));
    o.backgrounds = o.backgrounds.map(grow);
    o.fillColors = o.fillColors.map((colors) => colors && grow(colors));
  }
}

/**
 * The warm-up check's runs (docs/SPEC.md §6.17), beside the script's own run from our first bar.
 * TradingView runs a script from its own first bar, further back than ours, so a value of ours is
 * drawn only where it no longer depends on the bars we haven't loaded, as I1's rule draws RSI
 * (§6.16). Each check changes what came before and looks at what changes after:
 * - starting one bar later finds what counts bars (bar_index, a var counter, ta.cum);
 * - bar 0 one percent higher measures how fast its influence fades (a recursive average's
 *   seed), so a value is settled once that influence is below SETTLED_WEIGHT of its peak;
 * - bar 0 a thousand times higher and bar 1 a thousand times lower find what remembers them
 *   for good (a running maximum or minimum since the first bar).
 */
const CHECKS: readonly { start: number; scales: readonly number[]; memory: boolean }[] = [
  { start: 1, scales: [], memory: false },
  { start: 0, scales: [1.01], memory: false },
  { start: 0, scales: [1000, 0.001], memory: true },
];

const scaledBar = (bar: Bar, k: number): Bar => ({
  ...bar,
  open: bar.open * k,
  high: bar.high * k,
  low: bar.low * k,
  close: bar.close * k,
  volume: bar.volume * k,
});

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
  private main: Execution | null = null;
  private checks: Execution[] = [];
  /** Per output, its agreement with each check run (by check). */
  private agreements: OutputAgreements = {
    plots: [],
    plotColors: [],
    backgrounds: [],
    fillColors: [],
  };
  private fromListing = false;

  constructor(
    program: ScriptProgram,
    inputs: readonly unknown[],
    symbol: ScriptSymbol = DEFAULT_SYMBOL,
  ) {
    this.program = program;
    this.inputs = program.sanitize(inputs);
    this.symbol = symbol;
    this.description = program.describe(this.inputs);
  }

  get length(): number {
    return this.main?.length ?? 0;
  }

  /**
   * Runs the script afresh over every bar. When our first bar is the symbol's listing,
   * TradingView's history starts there too, and every value is drawn without checking.
   */
  setBars(bars: readonly Bar[], fromListing: boolean): void {
    this.fromListing = fromListing;
    const realtimeFrom = Math.max(0, bars.length - 1);
    const make = (start: number, changed: readonly Bar[]) =>
      new Execution(
        this.program.instance(),
        this.inputs,
        this.symbol,
        start,
        changed,
        realtimeFrom,
      );
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

  /** Each plot's value on a bar (NaN where it has none, or past either end). */
  valuesAt(index: number): number[] {
    const inside = index >= 0 && index < this.length;
    return this.values.map((plot) => (inside ? (plot[index] as number) : Number.NaN));
  }

  private adopt(): void {
    const main = this.main as Execution;
    this.values = main.outputs.plots;
    this.plotColors = main.outputs.plotColors;
    this.backgrounds = main.outputs.backgrounds;
    this.fillColors = main.outputs.fillColors;
    this.error = main.error;
  }

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

  /** Works out where each output is drawn from (see CHECKS). */
  private settle(length: number): void {
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
      if (this.fromListing) return 0;
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
