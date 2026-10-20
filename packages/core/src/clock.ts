import { barCloseTime, barOpenTime, type Resolution, resolutionDurationMs } from './resolution.ts';
import type { MarketSchedule, SessionHours } from './schedule.ts';
import { type DayNumber, weekdayOf } from './timezone.ts';

/**
 * Where bars begin and end for one market. Crypto trades around the clock and its bars follow
 * UTC (resolution.ts). Markets that close, like US stocks, follow their sessions instead, as
 * TradingView does: intraday bars start at the session's open (09:30, 10:30 … 15:30 for an
 * hour), and a day, week or month bar is the trading days in it, timed at its first session's
 * open.
 */
export interface BarClock {
  /** True when each bar ends where the next begins (a market trading around the clock). */
  readonly continuous: boolean;
  /** Open (ms) of the bar holding `ms`; between sessions, of the last bar before it. */
  open(resolution: Resolution, ms: number): number;
  /** When the bar opening at `openMs` ends (exclusive). */
  close(resolution: Resolution, openMs: number): number;
  /** When the bar after the one opening at `openMs` opens. */
  next(resolution: Resolution, openMs: number): number;
  /** Whether each `target` bar is made of whole `base` bars. */
  nestsIn(base: Resolution, target: Resolution): boolean;
  /** Whether the market trades at `ms`. */
  isOpen(ms: number): boolean;
}

const DAY_MS = 86_400_000;
/** 1970-01-05, the first Monday: weekly bars count from it. */
const FIRST_MONDAY: DayNumber = 4;

const isIntraday = (resolution: Resolution) =>
  resolution.unit === 'second' || resolution.unit === 'minute';
const mod = (value: number, step: number) => ((value % step) + step) % step;

/**
 * Whether every bar boundary of `target` is also one of `base` in UTC bars. Intraday bars
 * restart at 00:00 UTC, so an intraday base must divide the day.
 */
function utcNestsIn(base: Resolution, target: Resolution): boolean {
  if (base.unit === 'tick' || target.unit === 'tick') return false;
  if (isIntraday(base)) {
    const baseMs = resolutionDurationMs(base);
    if (baseMs === null || DAY_MS % baseMs !== 0) return false;
    // Day, week and month boundaries all fall on midnight, which is a base boundary.
    if (!isIntraday(target)) return true;
    return (resolutionDurationMs(target) ?? 0) % baseMs === 0;
  }
  switch (target.unit) {
    case 'day':
      // Both count whole days from the epoch.
      return base.unit === 'day' && target.count % base.count === 0;
    case 'week':
      return (
        (base.unit === 'day' && base.count === 1) ||
        (base.unit === 'week' && target.count % base.count === 0)
      );
    case 'month':
      return (
        (base.unit === 'day' && base.count === 1) ||
        (base.unit === 'month' && target.count % base.count === 0)
      );
    default:
      return false;
  }
}

/** Crypto's bars: UTC days, weeks from Monday, calendar months (resolution.ts). */
export const UTC_CLOCK: BarClock = Object.freeze({
  continuous: true,
  open: barOpenTime,
  close: barCloseTime,
  next: barCloseTime,
  nestsIn: utcNestsIn,
  isOpen: () => true,
});

/**
 * Bars of a market with sessions. Intraday bars follow `hours` (regular, or with pre- and
 * post-market); day and longer bars are always the regular sessions, as on TradingView.
 * Multi-day bars group trading days counted from 1970-01-05; weeks start on Monday and
 * 3, 6 and 12 months in January, as crypto's do.
 */
export function sessionClock(schedule: MarketSchedule, hours: SessionHours = 'regular'): BarClock {
  return new SessionClock(schedule, hours);
}

class SessionClock implements BarClock {
  readonly continuous = false;
  private readonly schedule: MarketSchedule;
  private readonly hours: SessionHours;

  constructor(schedule: MarketSchedule, hours: SessionHours) {
    this.schedule = schedule;
    this.hours = hours;
  }

  isOpen(ms: number): boolean {
    return ms < this.schedule.sessionAtOrBefore(ms, this.hours).close;
  }

  open(resolution: Resolution, ms: number): number {
    if (resolution.unit === 'tick') throw new Error('Tick bars have no fixed open time');
    if (isIntraday(resolution)) {
      const step = resolutionDurationMs(resolution) ?? 60_000;
      const session = this.schedule.sessionAtOrBefore(ms, this.hours);
      const within = Math.min(ms, session.close - 1);
      return session.open + Math.floor((within - session.open) / step) * step;
    }
    const day = this.schedule.sessionAtOrBefore(ms, 'regular').day;
    return this.openOf(this.firstDay(resolution, day));
  }

  close(resolution: Resolution, openMs: number): number {
    if (resolution.unit === 'tick') throw new Error('Tick bars have no fixed close time');
    if (isIntraday(resolution)) {
      const step = resolutionDurationMs(resolution) ?? 60_000;
      const session = this.schedule.sessionAtOrBefore(openMs, this.hours);
      return Math.min(openMs + step, session.close);
    }
    const first = this.schedule.sessionAtOrBefore(openMs, 'regular').day;
    return this.closeOf(this.lastDay(resolution, first));
  }

  next(resolution: Resolution, openMs: number): number {
    if (resolution.unit === 'tick') throw new Error('Tick bars have no fixed open time');
    if (isIntraday(resolution)) {
      const step = resolutionDurationMs(resolution) ?? 60_000;
      const session = this.schedule.sessionAtOrBefore(openMs, this.hours);
      const next = openMs + step;
      return next < session.close ? next : this.schedule.sessionAfter(session.day, this.hours).open;
    }
    const first = this.schedule.sessionAtOrBefore(openMs, 'regular').day;
    const after = this.schedule.sessionAfter(this.lastDay(resolution, first), 'regular').day;
    return this.openOf(this.firstDay(resolution, after));
  }

  nestsIn(base: Resolution, target: Resolution): boolean {
    if (base.unit === 'tick' || target.unit === 'tick') return false;
    if (isIntraday(base)) {
      // Base bars must restart with every session: their length divides each open and close.
      const baseMs = resolutionDurationMs(base) ?? 0;
      if (baseMs <= 0 || (this.schedule.boundaryMinutes * 60_000) % baseMs !== 0) return false;
      if (!isIntraday(target)) return true;
      return (resolutionDurationMs(target) ?? 0) % baseMs === 0;
    }
    // Days, weeks and months group the same way as in UTC bars.
    return utcNestsIn(base, target);
  }

  /** The first trading day of the day, week or month bar holding trading day `day`. */
  private firstDay(resolution: Resolution, day: DayNumber): DayNumber {
    const { count } = resolution;
    switch (resolution.unit) {
      case 'day': {
        const index = this.schedule.tradingDayIndex(day);
        return this.schedule.tradingDayAt(index - mod(index, count));
      }
      case 'week':
        return this.schedule.tradingDayFrom(this.weekStart(day, count));
      default:
        return this.schedule.tradingDayFrom(this.monthStart(day, count));
    }
  }

  /** The last trading day of the bar whose first trading day is `first`. */
  private lastDay(resolution: Resolution, first: DayNumber): DayNumber {
    const { count } = resolution;
    switch (resolution.unit) {
      case 'day':
        return this.schedule.tradingDayAt(this.schedule.tradingDayIndex(first) + count - 1);
      case 'week':
        return this.schedule.tradingDayBefore(this.weekStart(first, count) + 7 * count);
      default: {
        const start = new Date(this.monthStart(first, count) * DAY_MS);
        const end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + count, 1) / DAY_MS;
        return this.schedule.tradingDayBefore(end);
      }
    }
  }

  /** The Monday that starts the `count`-week group holding `day`. */
  private weekStart(day: DayNumber, count: number): DayNumber {
    const monday = day - mod(weekdayOf(day) - 1, 7);
    const weeks = (monday - FIRST_MONDAY) / 7;
    return FIRST_MONDAY + (weeks - mod(weeks, count)) * 7;
  }

  /** The first day of the `count`-month group holding `day` (3, 6 and 12 start in January). */
  private monthStart(day: DayNumber, count: number): DayNumber {
    const date = new Date(day * DAY_MS);
    const months = date.getUTCFullYear() * 12 + date.getUTCMonth();
    const aligned = months - mod(months, count);
    return Date.UTC(Math.floor(aligned / 12), aligned % 12, 1) / DAY_MS;
  }

  private openOf(day: DayNumber): number {
    const session = this.schedule.session(day, 'regular');
    if (!session) throw new Error('Not a trading day');
    return session.open;
  }

  private closeOf(day: DayNumber): number {
    const session = this.schedule.session(day, 'regular');
    if (!session) throw new Error('Not a trading day');
    return session.close;
  }
}
