import type { Bar } from '@tradingnerd/core';
import { PineRuntimeError } from './diagnostics.ts';
import {
  AtrFn,
  ChangeFn,
  checkLength,
  DynamicSma,
  ExtremeFn,
  emaFn,
  FixnanFn,
  Hist,
  rmaFn,
  type Stateful,
  SumFn,
  TrFn,
  WindowStdevFn,
  WmaFn,
} from './ta.ts';

/**
 * Pine's trend, band and volume functions (the v6 reference's ta.*), each following the
 * reference's "the same on Pine" code where it gives one, else TradingView's built-in indicator
 * of the same name. A `final` call commits; any other leaves the committed state (ta.ts).
 */

const isNa = Number.isNaN;

/** Saves and restores a list of parts together. */
abstract class Composite implements Stateful {
  protected abstract parts(): Stateful[];

  save(): unknown {
    return this.parts().map((part) => part.save());
  }

  restore(state: unknown): void {
    const states = state as unknown[];
    this.parts().forEach((part, i) => {
      part.restore(states[i]);
    });
  }
}

/** A number kept from the last commit (the bar before's value of an expression). */
class Previous implements Stateful {
  value = Number.NaN;

  next(value: number, final: boolean): number {
    const before = this.value;
    if (final) this.value = value;
    return before;
  }

  save(): unknown {
    return this.value;
  }

  restore(state: unknown): void {
    this.value = state as number;
  }
}

/**
 * `ta.dmi(diLength, adxSmoothing)`: [+DI, −DI, ADX], as TradingView's Directional Movement
 * Index computes them: directional moves smoothed by RMA over the RMA of the true range.
 */
export class DmiFn extends Composite {
  private readonly up = new ChangeFn('change');
  private readonly down = new ChangeFn('change');
  private readonly tr = new TrFn();
  private readonly trur = rmaFn();
  private readonly plusRma = rmaFn();
  private readonly minusRma = rmaFn();
  private readonly plusFix = new FixnanFn();
  private readonly minusFix = new FixnanFn();
  private readonly adxRma = rmaFn();

  protected parts(): Stateful[] {
    return [
      this.up,
      this.down,
      this.tr,
      this.trur,
      this.plusRma,
      this.minusRma,
      this.plusFix,
      this.minusFix,
      this.adxRma,
    ];
  }

  call(bar: Bar, diLength: number, adxLength: number, final: boolean): number[] {
    const up = this.up.call(bar.high, 1, final);
    const down = -this.down.call(bar.low, 1, final);
    const plusDM = isNa(up) ? Number.NaN : up > down && up > 0 ? up : 0;
    const minusDM = isNa(down) ? Number.NaN : down > up && down > 0 ? down : 0;
    const trur = this.trur.call(
      this.tr.call(bar.high, bar.low, bar.close, false, final),
      diLength,
      final,
    );
    const plus = this.plusFix.call(
      (100 * this.plusRma.call(plusDM, diLength, final)) / trur,
      final,
    );
    const minus = this.minusFix.call(
      (100 * this.minusRma.call(minusDM, diLength, final)) / trur,
      final,
    );
    const sum = plus + minus;
    const adx =
      100 * this.adxRma.call(Math.abs(plus - minus) / (sum === 0 ? 1 : sum), adxLength, final);
    return [plus, minus, adx];
  }
}

/** `ta.sar(start, inc, max)`: the reference's Parabolic SAR, step by step. */
export class SarFn implements Stateful {
  private result = Number.NaN;
  private maxMin = Number.NaN;
  private acceleration = Number.NaN;
  private below = false;
  private calls = 0;
  private readonly bars: Bar[] = [];

  call(bar: Bar, start: number, inc: number, max: number, final: boolean): number {
    const index = this.calls;
    const prev1 = this.bars[this.bars.length - 1];
    const prev2 = this.bars[this.bars.length - 2];
    let result = this.result;
    let maxMin = this.maxMin;
    let acceleration = this.acceleration;
    let below = this.below;
    let firstTrendBar = false;
    if (index === 1 && prev1) {
      if (bar.close > prev1.close) {
        below = true;
        maxMin = bar.high;
        result = prev1.low;
      } else {
        below = false;
        maxMin = bar.low;
        result = prev1.high;
      }
      firstTrendBar = true;
      acceleration = start;
    }
    result = result + acceleration * (maxMin - result);
    if (below) {
      if (result > bar.low) {
        firstTrendBar = true;
        below = false;
        result = Math.max(bar.high, maxMin);
        maxMin = bar.low;
        acceleration = start;
      }
    } else if (result < bar.high) {
      firstTrendBar = true;
      below = true;
      result = Math.min(bar.low, maxMin);
      maxMin = bar.high;
      acceleration = start;
    }
    if (!firstTrendBar) {
      if (below) {
        if (bar.high > maxMin) {
          maxMin = bar.high;
          acceleration = Math.min(acceleration + inc, max);
        }
      } else if (bar.low < maxMin) {
        maxMin = bar.low;
        acceleration = Math.min(acceleration + inc, max);
      }
    }
    if (below) {
      if (prev1) result = Math.min(result, prev1.low);
      if (index > 1 && prev2) result = Math.min(result, prev2.low);
    } else {
      if (prev1) result = Math.max(result, prev1.high);
      if (index > 1 && prev2) result = Math.max(result, prev2.high);
    }
    if (final) {
      this.result = result;
      this.maxMin = maxMin;
      this.acceleration = acceleration;
      this.below = below;
      this.calls++;
      this.bars.push(bar);
      if (this.bars.length > 2) this.bars.shift();
    }
    return result;
  }

  save(): unknown {
    return [this.result, this.maxMin, this.acceleration, this.below, this.calls, [...this.bars]];
  }

  restore(state: unknown): void {
    const [result, maxMin, acceleration, below, calls, bars] = state as [
      number,
      number,
      number,
      boolean,
      number,
      Bar[],
    ];
    this.result = result;
    this.maxMin = maxMin;
    this.acceleration = acceleration;
    this.below = below;
    this.calls = calls;
    this.bars.length = 0;
    this.bars.push(...bars);
  }
}

/**
 * `ta.supertrend(factor, atrPeriod)`: [line, direction], −1 for up and 1 for down (the
 * reference's "same on Pine").
 */
export class SupertrendFn extends Composite {
  private readonly atr = new AtrFn();
  private readonly lowerBand = new Previous();
  private readonly upperBand = new Previous();
  private readonly line = new Previous();
  private readonly atrBefore = new Previous();

  protected parts(): Stateful[] {
    return [this.atr, this.lowerBand, this.upperBand, this.line, this.atrBefore];
  }

  /** `before`: the previous bar's close, which ta.atr and `close[1]` read (the bars, not calls). */
  call(bar: Bar, before: number, factor: number, period: number, final: boolean): number[] {
    const src = (bar.high + bar.low) / 2;
    const n = checkLength('ta.supertrend', period);
    const atr = this.atr.call(bar.high, bar.low, bar.close, n, final, before);
    let upper = src + factor * atr;
    let lower = src - factor * atr;
    const prevLower = nz(this.lowerBand.value);
    const prevUpper = nz(this.upperBand.value);
    const close1 = before;
    lower = lower > prevLower || close1 < prevLower ? lower : prevLower;
    upper = upper < prevUpper || close1 > prevUpper ? upper : prevUpper;
    const prevLine = this.line.value;
    let direction: number;
    if (isNa(this.atrBefore.value)) direction = 1;
    else if (prevLine === prevUpper) direction = bar.close > upper ? -1 : 1;
    else direction = bar.close < lower ? 1 : -1;
    const line = direction === -1 ? lower : upper;
    this.lowerBand.next(lower, final);
    this.upperBand.next(upper, final);
    this.line.next(line, final);
    this.atrBefore.next(atr, final);
    return [line, direction];
  }
}

const nz = (value: number) => (isNa(value) ? 0 : value);

/**
 * `ta.kc(series, length, mult, useTrueRange)`: [EMA, EMA + mult × EMA of the range, EMA − …],
 * the range being the true range (default) or high − low (the reference's "same on Pine").
 */
export class KcFn extends Composite {
  private readonly basis = emaFn();
  private readonly range = emaFn();
  private readonly tr = new TrFn();

  protected parts(): Stateful[] {
    return [this.basis, this.range, this.tr];
  }

  /** `before`: the previous bar's close, which `ta.tr` reads (the reference's code uses it). */
  call(
    value: number,
    bar: Bar,
    before: number,
    length: number,
    mult: number,
    trueRange: boolean,
    final: boolean,
  ): number[] {
    const basis = this.basis.call(value, length, final);
    const tr = this.tr.call(bar.high, bar.low, bar.close, false, final, before);
    const span = trueRange ? tr : bar.high - bar.low;
    const range = this.range.call(span, length, final);
    return [basis, basis + range * mult, basis - range * mult];
  }
}

/** `ta.bbw`: the Bollinger Bands' width over their middle, in percent. */
export class BbwFn extends Composite {
  private readonly sma = new DynamicSma();
  private readonly stdev = new WindowStdevFn(false);

  protected parts(): Stateful[] {
    return [this.sma, this.stdev];
  }

  call(value: number, length: number, mult: number, final: boolean): number {
    const basis = this.sma.call(value, length, final);
    const dev = mult * this.stdev.call(value, length, true, final);
    return ((basis + dev - (basis - dev)) / basis) * 100;
  }
}

/** `ta.cmo`: 100 × (gains − losses) / (gains + losses) over `length` (the reference's code). */
export class CmoFn extends Composite {
  private readonly change = new ChangeFn('change');
  private readonly gains = new SumFn();
  private readonly losses = new SumFn();

  protected parts(): Stateful[] {
    return [this.change, this.gains, this.losses];
  }

  call(value: number, length: number, final: boolean): number {
    const n = checkLength('ta.cmo', length);
    const mom = this.change.call(value, 1, final);
    // As written: an na change is false for `mom >= 0`, so it adds 0 to the gains, na to losses.
    const sm1 = this.gains.call(mom >= 0 ? mom : 0, n, final);
    const sm2 = this.losses.call(mom >= 0 ? 0 : -mom, n, final);
    return (100 * (sm1 - sm2)) / (sm1 + sm2);
  }
}

/** `ta.mfi(series, length)`: the reference's Money Flow Index, with the bar's volume. */
export class MfiFn extends Composite {
  private readonly change = new ChangeFn('change');
  private readonly upper = new SumFn();
  private readonly lower = new SumFn();

  protected parts(): Stateful[] {
    return [this.change, this.upper, this.lower];
  }

  call(value: number, volume: number, length: number, final: boolean): number {
    const n = checkLength('ta.mfi', length);
    const change = this.change.call(value, 1, final);
    const upper = this.upper.call(volume * (change <= 0 ? 0 : value), n, final);
    const lower = this.lower.call(volume * (change >= 0 ? 0 : value), n, final);
    return 100 - 100 / (1 + upper / lower);
  }
}

/**
 * `ta.tsi(source, short, long)`: the double-smoothed price change over the double-smoothed
 * absolute change, −1 … 1 (EMA over `long`, then over `short`).
 */
export class TsiFn extends Composite {
  private readonly change = new ChangeFn('change');
  private readonly first = emaFn();
  private readonly second = emaFn();
  private readonly firstAbs = emaFn();
  private readonly secondAbs = emaFn();

  protected parts(): Stateful[] {
    return [this.change, this.first, this.second, this.firstAbs, this.secondAbs];
  }

  call(value: number, short: number, long: number, final: boolean): number {
    const pc = this.change.call(value, 1, final);
    const smooth = this.second.call(this.first.call(pc, long, final), short, final);
    const smoothAbs = this.secondAbs.call(
      this.firstAbs.call(Math.abs(pc), long, final),
      short,
      final,
    );
    return smooth / smoothAbs;
  }
}

/** `ta.hma`: WMA(2 × WMA(src, ⌊n/2⌋) − WMA(src, n), ⌊√n⌋), the Hull Moving Average. */
export class HmaFn extends Composite {
  private readonly half = new WmaFn();
  private readonly full = new WmaFn();
  private readonly outer = new WmaFn();

  protected parts(): Stateful[] {
    return [this.half, this.full, this.outer];
  }

  call(value: number, length: number, final: boolean, index = -1): number {
    const n = checkLength('ta.hma', length);
    const half = this.half.call(value, Math.max(1, Math.floor(n / 2)), final, index);
    const full = this.full.call(value, n, final, index);
    return this.outer.call(2 * half - full, Math.max(1, Math.floor(Math.sqrt(n))), final, index);
  }
}

/** `ta.wpr(length)`: Williams %R, 100 × (close − highest high) / (highest high − lowest low). */
export class WprFn extends Composite {
  private readonly highest = new ExtremeFn(true, false);
  private readonly lowest = new ExtremeFn(false, false);

  protected parts(): Stateful[] {
    return [this.highest, this.lowest];
  }

  call(bar: Bar, length: number, final: boolean): number {
    const n = checkLength('ta.wpr', length);
    const hh = this.highest.call(bar.high, n, final);
    const ll = this.lowest.call(bar.low, n, final);
    return (100 * (bar.close - hh)) / (hh - ll);
  }
}

/**
 * `ta.vwap(source, anchor, stdev_mult)`: the volume-weighted average since the anchor last
 * held, with bands at ± stdev_mult × the volume-weighted standard deviation; na until the first
 * anchor (the v6 reference). Without an anchor it starts afresh with each session: the first
 * call of a new session, inside an `if` too. An na source makes it na until the next anchor.
 * Both rules matched TradingView's values (PineTS's data, 2026-11-01).
 */
export class VwapFn implements Stateful {
  private sumV = Number.NaN;
  private sumPV = 0;
  private sumP2V = 0;
  private session = Number.NaN;

  /** `anchor`: a bool, or the session the bar belongs to (a new one anchors). */
  call(
    value: number,
    volume: number,
    anchor: boolean | number,
    mult: number,
    final: boolean,
  ): number[] {
    let sumV = this.sumV;
    let sumPV = this.sumPV;
    let sumP2V = this.sumP2V;
    const reset = typeof anchor === 'number' ? anchor !== this.session : anchor;
    if (reset) {
      sumV = 0;
      sumPV = 0;
      sumP2V = 0;
    }
    if (isNa(value) || isNa(volume)) sumV = Number.NaN;
    else if (!isNa(sumV)) {
      sumV += volume;
      sumPV += value * volume;
      sumP2V += value * value * volume;
    }
    if (final) {
      this.sumV = sumV;
      this.sumPV = sumPV;
      this.sumP2V = sumP2V;
      if (typeof anchor === 'number') this.session = anchor;
    }
    const vwap = sumPV / sumV;
    const dev = Math.sqrt(Math.max(0, sumP2V / sumV - vwap * vwap));
    return [vwap, vwap + mult * dev, vwap - mult * dev];
  }

  save(): unknown {
    return [this.sumV, this.sumPV, this.sumP2V, this.session];
  }

  restore(state: unknown): void {
    [this.sumV, this.sumPV, this.sumP2V, this.session] = state as [number, number, number, number];
  }
}

const PIVOT_TYPES = ['Traditional', 'Fibonacci', 'Woodie', 'Classic', 'DM', 'Camarilla'] as const;

/**
 * [P, R1, S1, R2, S2, R3, S3, R4, S4, R5, S5] of a period's high, low, close and open, and the
 * next period's open for Woodie (TradingView's Help Center, "Pivot Points Standard"); na for
 * the levels a type doesn't have.
 */
function pivotLevels(
  type: string,
  h: number,
  l: number,
  c: number,
  o: number,
  next: number,
): number[] {
  const na = Number.NaN;
  const r = h - l;
  switch (type) {
    case 'Traditional': {
      const p = (h + l + c) / 3;
      return [
        p,
        p * 2 - l,
        p * 2 - h,
        p + r,
        p - r,
        p * 2 + (h - 2 * l),
        p * 2 - (2 * h - l),
        p * 3 + (h - 3 * l),
        p * 3 - (3 * h - l),
        p * 4 + (h - 4 * l),
        p * 4 - (4 * h - l),
      ];
    }
    case 'Fibonacci': {
      const p = (h + l + c) / 3;
      return [
        p,
        p + 0.382 * r,
        p - 0.382 * r,
        p + 0.618 * r,
        p - 0.618 * r,
        p + r,
        p - r,
        na,
        na,
        na,
        na,
      ];
    }
    case 'Woodie': {
      const p = (h + l + 2 * next) / 4;
      const r3 = h + 2 * (p - l);
      const s3 = l - 2 * (h - p);
      return [p, 2 * p - l, 2 * p - h, p + r, p - r, r3, s3, r3 + r, s3 - r, na, na];
    }
    case 'Classic': {
      const p = (h + l + c) / 3;
      return [
        p,
        2 * p - l,
        2 * p - h,
        p + r,
        p - r,
        p + 2 * r,
        p - 2 * r,
        p + 3 * r,
        p - 3 * r,
        na,
        na,
      ];
    }
    case 'DM': {
      const x = c < o ? h + 2 * l + c : c > o ? 2 * h + l + c : h + l + 2 * c;
      return [x / 4, x / 2 - l, x / 2 - h, na, na, na, na, na, na, na, na];
    }
    default: {
      // Camarilla.
      const p = (h + l + c) / 3;
      const k = 1.1 * r;
      const r4 = c + k / 2;
      const s4 = c - k / 2;
      const r3 = c + k / 4;
      const s3 = c - k / 4;
      return [
        p,
        c + k / 12,
        c - k / 12,
        c + k / 6,
        c - k / 6,
        r3,
        s3,
        r4,
        s4,
        r4 + 1.168 * (r4 - r3),
        s4 - 1.168 * (s3 - s4),
      ];
    }
  }
}

/**
 * `ta.pivot_point_levels(type, anchor, developing)`: at each anchor, the levels of the period
 * that just ended, kept until the next; with `developing`, the current period's, bar by bar.
 * Provisional: checked on Traditional's P and R1 only (docs/SPEC.md §11).
 */
export class PivotLevelsFn implements Stateful {
  private period: [number, number, number, number] | null = null;
  private levels: number[] = new Array(11).fill(Number.NaN);

  call(bar: Bar, type: string, anchor: boolean, developing: boolean, final: boolean): number[] {
    if (!(PIVOT_TYPES as readonly string[]).includes(type)) {
      throw new PineRuntimeError(
        `Invalid pivot type "${type}": it must be one of ${PIVOT_TYPES.join(', ')}`,
      );
    }
    if (developing && type === 'Woodie') {
      throw new PineRuntimeError('The Woodie pivot type cannot be developing');
    }
    let period = this.period;
    let levels = this.levels;
    if (anchor) {
      if (period && !developing) {
        const [o, h, l, c] = period;
        levels = pivotLevels(type, h, l, c, o, bar.open);
      }
      period = [bar.open, bar.high, bar.low, bar.close];
    } else if (period) {
      period = [period[0], Math.max(period[1], bar.high), Math.min(period[2], bar.low), bar.close];
    }
    if (developing && period) {
      const [o, h, l, c] = period;
      levels = pivotLevels(type, h, l, c, o, o);
    }
    if (final) {
      this.period = period;
      this.levels = levels;
    }
    return levels;
  }

  save(): unknown {
    return [this.period, this.levels];
  }

  restore(state: unknown): void {
    [this.period, this.levels] = state as [PivotLevelsFn['period'], number[]];
  }
}

// ---- the volume variables: ta.obv, ta.nvi … ----

/** What one of the volume variables computes on a bar, from the bar before's and its state. */
interface BarStep {
  /** The value on `bar`, given the bar before (undefined on the first) and the state before. */
  next(
    bar: Bar,
    before: Bar | undefined,
    state: number,
    hasVolume: boolean,
  ): [value: number, state: number];
}

const vol = (bar: Bar, hasVolume: boolean) => (hasVolume ? bar.volume : Number.NaN);

/** Cumulative: na on an na bar, and summing on. */
const cumulative = (
  term: (bar: Bar, before: Bar | undefined, hasVolume: boolean) => number,
): BarStep => ({
  next(bar, before, state, hasVolume) {
    const t = term(bar, before, hasVolume);
    if (isNa(t)) return [Number.NaN, state];
    const sum = (isNa(state) ? 0 : state) + t;
    return [sum, sum];
  },
});

const sign = (x: number) => (isNa(x) ? Number.NaN : Math.sign(x));

/** The volume index rules of the reference's "same on Pine" (nvi, pvi). */
const volumeIndex = (negative: boolean): BarStep => ({
  next(bar, before, state, hasVolume) {
    const prev = isNa(state) || state === 0 ? 1 : state;
    let value: number;
    if (!before || nz(bar.close) === 0 || nz(before.close) === 0) value = prev;
    else {
      const v = vol(bar, hasVolume);
      const v1 = nz(vol(before, hasVolume));
      const moved = negative ? v < v1 : v > v1;
      value = moved ? prev + ((bar.close - before.close) / before.close) * prev : prev;
    }
    return [value, value];
  },
});

/** The built-in variables of the v6 reference's ta namespace, by name. */
export const BAR_STEPS: Readonly<Record<string, BarStep>> = {
  'ta.obv': cumulative((bar, before, hv) =>
    before ? sign(bar.close - before.close) * vol(bar, hv) : Number.NaN,
  ),
  'ta.pvt': cumulative((bar, before, hv) =>
    before ? ((bar.close - before.close) / before.close) * vol(bar, hv) : Number.NaN,
  ),
  'ta.wad': cumulative((bar, before) => {
    if (!before) return Number.NaN;
    const trueHigh = Math.max(bar.high, before.close);
    const trueLow = Math.min(bar.low, before.close);
    const mom = bar.close - before.close;
    return mom > 0 ? bar.close - trueLow : mom < 0 ? bar.close - trueHigh : 0;
  }),
  // TradingView's Accumulation/Distribution: the close's place in the range, times the volume.
  'ta.accdist': cumulative((bar, _before, hv) =>
    (bar.close === bar.high && bar.close === bar.low) || bar.high === bar.low
      ? 0
      : ((2 * bar.close - bar.low - bar.high) / (bar.high - bar.low)) * vol(bar, hv),
  ),
  'ta.nvi': volumeIndex(true),
  'ta.pvi': volumeIndex(false),
  // TradingView multiplies by the volume (matched on its values, PineTS's data), where the
  // reference's "same on Pine" divides by it.
  'ta.iii': {
    next: (bar, _before, state, hv) => [
      ((2 * bar.close - bar.high - bar.low) / (bar.high - bar.low)) * vol(bar, hv),
      state,
    ],
  },
  'ta.wvad': {
    next: (bar, _before, state, hv) => [
      ((bar.close - bar.open) / (bar.high - bar.low)) * vol(bar, hv),
      state,
    ],
  },
};

/**
 * One of those variables over the chart's bars: computed on every bar, whether the script reads
 * it there or not, as TradingView's are, so `ta.obv[24]` is right inside an `if` too. The bars
 * it missed are caught up from the chart's own.
 */
export class BarSeriesFn implements Stateful {
  private readonly step: BarStep;
  private readonly values = new Hist();
  private state = Number.NaN;
  /** The index of the first bar of the run, set on the first call. */
  private first = -1;

  constructor(step: BarStep) {
    this.step = step;
  }

  /**
   * Its value `k` bars back from bar `index`; `bar(i)` is the chart's bar i (undefined before the
   * run's first).
   */
  at(
    index: number,
    k: number,
    bar: (i: number) => Bar | undefined,
    hasVolume: boolean,
    final: boolean,
  ): number {
    if (this.first < 0) this.first = index;
    // Commit every closed bar up to the one before this.
    while (this.first + this.values.length < index) {
      const [value, state] = this.compute(this.first + this.values.length, bar, hasVolume);
      this.values.push(value);
      this.state = state;
    }
    // Read by bar, so `ta.obv - ta.obv[24]` gets the same bars in either order.
    const position = index - k - this.first;
    if (position < 0) return Number.NaN;
    if (position < this.values.length) return this.values.back(this.values.length - position);
    const [value, state] = this.compute(index, bar, hasVolume);
    if (final) {
      this.values.push(value);
      this.state = state;
    }
    return value;
  }

  private compute(
    i: number,
    bar: (i: number) => Bar | undefined,
    hasVolume: boolean,
  ): [number, number] {
    const current = bar(i);
    if (!current) return [Number.NaN, this.state];
    return this.step.next(current, bar(i - 1), this.state, hasVolume);
  }

  save(): unknown {
    return [this.values.save(), this.state, this.first];
  }

  restore(state: unknown): void {
    const [length, value, first] = state as [number, number, number];
    this.values.restore(length);
    this.state = value;
    this.first = first;
  }
}
