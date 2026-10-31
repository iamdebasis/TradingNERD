import { SETTLED_WEIGHT } from '@tradingnerd/indicators';

/** Rounding between two runs that still counts as agreeing, as a share of the values' size. */
export const ROUNDING = 1e-12;

/** A far-off first bar whose effect hasn't faded below this share of its peak at the end is remembered. */
export const MEMORY = 1e-3;

/**
 * One output of the script's own run against the same output of one of the warm-up check's runs
 * (script.ts, CHECKS). The closed bars are looked at once, as they close; the live bar each time
 * it's asked, against the closed bars' tolerance.
 *
 * Values agree where both are na, or where they differ by no more than SETTLED_WEIGHT of the
 * largest difference (how far the check's change has faded), or by rounding. Colors agree only
 * where they're the same.
 */
export class Agreement {
  readonly colors: boolean;
  readonly memory: boolean;
  /** Bars 1 … closed - 1 are looked at. */
  private closed = 1;
  /** The largest difference there, and the largest of our values. */
  private peak = 0;
  private size = 0;
  /** The last of those bars where the runs disagree; -1 for none. */
  private last = -1;
  /** The last of those bars where either run has a value; -1 for none. */
  private valued = -1;

  constructor(colors: boolean, memory: boolean) {
    this.colors = colors;
    this.memory = memory;
  }

  /** Looks afresh at bars 1 … closed - 1. */
  rebuild(own: ArrayLike<number>, theirs: ArrayLike<number>, closed: number): void {
    this.closed = Math.max(1, closed);
    this.peak = 0;
    this.size = 0;
    this.last = -1;
    this.valued = -1;
    for (let j = 1; j < closed; j++) this.measure(own[j] as number, theirs[j] as number);
    const tolerance = this.tolerance();
    for (let j = closed - 1; j >= 1; j--) {
      if (!this.agrees(own[j] as number, theirs[j] as number, tolerance)) {
        this.last = j;
        break;
      }
    }
    for (let j = closed - 1; j >= 1; j--) {
      if (!Number.isNaN(own[j] as number) || !Number.isNaN(theirs[j] as number)) {
        this.valued = j;
        break;
      }
    }
  }

  /** Bars up to `closed` - 1 have closed: looks at the new ones, or afresh if the tolerance grew. */
  extend(own: ArrayLike<number>, theirs: ArrayLike<number>, closed: number): void {
    if (closed < this.closed) {
      this.rebuild(own, theirs, closed);
      return;
    }
    for (let j = this.closed; j < closed; j++) {
      const a = own[j] as number;
      const b = theirs[j] as number;
      const before = this.tolerance();
      this.measure(a, b);
      // A larger tolerance can make earlier bars agree: look at all of them again.
      if (!this.memory && this.tolerance() > before) {
        this.rebuild(own, theirs, closed);
        return;
      }
      if (!this.agrees(a, b, before)) this.last = j;
      if (!Number.isNaN(a) || !Number.isNaN(b)) this.valued = j;
    }
    this.closed = closed;
  }

  /** The last bar where the runs disagree, the live bar (`length` - 1) included; -1 for none. */
  lastDisagreement(own: ArrayLike<number>, theirs: ArrayLike<number>, length: number): number {
    const live = length - 1;
    if (
      live >= 1 &&
      live >= this.closed &&
      !this.agrees(own[live] as number, theirs[live] as number, this.tolerance())
    ) {
      return live;
    }
    return this.last;
  }

  /**
   * For a check that changed the first bars far off: whether that still shows at the last bar
   * either run has a value on, as a running maximum since the first bar remembers it.
   */
  remembers(own: ArrayLike<number>, theirs: ArrayLike<number>, length: number): boolean {
    const live = length - 1;
    const liveValued =
      live >= 1 && (!Number.isNaN(own[live] as number) || !Number.isNaN(theirs[live] as number));
    const j = liveValued ? live : this.valued;
    if (j < 1) return false;
    const a = own[j] as number;
    const b = theirs[j] as number;
    if (Number.isNaN(a) !== Number.isNaN(b)) return true;
    if (this.colors) return a !== b;
    return Math.abs(a - b) > Math.max(MEMORY * this.peak, ROUNDING * this.size);
  }

  private tolerance(): number {
    return this.colors ? 0 : Math.max(SETTLED_WEIGHT * this.peak, ROUNDING * this.size);
  }

  private measure(a: number, b: number): void {
    if (this.colors) return;
    if (Number.isFinite(a)) this.size = Math.max(this.size, Math.abs(a));
    if (Number.isFinite(a) && Number.isFinite(b)) this.peak = Math.max(this.peak, Math.abs(a - b));
  }

  private agrees(a: number, b: number, tolerance: number): boolean {
    if (a === b) return true;
    const aNa = Number.isNaN(a);
    const bNa = Number.isNaN(b);
    if (aNa || bNa) return aNa && bNa;
    return !this.colors && Math.abs(a - b) <= tolerance;
  }
}

/**
 * Where an output is drawn from, given each check's verdict: from bar 0 when no check disagrees;
 * from the last bar a check disagrees on otherwise, since agreeing from bar s on, starting a bar
 * later or with bar 0 changed, means agreeing from bar s - 1 on with the bars before ours; never
 * (Infinity) when even the live bar disagrees, or a check remembers the first bars for good.
 */
export function drawnFrom(lastDisagreement: number, remembers: boolean, length: number): number {
  if (remembers) return Number.POSITIVE_INFINITY;
  if (lastDisagreement < 0) return 0;
  return lastDisagreement < length - 1 ? lastDisagreement : Number.POSITIVE_INFINITY;
}
