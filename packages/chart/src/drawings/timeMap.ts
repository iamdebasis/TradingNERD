import type { Bar, Resolution } from '@tradingnerd/core';

/**
 * Where a drawing's anchor time sits among the chart's bars, as a logical index (docs/SPEC.md
 * §6.24). A drawing's points are bar times, so on the interval it was drawn on each lands on its
 * bar; on another interval a time between two bars lands between them, and a line's slope can
 * change, which TradingView calls expected (Help Center, Lines become non-parallel when
 * switching interval). Past the last bar, and before the first, times run on at the interval's
 * length, so a drawing reaches into the future as TradingView's do.
 */
export class TimeMap {
  private readonly times: readonly number[];
  private readonly step: number;

  /** `times`: each bar's time in UTC seconds, oldest first; `step`: the interval, seconds. */
  constructor(times: readonly number[], step: number) {
    this.times = times;
    this.step = step > 0 ? step : 60;
  }

  /** The bars' times as the drawings use them: a tick bar's is its first trade's. */
  static fromBars(bars: readonly Bar[], resolution: Resolution | null): TimeMap {
    const times = bars.map((bar) => (bar.start !== undefined ? bar.start / 1000 : bar.time));
    return new TimeMap(times, stepOf(resolution, times));
  }

  get length(): number {
    return this.times.length;
  }

  /** The logical index of a time: whole on a bar's time, between bars in between. */
  logicalOf(time: number): number {
    const { times, step } = this;
    const last = times.length - 1;
    const first = times[0];
    const end = times[last];
    if (first === undefined || end === undefined) return Number.NaN;
    if (time <= first) return (time - first) / step;
    if (time >= end) return last + (time - end) / step;
    // The last bar at or before the time.
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((times[mid] as number) <= time) lo = mid;
      else hi = mid - 1;
    }
    const at = times[lo] as number;
    const next = times[lo + 1] as number;
    return lo + (time - at) / (next - at);
  }

  /** The time at a logical index: a bar's own, between bars in between, on past the ends. */
  timeOf(logical: number): number {
    const { times, step } = this;
    const last = times.length - 1;
    const first = times[0];
    const end = times[last];
    if (first === undefined || end === undefined) return Number.NaN;
    if (logical <= 0) return first + logical * step;
    if (logical >= last) return end + (logical - last) * step;
    const index = Math.floor(logical);
    const at = times[index] as number;
    const next = times[index + 1] as number;
    return at + (logical - index) * (next - at);
  }
}

/** Seconds in an interval; a tick chart's from its bars' usual spacing. */
export function stepOf(resolution: Resolution | null, times: readonly number[] = []): number {
  if (!resolution) return 60;
  const { count, unit } = resolution;
  switch (unit) {
    case 'second':
      return count;
    case 'minute':
      return count * 60;
    case 'day':
      return count * 86_400;
    case 'week':
      return count * 604_800;
    case 'month':
      // A month's average length: future months are spaced evenly (provisional).
      return count * 2_629_746;
    case 'tick': {
      const gaps: number[] = [];
      for (let i = Math.max(1, times.length - 50); i < times.length; i++) {
        const gap = (times[i] as number) - (times[i - 1] as number);
        if (gap > 0) gaps.push(gap);
      }
      gaps.sort((a, b) => a - b);
      return gaps[gaps.length >> 1] ?? 1;
    }
  }
}
