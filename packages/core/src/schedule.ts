import { type DayNumber, dateOf, dayOf, type TimeZone, timeZone, weekdayOf } from './timezone.ts';

/** Which hours count: the regular session, or with pre- and post-market trading. */
export type SessionHours = 'regular' | 'extended';

export const isSessionHours = (value: unknown): value is SessionHours =>
  value === 'regular' || value === 'extended';

/** Local minutes after midnight, open and close: [570, 960] is 09:30–16:00. */
export type Hours = readonly [number, number];

/**
 * A market's trading calendar in its own time zone, as the gateway sends it with a symbol.
 * Weekdays trade unless they are holidays; `special` days keep other regular hours (the 13:00
 * closes around Thanksgiving and Christmas).
 */
export interface MarketScheduleData {
  /** IANA time zone: "America/New_York". */
  timezone: string;
  /** Regular hours on an ordinary day. */
  regular: Hours;
  /** Pre-market open to post-market close on an ordinary day: [240, 1200] is 04:00–20:00. */
  extended: Hours;
  /** First and last dates the calendar knows ("2015-01-02"); beyond them weekdays trade. */
  from: string;
  to: string;
  /** Weekdays from `from` to `to` without trading, ascending. */
  holidays: readonly string[];
  /** Trading days with other regular hours. */
  special: Readonly<Record<string, Hours>>;
}

/** One day's trading hours, as instants (ms); the close is exclusive. */
export interface Session {
  day: DayNumber;
  open: number;
  close: number;
}

/** No market here closes for this long (the longest NYSE closure since 1970 was 6 days). */
const MAX_GAP_DAYS = 31;
/** 1970-01-05, the first Monday: trading days are counted from it, for multi-day bars. */
const ORIGIN = 4;

const mod = (value: number, step: number) => ((value % step) + step) % step;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Weekdays from ORIGIN up to (not including) `day`; negative before it. */
function weekdaysBefore(day: DayNumber): number {
  const weeks = Math.floor((day - ORIGIN) / 7);
  return weeks * 5 + Math.min(mod(day - ORIGIN, 7), 5);
}

export class MarketSchedule {
  readonly data: MarketScheduleData;
  readonly zone: TimeZone;
  /** Every session opens and closes on a multiple of this many minutes (30 in New York). */
  readonly boundaryMinutes: number;
  private readonly holidays: readonly DayNumber[];
  private readonly holidaySet: ReadonlySet<DayNumber>;
  private readonly special: ReadonlyMap<DayNumber, Hours>;
  private readonly sessions = new Map<number, Session | null>();

  constructor(data: MarketScheduleData) {
    this.data = data;
    this.zone = timeZone(data.timezone);
    this.holidays = data.holidays.map(dayOf).sort((a, b) => a - b);
    this.holidaySet = new Set(this.holidays);
    this.special = new Map(
      Object.entries(data.special).map(([date, hours]) => [dayOf(date), hours]),
    );
    const bounds = [data.regular, data.extended, ...this.special.values()].flat();
    // An early close shifts the post-market close as much (see `hours`).
    for (const [, close] of this.special.values()) bounds.push(close + this.postMarketMinutes());
    this.boundaryMinutes = bounds.reduce((all, minutes) => gcd(all, minutes), 24 * 60);
  }

  isTradingDay(day: DayNumber): boolean {
    const weekday = weekdayOf(day);
    return weekday !== 0 && weekday !== 6 && !this.holidaySet.has(day);
  }

  /**
   * A trading day's hours, or null. Extended hours keep the pre-market open and the post-market
   * session's length, so a 13:00 close has after-hours trading until 17:00.
   */
  hours(day: DayNumber, hours: SessionHours): Hours | null {
    if (!this.isTradingDay(day)) return null;
    const regular = this.special.get(day) ?? this.data.regular;
    if (hours === 'regular') return regular;
    return [Math.min(this.data.extended[0], regular[0]), regular[1] + this.postMarketMinutes()];
  }

  session(day: DayNumber, hours: SessionHours): Session | null {
    const key = day * 2 + (hours === 'extended' ? 1 : 0);
    let session = this.sessions.get(key);
    if (session === undefined) {
      const range = this.hours(day, hours);
      session = range
        ? { day, open: this.zone.utc(day, range[0]), close: this.zone.utc(day, range[1]) }
        : null;
      if (this.sessions.size >= 20_000) this.sessions.clear();
      this.sessions.set(key, session);
    }
    return session;
  }

  /** The session holding `ms`, or else the last one before it. */
  sessionAtOrBefore(ms: number, hours: SessionHours): Session {
    let day = this.zone.local(ms).day;
    for (let gap = 0; gap < MAX_GAP_DAYS; gap++, day--) {
      const session = this.session(day, hours);
      if (session && session.open <= ms) return session;
    }
    throw new Error(`No trading session in the ${MAX_GAP_DAYS} days before ${dateOf(day)}`);
  }

  /** The first session after `day`. */
  sessionAfter(day: DayNumber, hours: SessionHours): Session {
    for (let next = day + 1; next <= day + MAX_GAP_DAYS; next++) {
      const session = this.session(next, hours);
      if (session) return session;
    }
    throw new Error(`No trading session in the ${MAX_GAP_DAYS} days after ${dateOf(day)}`);
  }

  /** The first trading day on or after `day`. */
  tradingDayFrom(day: DayNumber): DayNumber {
    return this.isTradingDay(day) ? day : this.sessionAfter(day, 'regular').day;
  }

  /** The last trading day before `day`. */
  tradingDayBefore(day: DayNumber): DayNumber {
    for (let previous = day - 1; previous >= day - MAX_GAP_DAYS; previous--) {
      if (this.isTradingDay(previous)) return previous;
    }
    throw new Error(`No trading day in the ${MAX_GAP_DAYS} days before ${dateOf(day)}`);
  }

  /** Trading days from 1970-01-05 up to `day` (not counting it), for multi-day bars. */
  tradingDayIndex(day: DayNumber): number {
    return weekdaysBefore(day) - this.holidaysBefore(day);
  }

  /** The trading day with this index. */
  tradingDayAt(index: number): DayNumber {
    // Holidays only push trading days later than the weekday count puts them.
    let low = ORIGIN + Math.floor(index / 5) * 7 + mod(index, 5) - 7;
    let high = low + 21 + Math.ceil(((this.holidays.length + 1) * 7) / 5);
    // The smallest day with `index + 1` trading days up to and including it.
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.tradingDayIndex(middle + 1) >= index + 1) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  private holidaysBefore(day: DayNumber): number {
    let low = 0;
    let high = this.holidays.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.holidays[middle] ?? 0) < day) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private postMarketMinutes(): number {
    return this.data.extended[1] - this.data.regular[1];
  }
}

const isMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24 * 60;

function parseHours(value: unknown): Hours | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [open, close] = value as unknown[];
  return isMinutes(open) && isMinutes(close) && open < close ? [open, close] : null;
}

const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return dateOf(dayOf(value)) === value;
  } catch {
    return false;
  }
};

/** Validates a schedule from the wire or disk; null if anything is off. */
export function parseMarketSchedule(value: unknown): MarketScheduleData | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.timezone !== 'string' || v.timezone === '') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v.timezone });
  } catch {
    return null;
  }
  const regular = parseHours(v.regular);
  const extended = parseHours(v.extended);
  if (!regular || !extended || extended[0] > regular[0] || extended[1] < regular[1]) return null;
  if (!isDate(v.from) || !isDate(v.to) || v.from > v.to) return null;
  if (!Array.isArray(v.holidays) || !v.holidays.every(isDate)) return null;
  if (typeof v.special !== 'object' || v.special === null || Array.isArray(v.special)) return null;
  const special: Record<string, Hours> = {};
  for (const [date, hours] of Object.entries(v.special)) {
    const parsed = parseHours(hours);
    if (!isDate(date) || !parsed) return null;
    special[date] = parsed;
  }
  return {
    timezone: v.timezone,
    regular,
    extended,
    from: v.from,
    to: v.to,
    holidays: [...v.holidays].sort(),
    special,
  };
}
