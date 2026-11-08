import type { Bar } from '@tradingnerd/core';
import type { CompiledProgram } from './compiler.ts';
import { PineRuntimeError, type Span } from './diagnostics.ts';
import type { LogEntry, Outputs, Runtime, ScriptSymbol } from './runtime.ts';
import type { Value } from './values.ts';

/** A runtime error: the script stops, as Pine's do, and the chart shows the message. */
export interface ScriptError {
  message: string;
  span: Span | null;
  /** The bar it stopped on. */
  bar: number;
}

/**
 * What every execution of one load of a script shares: timenow on its history (Pine docs, Time:
 * nearly the same on every historical bar) and math.random()'s seed, so the warm-up check's runs
 * agree with the main one.
 */
export interface RunClock {
  now: number;
  seed: number;
}

/** Room for this many bars past the loaded ones, so live bars rarely need new arrays. */
const SPARE = 1024;
const NONE = new Float64Array(0);

/**
 * One execution of the script over the bars, from bar `start`, with bar 0 changed or not: its
 * outputs on each bar it has computed (NaN before `start` and past its last bar).
 */
export class Execution {
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
    clock: RunClock,
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
    rt.now = clock.now;
    rt.seed = clock.seed;
    rt.start = start;
    rt.changed = changed;
    rt.realtimeFrom = realtimeFrom;
    rt.outputs = this.outputs;
    if (program.indicator?.drawings) rt.drawings.limits = { ...program.indicator.drawings };
  }

  /** The runtime it runs in: its variables, and a request's captured values. */
  get runtime(): Runtime {
    return this.program.runtime;
  }

  /** Its Pine Logs, oldest first. */
  get logs(): readonly LogEntry[] {
    return this.program.runtime.logs;
  }

  /** How many messages it has logged in all: it changes when there are new ones. */
  get logsWritten(): number {
    return this.program.runtime.logsWritten;
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
    // Realtime executions see the time they run at (timenow; Pine docs, Time).
    this.program.runtime.now = Date.now();
    this.run(bars.length - 1, false);
  }

  /** A new bar opened: the one before it commits. */
  next(bars: readonly Bar[]): void {
    const last = bars.length - 1;
    this.room(bars.length);
    this.program.runtime.bars = bars;
    this.program.runtime.now = Date.now();
    this.beforeLastCommit = this.program.runtime.save();
    this.run(last - 1, true);
    this.run(last, false);
    this.length = bars.length;
  }

  get canCorrect(): boolean {
    // Collections and objects change in place: a script that makes them runs afresh instead.
    return (
      this.beforeLastCommit !== null && this.error === null && !this.program.runtime.usesObjects
    );
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
export const CHECKS: readonly { start: number; scales: readonly number[]; memory: boolean }[] = [
  { start: 1, scales: [], memory: false },
  { start: 0, scales: [1.01], memory: false },
  { start: 0, scales: [1000, 0.001], memory: true },
];

export const scaledBar = (bar: Bar, k: number): Bar => ({
  ...bar,
  open: bar.open * k,
  high: bar.high * k,
  low: bar.low * k,
  close: bar.close * k,
  volume: bar.volume * k,
});
