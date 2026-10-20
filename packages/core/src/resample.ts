import { type BarClock, UTC_CLOCK } from './clock.ts';
import type { Bar } from './market.ts';
import { type Resolution, resolutionDurationMs } from './resolution.ts';

/**
 * Building intervals an exchange doesn't serve from ones it does (2m from 1m, 45m from 15m,
 * 3h from 1h, 6M from 1M, 5s from 1s), with the bar boundaries of the market's clock: UTC for
 * crypto, the sessions for stocks (clock.ts).
 */

const DAY_MS = 86_400_000;

/** Whether every bar boundary of `target` is also one of `base`, so each target bar is made of
 * whole base bars. */
export function nestsIn(
  base: Resolution,
  target: Resolution,
  clock: BarClock = UTC_CLOCK,
): boolean {
  return clock.nestsIn(base, target);
}

/** Rough bar length, for picking the coarsest base (months as 30.44 days, ticks as 0). */
function approxMs(resolution: Resolution): number {
  const fixed = resolutionDurationMs(resolution);
  if (fixed !== null) return fixed;
  return resolution.unit === 'month' ? resolution.count * 30.44 * DAY_MS : 0;
}

/** The coarsest of `natives` that `target` bars can be built from, or null if none fits. */
export function resampleBase(
  target: Resolution,
  natives: readonly Resolution[],
  clock: BarClock = UTC_CLOCK,
): Resolution | null {
  let best: Resolution | null = null;
  for (const native of natives) {
    if (clock.nestsIn(native, target) && (!best || approxMs(native) > approxMs(best))) {
      best = native;
    }
  }
  return best;
}

/** The most `base` bars one `target` bar can hold (months count as 31 days). */
export function maxBasePerBar(base: Resolution, target: Resolution): number {
  if (target.unit === 'month' && base.unit === 'month') return target.count / base.count;
  const targetMs =
    target.unit === 'month' ? target.count * 31 * DAY_MS : (resolutionDurationMs(target) ?? 0);
  const baseMs = resolutionDurationMs(base) ?? targetMs;
  return Math.max(1, Math.ceil(targetMs / baseMs));
}

/**
 * Folds ascending base bars into `target` bars, keyed by the clock's open time: open of the
 * first, close of the last, the highest high, the lowest low and the summed volume.
 *
 * Base bars without trades (volume 0) are placeholders that exchanges fill with the previous
 * close, so they're left out, unless no base bar in the period traded: then the bar is flat at
 * that price, as the exchange's own bar would be. Binance builds its 1-minute bars from its
 * 1-second bars exactly this way (checked against live data, 2026-10-18).
 */
export function resampleBars(
  bars: readonly Bar[],
  target: Resolution,
  clock: BarClock = UTC_CLOCK,
): Bar[] {
  const out: Bar[] = [];
  let current: Bar | null = null;
  let traded = false;
  for (const bar of bars) {
    const time = clock.open(target, bar.time * 1000) / 1000;
    const hasTrades = bar.volume > 0;
    if (!current || current.time !== time) {
      if (current) out.push(current);
      current = { ...bar, time };
      traded = hasTrades;
    } else if (hasTrades && !traded) {
      // The first real trade replaces the placeholder price.
      current = { ...bar, time };
      traded = true;
    } else if (hasTrades) {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume;
    }
  }
  if (current) out.push(current);
  return out;
}
