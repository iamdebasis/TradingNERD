import type { Bar } from '@tradingnerd/core';
import type {
  IndicatorCalculator,
  IndicatorDefinition,
  Inputs,
  StepResult,
  SymbolContext,
} from './types.ts';

/** How the chart's bars changed since the run last saw them. */
export type BarChange =
  /** The live bar moved. */
  | 'tick'
  /** A new bar opened; the one before it is final. */
  | 'new'
  /** An exchange's late final word on the bar before the live one. */
  | 'correction';

/**
 * One indicator over the chart's bars, kept in step with them as Pine keeps a script: every bar
 * but the last is committed, the last (live) one is tentative (docs/SPEC.md §6.16).
 *
 * A live tick recomputes only the last bar; a new bar commits the one before it; a correction of
 * that bar goes back one commit and redoes it. Anything else (a new page of history, a refill
 * after a reconnect, other settings) computes the whole run again, as Pine reloads a script.
 */
export class IndicatorRun {
  readonly definition: IndicatorDefinition;
  readonly inputs: Inputs;
  readonly symbol: SymbolContext;
  /** One array per plot: its value on each bar, NaN where it has none. */
  values: number[][] = [];
  /** Per bar, for columns colored by direction: whether the bar was growing. */
  growing: boolean[] = [];
  private calculator: IndicatorCalculator;
  /** The committed state from before the last commit, to redo it after a correction. */
  private beforeLastCommit: unknown = null;

  constructor(definition: IndicatorDefinition, inputs: Inputs, symbol: SymbolContext) {
    this.definition = definition;
    this.inputs = inputs;
    this.symbol = symbol;
    this.calculator = definition.create(inputs, symbol);
  }

  get length(): number {
    return this.growing.length;
  }

  /** Computes every bar afresh. */
  setBars(bars: readonly Bar[]): void {
    this.calculator = this.definition.create(this.inputs, this.symbol);
    this.values = this.definition.plots.map(() => new Array<number>(bars.length));
    this.growing = new Array<boolean>(bars.length);
    this.beforeLastCommit = null;
    const last = bars.length - 1;
    for (let i = 0; i < last; i++) {
      if (i === last - 1) this.beforeLastCommit = this.calculator.save();
      this.record(i, this.calculator.step(bars[i] as Bar, true));
    }
    if (last >= 0) this.record(last, this.calculator.step(bars[last] as Bar, false));
  }

  /**
   * Follows a change the chart made to its bars, at `index`. Returns the bars whose values
   * changed, or 'all' when the run was computed afresh.
   */
  update(bars: readonly Bar[], change: BarChange, index: number): number[] | 'all' {
    const last = bars.length - 1;
    if (last < 0) {
      this.setBars(bars);
      return 'all';
    }
    if (change === 'tick' && index === last && this.length === bars.length) {
      this.record(last, this.calculator.step(bars[last] as Bar, false));
      return [last];
    }
    if (change === 'new' && index === last && last >= 1 && this.length === bars.length - 1) {
      this.beforeLastCommit = this.calculator.save();
      this.record(last - 1, this.calculator.step(bars[last - 1] as Bar, true));
      this.record(last, this.calculator.step(bars[last] as Bar, false));
      return [last - 1, last];
    }
    if (
      change === 'correction' &&
      index === last - 1 &&
      this.length === bars.length &&
      this.beforeLastCommit !== null
    ) {
      this.calculator.restore(this.beforeLastCommit);
      this.record(last - 1, this.calculator.step(bars[last - 1] as Bar, true));
      this.record(last, this.calculator.step(bars[last] as Bar, false));
      return [last - 1, last];
    }
    this.setBars(bars);
    return 'all';
  }

  /** Each plot's value on a bar (NaN where it has none, or past either end). */
  valuesAt(index: number): number[] {
    return this.values.map((plot) => plot[index] ?? Number.NaN);
  }

  private record(index: number, result: StepResult): void {
    for (let p = 0; p < this.values.length; p++) {
      (this.values[p] as number[])[index] = result.values[p] ?? Number.NaN;
    }
    this.growing[index] = result.growing ?? true;
  }
}
