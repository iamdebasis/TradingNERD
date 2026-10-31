import type { Bar } from '@tradingnerd/core';
import { PineRuntimeError } from './diagnostics.ts';
import type { Stateful } from './ta.ts';
import type { Value } from './values.ts';

/**
 * A variable while the script runs (Pine docs, Execution model and Variable declarations): each
 * execution of its declaration adds an element to its history, `x[1]` reads the one before; an
 * update on the live bar is rolled back before the next, and the bar's closing update commits.
 * A `var` keeps its value from bar to bar; a `varip` also keeps it through the live bar's
 * updates.
 */
export class Slot {
  readonly mode: 'var' | 'varip' | null;
  /** Whether the script reads its history (`x[k]`); if not, only its latest value is kept. */
  readonly history: boolean;
  /** Its value now: the latest element. */
  private current: Value = null;
  /** Every element, when its history is read: numbers in a typed array, the rest in a list. */
  private numbers: Float64Array | null;
  private others: Value[] | null;
  private length = 0;
  private committed = 0;
  /** A var's value, and whether it has had its first value. */
  private varValue: Value = null;
  private varInit = false;
  private committedVarValue: Value = null;
  private committedVarInit = false;

  constructor(mode: 'var' | 'varip' | null, history: boolean, numeric: boolean) {
    this.mode = mode;
    this.history = history;
    this.numbers = history && numeric ? new Float64Array(256) : null;
    this.others = history && !numeric ? [] : null;
  }

  /** Rolls back and commits: one with a history or a var's value. */
  get tracked(): boolean {
    return this.history || this.mode !== null;
  }

  /** A var that has had its first value: its declaration's expression doesn't run again. */
  get kept(): boolean {
    return this.mode !== null && this.varInit;
  }

  /** The declaration ran with this value: a new element (a var's kept value, once it has one). */
  push(value: Value): Value {
    let v = value;
    if (this.mode) {
      if (this.varInit) v = this.varValue;
      else {
        this.varValue = v;
        this.varInit = true;
      }
    }
    this.current = v;
    if (this.history) this.store(this.length++, v);
    return v;
  }

  get(): Value {
    return this.current;
  }

  set(value: Value): void {
    this.current = value;
    if (this.history) {
      if (this.length === 0) this.length = 1;
      this.store(this.length - 1, value);
    }
    if (this.mode) this.varValue = value;
  }

  /** The value `k` executions back (0 = now), undefined before the first. */
  back(k: number): Value | undefined {
    const i = this.length - 1 - k;
    if (i < 0) return undefined;
    return this.numbers ? (this.numbers[i] as number) : (this.others as Value[])[i];
  }

  /** Before each execution: back to the last commit (a `varip` keeps its value). */
  rollback(): void {
    if (this.history) {
      this.length = this.committed;
      this.current = this.length > 0 ? (this.back(0) as Value) : null;
    }
    if (this.mode === 'var') {
      this.varValue = this.committedVarValue;
      this.varInit = this.committedVarInit;
    }
  }

  commit(): void {
    this.committed = this.length;
    if (this.mode) {
      this.committedVarValue = this.varValue;
      this.committedVarInit = this.varInit;
    }
  }

  save(): unknown {
    return [this.committed, this.committedVarValue, this.committedVarInit];
  }

  restore(state: unknown): void {
    const [committed, value, init] = state as [number, Value, boolean];
    this.committed = committed;
    this.committedVarValue = value;
    this.committedVarInit = init;
    this.varValue = value;
    this.varInit = init;
    if (this.history) {
      this.length = committed;
      this.current = this.length > 0 ? (this.back(0) as Value) : null;
    }
  }

  private store(i: number, v: Value): void {
    const numbers = this.numbers;
    if (!numbers) {
      (this.others as Value[])[i] = v;
      return;
    }
    if (i < numbers.length) {
      numbers[i] = v as number;
      return;
    }
    const grown = new Float64Array(numbers.length * 2);
    grown.set(numbers);
    grown[i] = v as number;
    this.numbers = grown;
  }
}

/**
 * What a script's outputs give, bar by bar: the output calls write straight into these, at the
 * bar being run (NaN where there's nothing). Colors are packed; NaN is na.
 */
export interface Outputs {
  /** Each plot's value. */
  plots: Float64Array[];
  /** Each plot's color, for a plot whose color changes from bar to bar. */
  plotColors: (Float64Array | null)[];
  /** Each bgcolor()'s color. */
  backgrounds: Float64Array[];
  /** Each fill's color, for a fill whose color changes from bar to bar. */
  fillColors: (Float64Array | null)[];
}

/** How long one bar's execution may take, as Pine stops a loop after 500 ms. */
const BAR_BUDGET_MS = 500;

/** What a script may know of the chart's symbol (Pine's syminfo.* and timeframe.*). */
export interface ScriptSymbol {
  /** "XRPUSDT" */
  ticker: string;
  /** "BINANCE:XRPUSDT" */
  tickerid: string;
  description: string;
  /** Pine's syminfo.type: "crypto", "stock", "fund", "index", "spread". */
  type: string;
  basecurrency: string;
  currency: string;
  /** The smallest price step. */
  mintick: number;
  /** The chart's interval in Pine's notation: "1", "60", "1D", "1W", "1M", "1S", "10T". */
  timeframe: string;
  /** Whether its bars carry real traded volume; `volume` is na otherwise. */
  hasVolume: boolean;
}

export const DEFAULT_SYMBOL: ScriptSymbol = {
  ticker: '',
  tickerid: '',
  description: '',
  type: 'crypto',
  basecurrency: '',
  currency: '',
  mintick: 0.01,
  timeframe: '1D',
  hasVolume: true,
};

/**
 * One running instance of a compiled script: its variables, the state of each of its built-in
 * calls, and the bar it's on. The compiled code reads and writes it.
 */
export class Runtime {
  bars: readonly Bar[] = [];
  /** The first bar this run computes from (the warm-up check's shifted run starts later). */
  start = 0;
  /** Stand-ins for the first bars (the warm-up check's runs with them changed); empty for none. */
  changed: readonly Bar[] = [];
  /**
   * The first realtime bar: the live bar when the bars were loaded, and every bar after it
   * (Pine's barstate.isrealtime); the bars before it are historical.
   */
  realtimeFrom = 0;
  index = 0;
  symbol: ScriptSymbol = DEFAULT_SYMBOL;
  /** The values of the script's inputs, by input. */
  inputs: readonly Value[] = [];
  /** This execution commits (a closed bar, or the live bar's last update). */
  final = true;
  /** The first execution on this bar (Pine's barstate.isnew). */
  isNew = true;
  /** Set by break and continue inside a loop. */
  signal: 0 | 1 | 2 = 0;
  /** The slots that roll back and commit (the others are only ever read after being set). */
  readonly slots: Slot[] = [];
  readonly stateful: Stateful[] = [];
  outputs: Outputs = { plots: [], plotColors: [], backgrounds: [], fillColors: [] };
  private lastIndex = -1;
  /** The last execution committed: nothing to roll back before the next. */
  private committed = true;
  private deadline = 0;
  private ticks = 0;

  slot(mode: 'var' | 'varip' | null, history: boolean, numeric: boolean): Slot {
    const slot = new Slot(mode, history, numeric);
    if (slot.tracked) this.slots.push(slot);
    return slot;
  }

  register<T extends Stateful>(instance: T): T {
    this.stateful.push(instance);
    return instance;
  }

  get bar(): Bar {
    const i = this.index;
    return i < this.changed.length ? (this.changed[i] as Bar) : (this.bars[i] as Bar);
  }

  /** The bar `k` bars back from the current one, or undefined before this run's first. */
  barBack(k: number): Bar | undefined {
    const i = this.index - k;
    if (i < this.start) return undefined;
    return i < this.changed.length ? this.changed[i] : this.bars[i];
  }

  begin(index: number, final: boolean): void {
    this.index = index;
    this.final = final;
    this.isNew = index !== this.lastIndex;
    this.lastIndex = index;
    this.signal = 0;
    this.ticks = 0;
    if (!this.committed) for (const slot of this.slots) slot.rollback();
    this.committed = false;
  }

  end(): void {
    if (!this.final) return;
    for (const slot of this.slots) slot.commit();
    this.committed = true;
  }

  /**
   * Loops call this each iteration: a bar whose loops run too long stops the script, as Pine's
   * does (Pine docs, Limitations: 500 ms per bar).
   */
  tick(): void {
    // The clock starts at the bar's first loop iteration, and is read every 1,024 after.
    if (this.ticks++ === 0) {
      this.deadline = Date.now() + BAR_BUDGET_MS;
      return;
    }
    if ((this.ticks & 1023) === 0 && Date.now() > this.deadline) {
      throw new PineRuntimeError(
        `Loop takes too long to execute (> ${BAR_BUDGET_MS} ms) on bar ${this.index}`,
      );
    }
  }

  save(): unknown {
    return [
      this.slots.map((slot) => slot.save()),
      this.stateful.map((s) => s.save()),
      this.lastIndex,
    ];
  }

  restore(state: unknown): void {
    const [slots, stateful, lastIndex] = state as [unknown[], unknown[], number];
    this.slots.forEach((slot, i) => {
      slot.restore(slots[i]);
    });
    this.stateful.forEach((s, i) => {
      s.restore(stateful[i]);
    });
    this.lastIndex = lastIndex;
    this.committed = false;
  }
}
