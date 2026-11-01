import { Change, Ema, type Kernel, Rma, Sma, Stdev, Vwma, Wma } from '@tradingnerd/indicators';
import { PineRuntimeError } from './diagnostics.ts';

/**
 * Pine's built-in functions that keep state between bars, one instance per call in the script
 * (Pine docs, Execution model: each call keeps its own history). Each follows Pine's rollback: a
 * `final` call commits, as on a bar's closing update; any other call leaves the committed state
 * as it was. Formulas are the Pine v6 reference's ("the same on Pine"); the averages reuse
 * `packages/indicators`' kernels, checked against TradingView in I1.
 */
export interface Stateful {
  save(): unknown;
  restore(state: unknown): void;
}

/** Numbers committed one per call, read back by how many commits ago. */
export class Hist {
  private data = new Float64Array(64);
  length = 0;

  push(value: number): void {
    if (this.length === this.data.length) {
      const bigger = new Float64Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    this.data[this.length++] = value;
  }

  /** The value committed `k` calls ago (1 = the last), NaN before the first. */
  back(k: number): number {
    const i = this.length - k;
    return i >= 0 ? (this.data[i] as number) : Number.NaN;
  }

  save(): number {
    return this.length;
  }

  /** History only grows between a save and its restore, so restoring is forgetting. */
  restore(length: number): void {
    this.length = length;
  }
}

const isNa = Number.isNaN;

/** A function's `length` must be a positive whole number (Pine's runtime error otherwise). */
export function checkLength(fn: string, length: number, min = 1): number {
  if (!(length >= min) || !Number.isFinite(length)) {
    throw new PineRuntimeError(
      `Invalid value of the 'length' argument (${Number.isNaN(length) ? 'na' : length}) in the '${fn}' function. It must be >= ${min}.`,
    );
  }
  return Math.floor(length);
}

/** A kernel made on the first call, with the length that call gives (a "simple" length). */
export class KernelFn implements Stateful {
  private kernel: Kernel | null = null;
  private readonly make: (length: number) => Kernel;
  private readonly fn: string;

  private readonly skipNa: boolean;

  constructor(fn: string, make: (length: number) => Kernel, skipNa = false) {
    this.fn = fn;
    this.make = make;
    this.skipNa = skipNa;
  }

  call(value: number, length: number, final: boolean): number {
    if (!this.kernel) this.kernel = this.make(checkLength(this.fn, length));
    // An na bar is skipped: na out, the average as it was (TradingView's ta.ema and ta.rma,
    // measured by PineTS); ta.sma keeps its window's average.
    if (this.skipNa && isNa(value)) return Number.NaN;
    return this.kernel.next(value, final);
  }

  save(): unknown {
    return this.kernel?.save() ?? null;
  }

  restore(state: unknown): void {
    if (state !== null) this.kernel?.restore(state);
  }
}

export const smaFn = () => new KernelFn('ta.sma', (n) => new Sma(n));
export const emaFn = () => new KernelFn('ta.ema', (n) => new Ema(n), true);
export const rmaFn = () => new KernelFn('ta.rma', (n) => new Rma(n), true);
export const wmaFn = () => new KernelFn('ta.wma', (n) => new Wma(n));

/** `ta.sma` with a length that may change from bar to bar: the mean of the last values not na. */
export class DynamicSma implements Stateful {
  private readonly values = new Hist();

  call(value: number, length: number, final: boolean): number {
    const n = checkLength('ta.sma', length);
    let sum = isNa(value) ? 0 : value;
    let count = isNa(value) ? 0 : 1;
    for (let k = 1; count < n && k <= this.values.length; k++) {
      sum += this.values.back(k);
      count++;
    }
    if (final && !isNa(value)) this.values.push(value);
    return count < n ? Number.NaN : sum / n;
  }

  save(): unknown {
    return this.values.save();
  }

  restore(state: unknown): void {
    this.values.restore(state as number);
  }
}

export class VwmaFn implements Stateful {
  private kernel: Vwma | null = null;

  call(value: number, volume: number, length: number, final: boolean): number {
    if (!this.kernel) this.kernel = new Vwma(checkLength('ta.vwma', length));
    return this.kernel.next(value, volume, final);
  }

  save(): unknown {
    return this.kernel?.save() ?? null;
  }

  restore(state: unknown): void {
    if (state !== null) this.kernel?.restore(state);
  }
}

/**
 * `ta.vwma` with a length that may change from bar to bar: sma(source × volume) / sma(volume),
 * each over its own values that aren't na (an na source skips the numerator only, measured by
 * PineTS on TradingView).
 */
export class DynamicVwma implements Stateful {
  private readonly weighted = new DynamicSma();
  private readonly volume = new DynamicSma();

  call(value: number, volume: number, length: number, final: boolean): number {
    return (
      this.weighted.call(value * volume, length, final) / this.volume.call(volume, length, final)
    );
  }

  save(): unknown {
    return [this.weighted.save(), this.volume.save()];
  }

  restore(state: unknown): void {
    const [weighted, volume] = state as [unknown, unknown];
    this.weighted.restore(weighted);
    this.volume.restore(volume);
  }
}

/** `ta.stdev` and `ta.variance`: the population's by default, the sample's when not biased. */
export class StdevFn implements Stateful {
  private kernel: Stdev | null = null;
  private readonly variance: boolean;

  constructor(variance: boolean) {
    this.variance = variance;
  }

  call(value: number, length: number, biased: boolean, final: boolean): number {
    const n = checkLength(this.variance ? 'ta.variance' : 'ta.stdev', length);
    if (!this.kernel) this.kernel = new Stdev(n);
    const stdev = this.kernel.next(value, final);
    const scaled = biased || n < 2 ? stdev : stdev * Math.sqrt(n / (n - 1));
    return this.variance ? scaled * scaled : scaled;
  }

  save(): unknown {
    return this.kernel?.save() ?? null;
  }

  restore(state: unknown): void {
    if (state !== null) this.kernel?.restore(state);
  }
}

/**
 * `ta.stdev` and `ta.variance` with a length that may change from bar to bar: over the last
 * `length` values not na, as the kernel's.
 */
export class WindowStdevFn implements Stateful {
  private readonly values = new Hist();
  private readonly variance: boolean;

  constructor(variance: boolean) {
    this.variance = variance;
  }

  call(value: number, length: number, biased: boolean, final: boolean): number {
    const n = checkLength(this.variance ? 'ta.variance' : 'ta.stdev', length);
    const window: number[] = [];
    if (!isNa(value)) window.push(value);
    for (let k = 1; window.length < n && k <= this.values.length; k++)
      window.push(this.values.back(k));
    if (final && !isNa(value)) this.values.push(value);
    if (window.length < n) return Number.NaN;
    let mean = 0;
    for (const v of window) mean += v;
    mean /= n;
    let squares = 0;
    for (const v of window) {
      const deviation = v - mean;
      if (Math.abs(deviation) > 1e-10) squares += deviation * deviation;
    }
    const variance = squares / (biased || n < 2 ? n : n - 1);
    return this.variance ? variance : Math.sqrt(variance);
  }

  save(): unknown {
    return this.values.save();
  }

  restore(state: unknown): void {
    this.values.restore(state as number);
  }
}

/**
 * A function of the current value and the ones before it (na included), by bar when the caller
 * gives the bar: the history `source[i]` has inside a Pine function. On a bar the call skipped,
 * the last call's value repeats, as TradingView's ta.wma, ta.change, ta.swma … do inside an `if`
 * or a ternary (measured by PineTS on TradingView, third-party: docs/SPEC.md §4.17). At the top
 * level, where the call runs on every bar, it's the values themselves.
 */
export abstract class Windowed implements Stateful {
  protected readonly values = new Hist();
  private lastIndex = -1;
  private last = Number.NaN;

  /** Before a call on bar `index`: the bars since the last call repeat its value. */
  protected sync(index: number): void {
    if (this.lastIndex < 0 || index < 0) return;
    while (this.lastIndex < index - 1) {
      this.values.push(this.last);
      this.lastIndex++;
    }
  }

  /** The value `k` bars back, 0 being the current one. */
  protected at(current: number, k: number): number {
    return k === 0 ? current : this.values.back(k);
  }

  /** How many bars there are, the current one included. */
  protected bars(): number {
    return this.values.length + 1;
  }

  protected commit(value: number, final: boolean, index = -1): void {
    if (!final) return;
    this.values.push(value);
    this.last = value;
    if (index >= 0) this.lastIndex = index;
  }

  save(): unknown {
    return [this.values.save(), this.lastIndex, this.last];
  }

  restore(state: unknown): void {
    const [length, lastIndex, last] = state as [number, number, number];
    this.values.restore(length);
    this.lastIndex = lastIndex;
    this.last = last;
  }
}

/**
 * `ta.wma` by the reference's weights over a window of bars, the length free to change. An na
 * bar gives na, and the window then holds the last value that wasn't na in its place (measured
 * by PineTS on TradingView, third-party).
 */
export class WmaFn extends Windowed {
  private good = Number.NaN;

  call(value: number, length: number, final: boolean, index = -1): number {
    const n = checkLength('ta.wma', length);
    this.sync(index);
    const kept = isNa(value) ? this.good : value;
    let result = Number.NaN;
    if (!isNa(value) && this.bars() >= n) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += this.at(kept, k) * (n - k);
      result = sum / ((n * (n + 1)) / 2);
    }
    this.commit(kept, final, index);
    if (final && !isNa(value)) this.good = value;
    return result;
  }

  override save(): unknown {
    return [super.save(), this.good];
  }

  override restore(state: unknown): void {
    const [own, good] = state as [unknown, number];
    super.restore(own);
    this.good = good;
  }
}

/** `ta.change`, `ta.mom` and `ta.roc`: against the value `length` bars back, na included. */
export class ChangeFn extends Windowed {
  private readonly kind: 'change' | 'mom' | 'roc';

  constructor(kind: 'change' | 'mom' | 'roc') {
    super();
    this.kind = kind;
  }

  call(value: number, length: number, final: boolean, index = -1): number {
    const n = checkLength(`ta.${this.kind}`, length, this.kind === 'change' ? 0 : 1);
    this.sync(index);
    const before = this.at(value, n);
    this.commit(value, final, index);
    if (this.kind === 'roc') return (100 * (value - before)) / before;
    return value - before;
  }
}

/** `ta.change` of a bool: whether it differs from the bar before. */
export class BoolChangeFn extends Windowed {
  call(value: boolean, final: boolean, index = -1): boolean {
    this.sync(index);
    const before = this.values.back(1);
    this.commit(value ? 1 : 0, final, index);
    return !isNa(before) && before !== (value ? 1 : 0);
  }
}

/**
 * `ta.highest`, `ta.lowest` and their offsets: the extreme of the last `length` values that
 * aren't na, the newest of equal ones; the offsets count bars back to it. That is TradingView's
 * rule since 9 October 2026, also inside an `if` (measured by PineTS on TradingView,
 * third-party: docs/SPEC.md §4.17).
 */
export class ExtremeFn implements Stateful {
  private readonly highest: boolean;
  private readonly offset: boolean;
  private readonly values = new Hist();
  /** The bar of each value kept. */
  private readonly at = new Hist();
  private calls = 0;

  constructor(highest: boolean, offset: boolean) {
    this.highest = highest;
    this.offset = offset;
  }

  call(value: number, length: number, final: boolean, index = -1): number {
    const fn = `ta.${this.highest ? 'highest' : 'lowest'}${this.offset ? 'bars' : ''}`;
    const n = checkLength(fn, length);
    const bar = index >= 0 ? index : this.calls;
    let best = Number.NaN;
    let bestBar = Number.NaN;
    let count = 0;
    if (!isNa(value)) {
      best = value;
      bestBar = bar;
      count = 1;
    }
    for (let k = 1; count < n && k <= this.values.length; k++, count++) {
      const v = this.values.back(k);
      // Older values win only when strictly beyond: of equals, the newest.
      if (isNa(best) || (this.highest ? v > best : v < best)) {
        best = v;
        bestBar = this.at.back(k);
      }
    }
    if (final) {
      if (!isNa(value)) {
        this.values.push(value);
        this.at.push(bar);
      }
      this.calls++;
    }
    if (count < n) return Number.NaN;
    return this.offset ? bestBar - bar : best;
  }

  save(): unknown {
    return [this.values.save(), this.at.save(), this.calls];
  }

  restore(state: unknown): void {
    const [values, at, calls] = state as [number, number, number];
    this.values.restore(values);
    this.at.restore(at);
    this.calls = calls;
  }
}

/**
 * `ta.rising` and `ta.falling`: the source rose (fell) on each of the last `length` bars. It
 * counts consecutive moves; a pair with an na neither adds to the run nor ends it. TradingView's
 * reference says only "rising for length bars long"; this rule matched TradingView's own values
 * on all 192 bars of PineTS's BINANCE:BTCUSDT 1h data, lengths changing from bar to bar and na
 * windows included (third-party data, checked 2026-11-01; docs/SPEC.md §4.17).
 */
export class TrendFn implements Stateful {
  private readonly rising: boolean;
  private run = 0;
  private last = Number.NaN;

  constructor(rising: boolean) {
    this.rising = rising;
  }

  call(value: number, length: number, final: boolean): boolean {
    const n = checkLength(this.rising ? 'ta.rising' : 'ta.falling', length);
    let run = this.run;
    if (!isNa(value) && !isNa(this.last)) {
      run = (this.rising ? value > this.last : value < this.last) ? run + 1 : 0;
    }
    if (final) {
      this.run = run;
      this.last = value;
    }
    return run >= n;
  }

  save(): unknown {
    return [this.run, this.last];
  }

  restore(state: unknown): void {
    [this.run, this.last] = state as [number, number];
  }
}

/** `ta.swma`: weights 1/6, 2/6, 2/6, 1/6 over the last four values, na included. */
export class SwmaFn extends Windowed {
  call(value: number, final: boolean, index = -1): number {
    this.sync(index);
    const result =
      (this.at(value, 3) * 1) / 6 +
      (this.at(value, 2) * 2) / 6 +
      (this.at(value, 1) * 2) / 6 +
      (value * 1) / 6;
    this.commit(value, final, index);
    return result;
  }
}

/**
 * `ta.dev`: the mean absolute deviation from the SMA of the last `length` values. Inside an `if`
 * the mean is over the calls and the deviations over the bars, as TradingView's; na while the
 * window holds one (measured by PineTS, third-party).
 */
export class DevFn extends Windowed {
  private readonly mean = new DynamicSma();

  call(value: number, length: number, final: boolean, index = -1): number {
    const n = checkLength('ta.dev', length);
    this.sync(index);
    const mean = this.mean.call(value, n, final);
    let result = Number.NaN;
    if (this.bars() >= n && !isNa(mean)) {
      let deviation = 0;
      for (let k = 0; k < n; k++) deviation += Math.abs(this.at(value, k) - mean);
      result = deviation / n;
    }
    this.commit(value, final, index);
    return result;
  }

  override save(): unknown {
    return [super.save(), this.mean.save()];
  }

  override restore(state: unknown): void {
    const [own, mean] = state as [unknown, unknown];
    super.restore(own);
    this.mean.restore(mean);
  }
}

/** `math.sum`: the sliding sum of the last `length` values not na. */
export class SumFn implements Stateful {
  private readonly values = new Hist();

  call(value: number, length: number, final: boolean): number {
    const n = checkLength('math.sum', length);
    let sum = isNa(value) ? 0 : value;
    let count = isNa(value) ? 0 : 1;
    for (let k = 1; count < n && k <= this.values.length; k++) {
      sum += this.values.back(k);
      count++;
    }
    if (final && !isNa(value)) this.values.push(value);
    return count < n ? Number.NaN : sum;
  }

  save(): unknown {
    return this.values.save();
  }

  restore(state: unknown): void {
    this.values.restore(state as number);
  }
}

/** `ta.cum`: the running total (na adds nothing). */
export class CumFn implements Stateful {
  private sum = 0;

  call(value: number, final: boolean): number {
    // na on an na bar, the sum going on after it (measured by PineTS on TradingView).
    if (isNa(value)) return Number.NaN;
    const result = this.sum + value;
    if (final) this.sum = result;
    return result;
  }

  save(): unknown {
    return this.sum;
  }

  restore(state: unknown): void {
    this.sum = state as number;
  }
}

/** `fixnan`: the last value that wasn't na. */
export class FixnanFn implements Stateful {
  private last = Number.NaN;

  call(value: number, final: boolean): number {
    const result = isNa(value) ? this.last : value;
    if (final) this.last = result;
    return result;
  }

  save(): unknown {
    return this.last;
  }

  restore(state: unknown): void {
    this.last = state as number;
  }
}

/**
 * `ta.crossover`, `ta.crossunder` and `ta.cross`: against the last call where both values
 * weren't na, so an na just before doesn't hide a cross (TradingView's rule, measured by PineTS:
 * docs/SPEC.md §4.17).
 */
export class CrossFn implements Stateful {
  private a = Number.NaN;
  private b = Number.NaN;
  private readonly kind: 'over' | 'under' | 'any';

  constructor(kind: 'over' | 'under' | 'any') {
    this.kind = kind;
  }

  call(a: number, b: number, final: boolean): boolean {
    if (isNa(a) || isNa(b)) return false;
    const over = a > b && this.a <= this.b;
    const under = a < b && this.a >= this.b;
    if (final) {
      this.a = a;
      this.b = b;
    }
    return this.kind === 'over' ? over : this.kind === 'under' ? under : over || under;
  }

  save(): unknown {
    return [this.a, this.b];
  }

  restore(state: unknown): void {
    [this.a, this.b] = state as [number, number];
  }
}

/** `ta.barssince`: bars since the condition last held; na before it ever has. */
export class BarssinceFn implements Stateful {
  private calls = 0;
  private lastTrue = Number.NaN;

  call(condition: boolean, final: boolean): number {
    const result = condition ? 0 : this.calls - this.lastTrue;
    if (final) {
      if (condition) this.lastTrue = this.calls;
      this.calls++;
    }
    return result;
  }

  save(): unknown {
    return [this.calls, this.lastTrue];
  }

  restore(state: unknown): void {
    [this.calls, this.lastTrue] = state as [number, number];
  }
}

/** `ta.valuewhen`: the source on the bar of the condition's nth latest occurrence (0 = latest). */
export class ValuewhenFn implements Stateful {
  private readonly values = new Hist();

  call(condition: boolean, value: number, occurrence: number, final: boolean): number {
    const n = Math.floor(occurrence);
    const result = condition ? (n === 0 ? value : this.values.back(n)) : this.values.back(n + 1);
    if (final && condition) this.values.push(value);
    return result;
  }

  save(): unknown {
    return this.values.save();
  }

  restore(state: unknown): void {
    this.values.restore(state as number);
  }
}

/**
 * `ta.pivothigh` and `ta.pivotlow`: the value `right` bars back when it's above (below) each
 * other value of the last `left + right + 1` that aren't na; na otherwise. Inside an `if` the
 * window is of calls and the centre the call made `right` bars back, as TradingView's: that rule
 * matched its values on all 420 bars of PineTS's data (2026-11-01; docs/SPEC.md §4.17). Ties
 * count as no pivot (not in the reference: provisional).
 */
export class PivotFn implements Stateful {
  private readonly high: boolean;
  private readonly values = new Hist();
  /** The bar of each value kept. */
  private readonly at = new Hist();
  private calls = 0;

  constructor(high: boolean) {
    this.high = high;
  }

  call(value: number, left: number, right: number, final: boolean, index = -1): number {
    const fn = this.high ? 'ta.pivothigh' : 'ta.pivotlow';
    const l = checkLength(fn, left, 0);
    const r = checkLength(fn, right, 0);
    const bar = index >= 0 ? index : this.calls;
    const size = l + r + 1;
    const values: number[] = [];
    const bars: number[] = [];
    if (!isNa(value)) {
      values.push(value);
      bars.push(bar);
    }
    for (let k = 1; values.length < size && k <= this.values.length; k++) {
      values.push(this.values.back(k));
      bars.push(this.at.back(k));
    }
    if (final) {
      if (!isNa(value)) {
        this.values.push(value);
        this.at.push(bar);
      }
      this.calls++;
    }
    if (values.length < size) return Number.NaN;
    const centre = bars.indexOf(bar - r);
    if (centre < 0) return Number.NaN;
    const c = values[centre] as number;
    for (let k = 0; k < size; k++) {
      if (k === centre) continue;
      const v = values[k] as number;
      if (this.high ? !(c > v) : !(c < v)) return Number.NaN;
    }
    return c;
  }

  save(): unknown {
    return [this.values.save(), this.at.save(), this.calls];
  }

  restore(state: unknown): void {
    const [values, at, calls] = state as [number, number, number];
    this.values.restore(values);
    this.at.restore(at);
    this.calls = calls;
  }
}

/** `ta.tr` and `ta.tr(handle_na)`: the true range against the close before. */
export class TrFn implements Stateful {
  private readonly closes = new Hist();

  /**
   * `before`: the previous bar's close. TradingView's ta.tr() and ta.atr read it even inside an
   * `if`; its ta.dmi takes the previous call's, which is used when `before` isn't given
   * (measured by PineTS on TradingView, third-party).
   */
  call(
    high: number,
    low: number,
    close: number,
    handleNa: boolean,
    final: boolean,
    before?: number,
  ): number {
    const previous = before === undefined ? this.closes.back(1) : before;
    const result = isNa(previous)
      ? handleNa
        ? high - low
        : Number.NaN
      : Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
    if (final) this.closes.push(close);
    return result;
  }

  save(): unknown {
    return this.closes.save();
  }

  restore(state: unknown): void {
    this.closes.restore(state as number);
  }
}

/** `ta.atr`: the RMA of the true range (the reference's "the same on Pine"). */
export class AtrFn implements Stateful {
  private readonly tr = new TrFn();
  private readonly rma = rmaFn();

  call(
    high: number,
    low: number,
    close: number,
    length: number,
    final: boolean,
    before?: number,
  ): number {
    return this.rma.call(this.tr.call(high, low, close, true, final, before), length, final);
  }

  save(): unknown {
    return [this.tr.save(), this.rma.save()];
  }

  restore(state: unknown): void {
    const [tr, rma] = state as [unknown, unknown];
    this.tr.restore(tr);
    this.rma.restore(rma);
  }
}

/** `ta.rsi`: 100 − 100 / (1 + RMA of the rises / RMA of the falls) (the reference's formula). */
export class RsiFn implements Stateful {
  private readonly change = new Change();
  private readonly up = rmaFn();
  private readonly down = rmaFn();

  call(value: number, length: number, final: boolean): number {
    const change = this.change.next(value, final);
    const up = this.up.call(Math.max(change, 0), length, final);
    const down = this.down.call(Math.max(-change, 0), length, final);
    return 100 - 100 / (1 + up / down);
  }

  save(): unknown {
    return [this.change.save(), this.up.save(), this.down.save()];
  }

  restore(state: unknown): void {
    const [change, up, down] = state as [unknown, unknown, unknown];
    this.change.restore(change);
    this.up.restore(up);
    this.down.restore(down);
  }
}

/** `ta.cci`: (source − its SMA) / (0.015 × its mean deviation). */
export class CciFn implements Stateful {
  private readonly sma = new DynamicSma();
  private readonly dev = new DevFn();

  call(value: number, length: number, final: boolean, index = -1): number {
    const mean = this.sma.call(value, length, final);
    const dev = this.dev.call(value, length, final, index);
    return (value - mean) / (0.015 * dev);
  }

  save(): unknown {
    return [this.sma.save(), this.dev.save()];
  }

  restore(state: unknown): void {
    const [sma, dev] = state as [unknown, unknown];
    this.sma.restore(sma);
    this.dev.restore(dev);
  }
}

/**
 * `ta.stoch`: 100 × (source − lowest low) / (highest high − lowest low). An na source, high or
 * low repeats the last value; on a flat range it repeats when the source is on it, else na
 * (TradingView's rules, measured by PineTS, third-party).
 */
export class StochFn implements Stateful {
  private readonly highest = new ExtremeFn(true, false);
  private readonly lowest = new ExtremeFn(false, false);
  private last = Number.NaN;

  call(
    value: number,
    high: number,
    low: number,
    length: number,
    final: boolean,
    index = -1,
  ): number {
    const hh = this.highest.call(high, length, final, index);
    const ll = this.lowest.call(low, length, final, index);
    let result: number;
    if (isNa(value) || isNa(high) || isNa(low)) result = this.last;
    else if (hh === ll) result = value === hh ? this.last : Number.NaN;
    else result = (100 * (value - ll)) / (hh - ll);
    if (final) this.last = result;
    return result;
  }

  save(): unknown {
    return [this.highest.save(), this.lowest.save(), this.last];
  }

  restore(state: unknown): void {
    const [h, l, last] = state as [unknown, unknown, number];
    this.highest.restore(h);
    this.lowest.restore(l);
    this.last = last;
  }
}

/** `ta.macd`: [fast EMA − slow EMA, its EMA, their difference]. */
export class MacdFn implements Stateful {
  private readonly fast = emaFn();
  private readonly slow = emaFn();
  private readonly signal = emaFn();

  call(value: number, fast: number, slow: number, signal: number, final: boolean): number[] {
    const macd = this.fast.call(value, fast, final) - this.slow.call(value, slow, final);
    const line = this.signal.call(macd, signal, final);
    return [macd, line, macd - line];
  }

  save(): unknown {
    return [this.fast.save(), this.slow.save(), this.signal.save()];
  }

  restore(state: unknown): void {
    const [f, s, g] = state as [unknown, unknown, unknown];
    this.fast.restore(f);
    this.slow.restore(s);
    this.signal.restore(g);
  }
}

/** `ta.bb`: [SMA, SMA + mult × stdev, SMA − mult × stdev]. */
export class BbFn implements Stateful {
  private readonly sma: { call(value: number, length: number, final: boolean): number } & Stateful;
  private readonly stdev: {
    call(value: number, length: number, biased: boolean, final: boolean): number;
  } & Stateful;

  /** `dynamic`: a length that may change from bar to bar. */
  constructor(dynamic = false) {
    this.sma = dynamic ? new DynamicSma() : smaFn();
    this.stdev = dynamic ? new WindowStdevFn(false) : new StdevFn(false);
  }

  call(value: number, length: number, mult: number, final: boolean): number[] {
    const basis = this.sma.call(value, length, final);
    const dev = mult * this.stdev.call(value, length, true, final);
    return [basis, basis + dev, basis - dev];
  }

  save(): unknown {
    return [this.sma.save(), this.stdev.save()];
  }

  restore(state: unknown): void {
    const [a, b] = state as [unknown, unknown];
    this.sma.restore(a);
    this.stdev.restore(b);
  }
}
