import { type Bar, type Resolution, UTC_CLOCK } from '@tradingnerd/core';
import type { OiPoint } from './series.ts';

/** Points by time, from a series and the live polls after it. */
export interface PointSource {
  /** Each point in [fromMs, toMs], in time order. */
  each(fromMs: number, toMs: number, fn: (time: number, value: number) => void): void;
  /** The first point's time, or null when there are none. */
  first(): number | null;
}

/**
 * An open interest bar from the points in it (provisional, docs/SPEC.md §11: TradingView doesn't
 * say how its open interest bars are made). Open interest is a level, not a flow: the bar opens
 * at the first point in it and closes at the last up to its end, the point stamped at its close
 * included (the open interest when it closes, and the next bar's open), so one bar's close is
 * the next one's open. A bar needs a point inside it; one only at its close belongs to the next.
 * Open interest isn't traded: every bar counts as traded (volume 1), as CRYPTOCAP's do, so the
 * gateway's resampling keeps them all (resampleBars), and the symbol says it has no real volume
 * (an index), so charts and scripts read none.
 */
export function oiBar(points: PointSource, openMs: number, closeMs: number): Bar | null {
  let open = Number.NaN;
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let close = Number.NaN;
  let inside = false;
  points.each(openMs, closeMs, (time, value) => {
    if (Number.isNaN(open)) open = value;
    if (time < closeMs) inside = true;
    if (value > high) high = value;
    if (value < low) low = value;
    close = value;
  });
  if (!inside) return null;
  return { time: openMs / 1000, open, high, low, close, volume: 1 };
}

/**
 * Up to `limit` bars opening strictly before `endMs` (up to the forming one when null), the
 * latest first found and returned in time order; gaps without points are skipped, so a page is
 * short only where the points begin.
 */
export function oiBarsBefore(
  points: PointSource,
  resolution: Resolution,
  endMs: number | null,
  limit: number,
  nowMs: number,
): Bar[] {
  const first = points.first();
  if (first === null) return [];
  const floor = UTC_CLOCK.open(resolution, first);
  let open =
    endMs === null ? UTC_CLOCK.open(resolution, nowMs) : UTC_CLOCK.open(resolution, endMs - 1);
  const out: Bar[] = [];
  while (out.length < limit && open >= floor) {
    const bar = oiBar(points, open, UTC_CLOCK.next(resolution, open));
    if (bar) out.push(bar);
    open = UTC_CLOCK.open(resolution, open - 1);
  }
  return out.reverse();
}

/** Bars opening in [startMs, endMs), the earliest `limit` of them. */
export function oiBarsIn(
  points: PointSource,
  resolution: Resolution,
  startMs: number,
  endMs: number,
  limit: number,
): Bar[] {
  const first = points.first();
  if (first === null) return [];
  let open = UTC_CLOCK.open(resolution, Math.max(startMs, first));
  if (open < startMs) open = UTC_CLOCK.next(resolution, open);
  const out: Bar[] = [];
  while (out.length < limit && open < endMs) {
    const next = UTC_CLOCK.next(resolution, open);
    const bar = oiBar(points, open, next);
    if (bar) out.push(bar);
    open = next;
  }
  return out;
}

/** A series' points with the live polls after them merged in by time. */
export function withPolls(series: PointSource, polls: readonly OiPoint[]): PointSource {
  if (polls.length === 0) return series;
  return {
    first: () => {
      const own = series.first();
      const poll = polls[0]?.time ?? null;
      if (own === null) return poll;
      return poll === null ? own : Math.min(own, poll);
    },
    each(fromMs, toMs, fn) {
      // The polls in range, found by bisection; then both lists walked together.
      let lo = 0;
      let hi = polls.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((polls[mid] as OiPoint).time < fromMs) lo = mid + 1;
        else hi = mid;
      }
      let p = lo;
      series.each(fromMs, toMs, (time, value) => {
        while (p < polls.length && (polls[p] as OiPoint).time < time) {
          const poll = polls[p] as OiPoint;
          if (poll.time > toMs) break;
          fn(poll.time, poll.value);
          p++;
        }
        fn(time, value);
      });
      for (; p < polls.length; p++) {
        const poll = polls[p] as OiPoint;
        if (poll.time > toMs) break;
        fn(poll.time, poll.value);
      }
    },
  };
}
