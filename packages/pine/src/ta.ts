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

  constructor(fn: string, make: (length: number) => Kernel) {
    this.fn = fn;
    this.make = make;
  }

  call(value: number, length: number, final: boolean): number {
    if (!this.kernel) this.kernel = this.make(checkLength(this.fn, length));
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
export const emaFn = () => new KernelFn('ta.ema', (n) => new Ema(n));
export const rmaFn = () => new KernelFn('ta.rma', (n) => new Rma(n));
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

/** A function of the current value and the ones committed before it (na included). */
abstract class Windowed implements Stateful {
  protected readonly values = new Hist();

  /** The value `k` bars back, 0 being the current one. */
  protected at(current: number, k: number): number {
    return k === 0 ? current : this.values.back(k);
  }

  /** How many bars there are, the current one included. */
  protected bars(): number {
    return this.values.length + 1;
  }

  protected commit(value: number, final: boolean): void {
    if (final) this.values.push(value);
  }

  save(): unknown {
    return this.values.save();
  }

  restore(state: unknown): void {
    this.values.restore(state as number);
  }
}

/** `ta.change`, `ta.mom` and `ta.roc`: against the value `length` bars back, na included. */
export class ChangeFn extends Windowed {
  private readonly kind: 'change' | 'mom' | 'roc';

  constructor(kind: 'change' | 'mom' | 'roc') {
    super();
    this.kind = kind;
  }

  call(value: number, length: number, final: boolean): number {
    const n = checkLength(`ta.${this.kind}`, length, this.kind === 'change' ? 0 : 1);
    const before = this.at(value, n);
    this.commit(value, final);
    if (this.kind === 'roc') return (100 * (value - before)) / before;
    return value - before;
  }
}

/** `ta.change` of a bool: whether it differs from the bar before. */
export class BoolChangeFn extends Windowed {
  call(value: boolean, final: boolean): boolean {
    const before = this.values.back(1);
    this.commit(value ? 1 : 0, final);
    return !isNa(before) && before !== (value ? 1 : 0);
  }
}

/** `ta.highest`, `ta.lowest` and their offsets: over the last `length` bars, na ignored. */
export class ExtremeFn extends Windowed {
  private readonly highest: boolean;
  private readonly offset: boolean;

  constructor(highest: boolean, offset: boolean) {
    super();
    this.highest = highest;
    this.offset = offset;
  }

  call(value: number, length: number, final: boolean): number {
    const fn = `ta.${this.highest ? 'highest' : 'lowest'}${this.offset ? 'bars' : ''}`;
    const n = checkLength(fn, length);
    let best = Number.NaN;
    let bestK = Number.NaN;
    if (this.bars() >= n) {
      for (let k = 0; k < n; k++) {
        const v = this.at(value, k);
        if (isNa(v)) continue;
        if (isNa(best) || (this.highest ? v > best : v < best)) {
          best = v;
          bestK = k;
        }
      }
    }
    this.commit(value, final);
    return this.offset ? 0 - bestK : best;
  }
}

/** `ta.rising` and `ta.falling`: above (below) each of the last `length` values not na. */
export class TrendFn extends Windowed {
  private readonly rising: boolean;

  constructor(rising: boolean) {
    super();
    this.rising = rising;
  }

  call(value: number, length: number, final: boolean): boolean {
    const n = checkLength(this.rising ? 'ta.rising' : 'ta.falling', length);
    let result = this.bars() > n && !isNa(value);
    for (let k = 1; result && k <= n; k++) {
      const v = this.values.back(k);
      if (isNa(v)) continue;
      result = this.rising ? value > v : value < v;
    }
    this.commit(value, final);
    return result;
  }
}

/** `ta.swma`: weights 1/6, 2/6, 2/6, 1/6 over the last four values, na included. */
export class SwmaFn extends Windowed {
  call(value: number, final: boolean): number {
    const result =
      (this.at(value, 3) * 1) / 6 +
      (this.at(value, 2) * 2) / 6 +
      (this.at(value, 1) * 2) / 6 +
      (value * 1) / 6;
    this.commit(value, final);
    return result;
  }
}

/** `ta.dev`: the mean absolute deviation from the SMA of the last `length` values. */
export class DevFn extends Windowed {
  call(value: number, length: number, final: boolean): number {
    const n = checkLength('ta.dev', length);
    let result = Number.NaN;
    if (this.bars() >= n) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += this.at(value, k);
      const mean = sum / n;
      let deviation = 0;
      for (let k = 0; k < n; k++) deviation += Math.abs(this.at(value, k) - mean);
      result = deviation / n;
    }
    this.commit(value, final);
    return result;
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
    const result = this.sum + (isNa(value) ? 0 : value);
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

/** `ta.crossover`, `ta.crossunder` and `ta.cross`: against the values one call before. */
export class CrossFn implements Stateful {
  private readonly a = new Hist();
  private readonly b = new Hist();
  private readonly kind: 'over' | 'under' | 'any';

  constructor(kind: 'over' | 'under' | 'any') {
    this.kind = kind;
  }

  call(a: number, b: number, final: boolean): boolean {
    const a1 = this.a.back(1);
    const b1 = this.b.back(1);
    const over = a > b && a1 <= b1;
    const under = a < b && a1 >= b1;
    if (final) {
      this.a.push(a);
      this.b.push(b);
    }
    return this.kind === 'over' ? over : this.kind === 'under' ? under : over || under;
  }

  save(): unknown {
    return [this.a.save(), this.b.save()];
  }

  restore(state: unknown): void {
    const [a, b] = state as [number, number];
    this.a.restore(a);
    this.b.restore(b);
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
 * `ta.pivothigh` and `ta.pivotlow`: the value `right` bars back when it's above (below) each of
 * the `left` values before it and the `right` values after it; na otherwise. Ties count as no
 * pivot (not in the reference: provisional).
 */
export class PivotFn extends Windowed {
  private readonly high: boolean;

  constructor(high: boolean) {
    super();
    this.high = high;
  }

  call(value: number, left: number, right: number, final: boolean): number {
    const l = checkLength(this.high ? 'ta.pivothigh' : 'ta.pivotlow', left, 0);
    const r = checkLength(this.high ? 'ta.pivothigh' : 'ta.pivotlow', right, 0);
    let result = Number.NaN;
    if (this.bars() > l + r) {
      const center = this.at(value, r);
      let pivot = !isNa(center);
      for (let k = 0; pivot && k <= l + r; k++) {
        if (k === r) continue;
        const v = this.at(value, k);
        pivot = !isNa(v) && (this.high ? center > v : center < v);
      }
      if (pivot) result = center;
    }
    this.commit(value, final);
    return result;
  }
}

/** `ta.tr` and `ta.tr(handle_na)`: the true range against the close before. */
export class TrFn implements Stateful {
  private readonly closes = new Hist();

  call(high: number, low: number, close: number, handleNa: boolean, final: boolean): number {
    const previous = this.closes.back(1);
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

  call(high: number, low: number, close: number, length: number, final: boolean): number {
    return this.rma.call(this.tr.call(high, low, close, true, final), length, final);
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

  call(value: number, length: number, final: boolean): number {
    const mean = this.sma.call(value, length, final);
    const dev = this.dev.call(value, length, final);
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

/** `ta.stoch`: 100 × (source − lowest low) / (highest high − lowest low). */
export class StochFn implements Stateful {
  private readonly highest = new ExtremeFn(true, false);
  private readonly lowest = new ExtremeFn(false, false);

  call(value: number, high: number, low: number, length: number, final: boolean): number {
    const hh = this.highest.call(high, length, final);
    const ll = this.lowest.call(low, length, final);
    return (100 * (value - ll)) / (hh - ll);
  }

  save(): unknown {
    return [this.highest.save(), this.lowest.save()];
  }

  restore(state: unknown): void {
    const [h, l] = state as [unknown, unknown];
    this.highest.restore(h);
    this.lowest.restore(l);
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
  private readonly sma = smaFn();
  private readonly stdev = new StdevFn(false);

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
