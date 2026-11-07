import { checkLength, ExtremeFn, Hist, type Stateful, SumFn, Windowed } from './ta.ts';

/**
 * Pine's statistics over a window of bars (the v6 reference's ta.* functions). Each call keeps
 * its own history, as Pine's do: a call inside an `if` or a ternary sees only the bars it ran on
 * (matched on TradingView's values, PineTS's BINANCE:BTCUSDT 1h data; docs/SPEC.md §4.17). A
 * `final` call commits; any other leaves the committed state as it was (ta.ts).
 */

const isNa = Number.isNaN;

/** A window by bar (ta.ts: Windowed), with the last `n` values read at once. */
abstract class Window extends Windowed {
  /** How many bars there have been, the current one included. */
  protected calls(): number {
    return this.bars();
  }

  /** The last `n` values, the current first; null with fewer bars or an na among them. */
  protected full(current: number, n: number): number[] | null {
    if (this.bars() < n) return null;
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = this.at(current, k);
      if (isNa(v)) return null;
      out.push(v);
    }
    return out;
  }
}

/**
 * `length + 1` slots by bar index, written by the calls; a bar the call skipped reads what its
 * slot last held. TradingView's ta.linreg and ta.rci with a length that can't change read their
 * windows this way inside an `if` (measured by PineTS, third-party); at the top level it's the
 * last `length` values.
 */
class Slots implements Stateful {
  private slots: Float64Array = new Float64Array(0);
  private written = 0;

  /** The last `n` values for bar `index`, the current first; null with an na among them. */
  window(current: number, n: number, index: number): number[] | null {
    if (this.slots.length !== n + 1) {
      this.slots = new Float64Array(n + 1).fill(Number.NaN);
      this.written = 0;
    }
    if (this.written + 1 < n) return null;
    const out: number[] = [current];
    for (let k = 1; k < n; k++) {
      const v = this.slots[(((index - k) % (n + 1)) + n + 1) % (n + 1)] as number;
      if (isNa(v)) return null;
      out.push(v);
    }
    return isNa(current) ? null : out;
  }

  write(value: number, n: number, index: number, final: boolean): void {
    if (!final || this.slots.length !== n + 1) return;
    this.slots[index % (n + 1)] = value;
    this.written++;
  }

  save(): unknown {
    return [this.slots.slice(), this.written];
  }

  restore(state: unknown): void {
    const [slots, written] = state as [Float64Array, number];
    this.slots = slots.slice();
    this.written = written;
  }
}

/** The last `n` values that aren't na (the current first when it isn't), or null if fewer. */
abstract class NonNaWindow implements Stateful {
  protected readonly values = new Hist();

  protected last(current: number, n: number): number[] | null {
    const out: number[] = [];
    if (!isNa(current)) out.push(current);
    for (let k = 1; out.length < n && k <= this.values.length; k++) out.push(this.values.back(k));
    return out.length < n ? null : out;
  }

  protected commit(value: number, final: boolean): void {
    if (final && !isNa(value)) this.values.push(value);
  }

  save(): unknown {
    return this.values.save();
  }

  restore(state: unknown): void {
    this.values.restore(state as number);
  }
}

const ascending = (a: number, b: number) => a - b;

/** `ta.median`: of the last `length` values not na; with an even count, the middle two's mean. */
export class MedianFn extends NonNaWindow {
  call(value: number, length: number, final: boolean): number {
    const window = this.last(value, checkLength('ta.median', length));
    this.commit(value, final);
    if (!window) return Number.NaN;
    window.sort(ascending);
    const mid = window.length >> 1;
    return window.length % 2 === 1
      ? (window[mid] as number)
      : ((window[mid - 1] as number) + (window[mid] as number)) / 2;
  }
}

/** `ta.mode`: the commonest of the last `length` values not na; of equals, the smallest. */
export class ModeFn extends NonNaWindow {
  call(value: number, length: number, final: boolean): number {
    const window = this.last(value, checkLength('ta.mode', length));
    this.commit(value, final);
    if (!window) return Number.NaN;
    const counts = new Map<number, number>();
    for (const v of window) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = Number.NaN;
    let bestCount = 0;
    for (const [v, count] of counts) {
      if (count > bestCount || (count === bestCount && v < best)) {
        best = v;
        bestCount = count;
      }
    }
    return best;
  }
}

/**
 * `ta.percentile_linear_interpolation`: between the two nearest ranks, the position being
 * `percentage / 100 × length − 0.5` from the smallest. The reference names only "linear
 * interpolation"; this position matched TradingView's values on all 120 bars of PineTS's data,
 * where the usual (n − 1)·p and (n + 1)·p − 1 missed 32 to 40 (checked 2026-11-01).
 */
export class PercentileLinearFn extends Window {
  /** In a loop, every run's value goes in (runtime.ts: register). */
  readonly everyCall = true;

  call(value: number, length: number, percentage: number, final: boolean): number {
    const n = checkLength('ta.percentile_linear_interpolation', length);
    // Over the calls (no bar given): TradingView keeps an array of the calls' values.
    const window = this.full(value, n);
    this.commit(value, final);
    if (!window) return Number.NaN;
    window.sort(ascending);
    const position = Math.min(n - 1, Math.max(0, (percentage / 100) * n - 0.5));
    const low = Math.floor(position);
    const high = Math.ceil(position);
    const a = window[low] as number;
    return a + ((window[high] as number) - a) * (position - low);
  }
}

/** `ta.percentile_nearest_rank`: the smallest value with at least `percentage`% at or below it. */
export class PercentileNearestFn extends NonNaWindow {
  /** In a loop, every run's value goes in (runtime.ts: register). */
  readonly everyCall = true;

  call(value: number, length: number, percentage: number, final: boolean): number {
    const n = checkLength('ta.percentile_nearest_rank', length);
    const window = this.last(value, n);
    this.commit(value, final);
    if (!window) return Number.NaN;
    window.sort(ascending);
    const rank = Math.ceil((percentage / 100) * n);
    return window[Math.min(n - 1, Math.max(0, rank - 1))] as number;
  }
}

/**
 * `ta.percentrank`: the share of the previous `length` values at or below the current one, in
 * percent; 0 on an na bar (measured on TradingView by PineTS, third-party).
 */
export class PercentrankFn extends Window {
  call(value: number, length: number, final: boolean, index = -1): number {
    const n = checkLength('ta.percentrank', length);
    this.sync(index);
    let result = Number.NaN;
    if (isNa(value)) result = 0;
    else if (this.calls() > n) {
      let count = 0;
      for (let k = 1; k <= n; k++) if (this.values.back(k) <= value) count++;
      result = (100 * count) / n;
    }
    this.commit(value, final, index);
    return result;
  }
}

/** `ta.range`: the highest minus the lowest of the last `length` values, na ignored. */
export class RangeFn implements Stateful {
  private readonly highest = new ExtremeFn(true, false);
  private readonly lowest = new ExtremeFn(false, false);

  call(value: number, length: number, final: boolean): number {
    const n = checkLength('ta.range', length);
    return this.highest.call(value, n, final) - this.lowest.call(value, n, final);
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

/** Ranks from 1, equal values sharing the mean of their ranks. */
function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (
      j + 1 < order.length &&
      (order[j + 1] as readonly [number, number])[0] === (order[i] as readonly [number, number])[0]
    )
      j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[(order[k] as readonly [number, number])[1]] = rank;
    i = j + 1;
  }
  return out;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

/**
 * `ta.rci`: Spearman's correlation of the last `length` values with their bar order, × 100: 100
 * when they rose bar after bar (the v6 reference). Its first value comes on bar `length`
 * (measured on TradingView by PineTS, third-party).
 */
export class RciFn extends Window {
  private readonly slots = new Slots();
  private readonly fixed: boolean;

  constructor(fixed = false) {
    super();
    this.fixed = fixed;
  }

  call(value: number, length: number, final: boolean, index = -1): number {
    const n = checkLength('ta.rci', length);
    this.sync(index);
    let result = Number.NaN;
    if (this.calls() > n) {
      const window =
        this.fixed && index >= 0 ? this.slots.window(value, n, index) : this.full(value, n);
      if (window) {
        // Oldest first, against the bars' order 1 … n.
        window.reverse();
        result =
          100 *
          pearson(
            ranks(window),
            window.map((_, i) => i + 1),
          );
      }
    }
    if (this.fixed && index >= 0) this.slots.write(value, n, index, final);
    this.commit(value, final, index);
    return result;
  }

  override save(): unknown {
    return [super.save(), this.slots.save()];
  }

  override restore(state: unknown): void {
    const [own, slots] = state as [unknown, unknown];
    super.restore(own);
    this.slots.restore(slots);
  }
}

/**
 * `ta.correlation`: Pearson's correlation of two series over `length` bars, each average over
 * its own values that aren't na (so it can leave −1 … 1 when one has an na, as TradingView's
 * does: measured by PineTS, third-party).
 */
export class CorrelationFn implements Stateful {
  private readonly x = new Hist();
  private readonly y = new Hist();
  private readonly xy = new Hist();
  private readonly xx = new Hist();
  private readonly yy = new Hist();

  private static mean(values: Hist, current: number, n: number): number {
    let sum = 0;
    let count = 0;
    if (!isNa(current)) {
      sum += current;
      count++;
    }
    for (let k = 1; count < n && k <= values.length; k++) {
      sum += values.back(k);
      count++;
    }
    return count < n ? Number.NaN : sum / n;
  }

  call(x: number, y: number, length: number, final: boolean): number {
    const n = checkLength('ta.correlation', length);
    const mx = CorrelationFn.mean(this.x, x, n);
    const my = CorrelationFn.mean(this.y, y, n);
    const mxy = CorrelationFn.mean(this.xy, x * y, n);
    const mxx = CorrelationFn.mean(this.xx, x * x, n);
    const myy = CorrelationFn.mean(this.yy, y * y, n);
    if (final) {
      for (const [hist, v] of [
        [this.x, x],
        [this.y, y],
        [this.xy, x * y],
        [this.xx, x * x],
        [this.yy, y * y],
      ] as const) {
        if (!isNa(v)) hist.push(v);
      }
    }
    const vx = mxx - mx * mx;
    const vy = myy - my * my;
    return (mxy - mx * my) / Math.sqrt(vx * vy);
  }

  save(): unknown {
    return [this.x, this.y, this.xy, this.xx, this.yy].map((hist) => hist.save());
  }

  restore(state: unknown): void {
    const lengths = state as number[];
    [this.x, this.y, this.xy, this.xx, this.yy].forEach((hist, i) => {
      hist.restore(lengths[i] as number);
    });
  }
}

/**
 * `ta.linreg`: the least-squares line through the last `length` values, read `offset` bars
 * before the newest (the reference: intercept + slope × (length − 1 − offset)); na in the window
 * gives na.
 */
export class LinregFn extends Window {
  private readonly slots = new Slots();
  private readonly fixed: boolean;

  constructor(fixed = false) {
    super();
    this.fixed = fixed;
  }

  override save(): unknown {
    return [super.save(), this.slots.save()];
  }

  override restore(state: unknown): void {
    const [own, slots] = state as [unknown, unknown];
    super.restore(own);
    this.slots.restore(slots);
  }

  call(value: number, length: number, offset: number, final: boolean, index = -1): number {
    const n = checkLength('ta.linreg', length);
    this.sync(index);
    const useSlots = this.fixed && index >= 0;
    const window = useSlots ? this.slots.window(value, n, index) : this.full(value, n);
    if (useSlots) this.slots.write(value, n, index, final);
    this.commit(value, final, index);
    if (!window) return Number.NaN;
    // x runs 0 (oldest) … n − 1 (newest).
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < n; k++) {
      const x = n - 1 - k;
      const y = window[k] as number;
      sx += x;
      sy += y;
      sxy += x * y;
      sxx += x * x;
    }
    const slope = n === 1 ? 0 : (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    return intercept + slope * (n - 1 - offset);
  }
}

/**
 * `ta.alma`: Gaussian weights centred at `offset × (length − 1)` (floored when asked), width
 * `length / sigma` (the reference's "same on Pine"); na in the window gives na.
 */
export class AlmaFn extends Window {
  private weights: Float64Array | null = null;
  private key = '';

  call(
    value: number,
    length: number,
    offset: number,
    sigma: number,
    floor: boolean,
    final: boolean,
    index = -1,
  ): number {
    const n = checkLength('ta.alma', length);
    this.sync(index);
    const window = this.full(value, n);
    this.commit(value, final, index);
    if (!window) return Number.NaN;
    const key = `${n}|${offset}|${sigma}|${floor}`;
    if (key !== this.key || !this.weights) {
      const m = floor ? Math.floor(offset * (n - 1)) : offset * (n - 1);
      const s = n / sigma;
      this.weights = new Float64Array(n);
      for (let i = 0; i < n; i++) this.weights[i] = Math.exp(-((i - m) ** 2) / (2 * s * s));
      this.key = key;
    }
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < n; i++) {
      const weight = this.weights[i] as number;
      norm += weight;
      // Weight i applies to the value n − 1 − i bars back: the oldest gets the first.
      sum += (window[n - 1 - i] as number) * weight;
    }
    return sum / norm;
  }
}

/** `ta.cog`: −Σ source[i] × (i + 1) / Σ source over `length` bars (the reference's formula). */
export class CogFn extends Window {
  private readonly sum = new SumFn();

  /** The sum over the calls, the weighted sum over the bars (measured by PineTS, third-party). */
  call(value: number, length: number, final: boolean, index = -1): number {
    const n = checkLength('ta.cog', length);
    this.sync(index);
    const total = this.sum.call(value, n, final);
    let num = 0;
    for (let i = 0; i < n; i++) num += this.at(value, i) * (i + 1);
    this.commit(value, final, index);
    return -num / total;
  }

  override save(): unknown {
    return [super.save(), this.sum.save()];
  }

  override restore(state: unknown): void {
    const [own, sum] = state as [unknown, unknown];
    super.restore(own);
    this.sum.restore(sum);
  }
}

/** `ta.max` and `ta.min`: the highest (lowest) value so far, na ignored. */
export class AllTimeFn implements Stateful {
  private readonly highest: boolean;
  private best = Number.NaN;

  constructor(highest: boolean) {
    this.highest = highest;
  }

  call(value: number, final: boolean): number {
    let best = this.best;
    if (!isNa(value) && (isNa(best) || (this.highest ? value > best : value < best))) best = value;
    if (final) this.best = best;
    return best;
  }

  save(): unknown {
    return this.best;
  }

  restore(state: unknown): void {
    this.best = state as number;
  }
}
