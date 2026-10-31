/**
 * Pine Script's built-in functions, one bar at a time, as TradingView computes them (docs/SPEC.md
 * §6.16; formulas from the Pine Script v6 reference, §4.15).
 *
 * Each kernel follows Pine's execution model: a `final` step commits the bar, as Pine does on a
 * bar's closing tick; any other step is tentative and leaves the committed state as it was, as
 * Pine rolls back before each realtime tick. `save` and `restore` let a run go back one commit,
 * for an exchange's late correction of the bar before the live one.
 *
 * na values (NaN here) follow Pine's rules: the averages ignore them and count their length in
 * values that aren't na; `change` passes them through.
 */
export interface Kernel {
  /** The value for this bar; `final` commits it. */
  next(value: number, final: boolean): number;
  /** A copy of the committed state. */
  save(): unknown;
  restore(state: unknown): void;
}

/** Sliding sums are summed afresh this often, so 20,000 bars of additions never drift. */
const RESUM_EVERY = 1_024;

/** The last `length` values that weren't na, oldest first in time. */
class Window {
  readonly length: number;
  private values: Float64Array;
  /** Values committed so far; the oldest of a full window sits at `count % length`. */
  private count = 0;

  constructor(length: number) {
    this.length = length;
    this.values = new Float64Array(length);
  }

  get size(): number {
    return Math.min(this.count, this.length);
  }

  get full(): boolean {
    return this.count >= this.length;
  }

  /** The value a new one would push out, once the window is full. */
  oldest(): number {
    return this.values[this.count % this.length] ?? Number.NaN;
  }

  /** The i-th newest value (0 = newest). */
  back(i: number): number {
    return this.values[(this.count - 1 - i + this.length * 2) % this.length] ?? Number.NaN;
  }

  push(value: number): void {
    this.values[this.count % this.length] = value;
    this.count++;
  }

  save(): { values: Float64Array; count: number } {
    return { values: this.values.slice(), count: this.count };
  }

  restore(state: { values: Float64Array; count: number }): void {
    this.values = state.values.slice();
    this.count = state.count;
  }
}

/** `ta.sma`: the sum of the last `length` values divided by `length`. */
export class Sma implements Kernel {
  private readonly window: Window;
  private sum = 0;
  private sinceResum = 0;

  constructor(length: number) {
    this.window = new Window(length);
  }

  next(value: number, final: boolean): number {
    if (Number.isNaN(value)) return this.current();
    const { window } = this;
    const sum = this.sum + value - (window.full ? window.oldest() : 0);
    const size = Math.min(window.size + 1, window.length);
    const result = size < window.length ? Number.NaN : sum / window.length;
    if (final) {
      window.push(value);
      this.sum = sum;
      if (++this.sinceResum >= RESUM_EVERY) this.resum();
    }
    return result;
  }

  /** The committed value: NaN until `length` values have come. */
  current(): number {
    return this.window.full ? this.sum / this.window.length : Number.NaN;
  }

  private resum(): void {
    let sum = 0;
    for (let i = 0; i < this.window.size; i++) sum += this.window.back(i);
    this.sum = sum;
    this.sinceResum = 0;
  }

  save(): unknown {
    return { window: this.window.save(), sum: this.sum, sinceResum: this.sinceResum };
  }

  restore(state: unknown): void {
    const s = state as { window: ReturnType<Window['save']>; sum: number; sinceResum: number };
    this.window.restore(s.window);
    this.sum = s.sum;
    this.sinceResum = s.sinceResum;
  }
}

/**
 * An exponentially weighted average seeded with the SMA of its first `length` values, then
 * `alpha * value + (1 - alpha) * previous`. With alpha = 1/length it's `ta.rma` (Wilder's, the
 * reference's own seed); with alpha = 2/(length + 1) it's `ta.ema`, whose seed TradingView's Help
 * Center gives as the SMA ("Moving Averages": "For the first EMA, we use the SMA"; §4.15).
 */
class Smoothed implements Kernel {
  private readonly alpha: number;
  private readonly seed: Sma;
  private value = Number.NaN;

  constructor(length: number, alpha: number) {
    this.alpha = alpha;
    this.seed = new Sma(length);
  }

  next(value: number, final: boolean): number {
    if (Number.isNaN(value)) return this.value;
    const result = Number.isNaN(this.value)
      ? this.seed.next(value, final)
      : this.alpha * value + (1 - this.alpha) * this.value;
    if (final) this.value = result;
    return result;
  }

  save(): unknown {
    return { seed: this.seed.save(), value: this.value };
  }

  restore(state: unknown): void {
    const s = state as { seed: unknown; value: number };
    this.seed.restore(s.seed);
    this.value = s.value;
  }
}

/** `ta.rma`: Wilder's moving average, alpha = 1/length, seeded with the SMA. */
export class Rma extends Smoothed {
  constructor(length: number) {
    super(length, 1 / length);
  }
}

/** `ta.ema`: alpha = 2/(length + 1), seeded with the SMA. */
export class Ema extends Smoothed {
  constructor(length: number) {
    super(length, 2 / (length + 1));
  }
}

/**
 * `ta.wma`: weights falling in arithmetic progression, the newest `length`, the oldest 1.
 * Kept in O(1) a bar: adding value b to a full window takes the weighted sum from N to
 * N − S + length·b, where S is the window's plain sum.
 */
export class Wma implements Kernel {
  private readonly window: Window;
  /** The window's weighted and plain sums, once it is full. */
  private weighted = 0;
  private sum = 0;
  private sinceResum = 0;

  constructor(length: number) {
    this.window = new Window(length);
  }

  next(value: number, final: boolean): number {
    if (Number.isNaN(value)) return this.current();
    const { window } = this;
    const length = window.length;
    let weighted: number;
    let sum: number;
    if (window.full) {
      weighted = this.weighted - this.sum + length * value;
      sum = this.sum - window.oldest() + value;
    } else if (window.size + 1 === length) {
      // The window fills with this value: sum it outright.
      weighted = length * value;
      sum = value;
      for (let i = 0; i < window.size; i++) {
        const older = window.back(i);
        weighted += (length - 1 - i) * older;
        sum += older;
      }
    } else {
      weighted = Number.NaN;
      sum = Number.NaN;
    }
    if (final) {
      window.push(value);
      this.weighted = weighted;
      this.sum = sum;
      if (window.full && ++this.sinceResum >= RESUM_EVERY) this.resum();
    }
    return Number.isNaN(weighted) ? Number.NaN : weighted / ((length * (length + 1)) / 2);
  }

  private current(): number {
    const length = this.window.length;
    return this.window.full ? this.weighted / ((length * (length + 1)) / 2) : Number.NaN;
  }

  private resum(): void {
    const length = this.window.length;
    let weighted = 0;
    let sum = 0;
    for (let i = 0; i < length; i++) {
      const value = this.window.back(i);
      weighted += (length - i) * value;
      sum += value;
    }
    this.weighted = weighted;
    this.sum = sum;
    this.sinceResum = 0;
  }

  save(): unknown {
    return {
      window: this.window.save(),
      weighted: this.weighted,
      sum: this.sum,
      sinceResum: this.sinceResum,
    };
  }

  restore(state: unknown): void {
    const s = state as {
      window: ReturnType<Window['save']>;
      weighted: number;
      sum: number;
      sinceResum: number;
    };
    this.window.restore(s.window);
    this.weighted = s.weighted;
    this.sum = s.sum;
    this.sinceResum = s.sinceResum;
  }
}

/** `ta.vwma`: `ta.sma(source * volume, length) / ta.sma(volume, length)`, as the reference has it. */
export class Vwma {
  private readonly weighted: Sma;
  private readonly volume: Sma;

  constructor(length: number) {
    this.weighted = new Sma(length);
    this.volume = new Sma(length);
  }

  next(value: number, volume: number, final: boolean): number {
    const weighted = this.weighted.next(value * volume, final);
    const total = this.volume.next(volume, final);
    return weighted / total;
  }

  save(): unknown {
    return { weighted: this.weighted.save(), volume: this.volume.save() };
  }

  restore(state: unknown): void {
    const s = state as { weighted: unknown; volume: unknown };
    this.weighted.restore(s.weighted);
    this.volume.restore(s.volume);
  }
}

/**
 * Deviations this close to zero count as zero, as the reference's own `ta.stdev` does (its
 * `SUM` helper; its odd branch for deviations under 1e-4, which would return 15, isn't followed:
 * Bollinger Bands on coins priced under a cent show no such thing).
 */
const STDEV_EPSILON = 1e-10;

/** `ta.stdev` with `biased = true` (the default): the population standard deviation. */
export class Stdev implements Kernel {
  private readonly window: Window;

  constructor(length: number) {
    this.window = new Window(length);
  }

  next(value: number, final: boolean): number {
    if (Number.isNaN(value)) return this.of(null);
    const result = this.of(value);
    if (final) this.window.push(value);
    return result;
  }

  /** Over the committed window, with `value` as its newest when given. */
  private of(value: number | null): number {
    const { window } = this;
    const length = window.length;
    const values: number[] = [];
    if (value !== null) values.push(value);
    for (let i = 0; values.length < length && i < window.size; i++) values.push(window.back(i));
    if (values.length < length) return Number.NaN;
    let mean = 0;
    for (const v of values) mean += v;
    mean /= length;
    let squares = 0;
    for (const v of values) {
      const deviation = v - mean;
      if (Math.abs(deviation) > STDEV_EPSILON) squares += deviation * deviation;
    }
    return Math.sqrt(squares / length);
  }

  save(): unknown {
    return this.window.save();
  }

  restore(state: unknown): void {
    this.window.restore(state as ReturnType<Window['save']>);
  }
}

/** `ta.change`: this value minus the previous one; na on the first bar or next to an na. */
export class Change implements Kernel {
  private previous = Number.NaN;

  next(value: number, final: boolean): number {
    const result = value - this.previous;
    if (final) this.previous = value;
    return result;
  }

  save(): unknown {
    return this.previous;
  }

  restore(state: unknown): void {
    this.previous = state as number;
  }
}
