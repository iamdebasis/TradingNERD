/**
 * Bar intervals in TradingView notation: minutes are bare numbers ("1", "15", "60", "240"),
 * other units carry a letter ("1S", "1D", "1W", "1M", "6M", "10T"). "D", "W" and "M" alone mean 1.
 * All bar boundaries are UTC, matching TradingView's crypto charts and Binance's klines.
 */
export type ResolutionUnit = 'tick' | 'second' | 'minute' | 'day' | 'week' | 'month';

export interface Resolution {
  count: number;
  unit: ResolutionUnit;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
/** 1970-01-05, the first Monday after the epoch: weekly bars open on Mondays. */
const FIRST_MONDAY = 4 * DAY;

const LETTER_UNITS: Record<string, ResolutionUnit> = {
  T: 'tick',
  S: 'second',
  D: 'day',
  W: 'week',
  M: 'month',
};

const MAX_COUNT: Record<ResolutionUnit, number> = {
  tick: 1_000,
  second: 59,
  minute: 1_440,
  day: 365,
  week: 52,
  month: 12,
};

export function parseResolution(text: string): Resolution | null {
  const match = /^(\d{0,4})([TSDWM]?)$/.exec(text.trim());
  if (!match) return null;
  const [, digits = '', letter = ''] = match;
  if (digits === '' && letter === '') return null;
  // Bare letters ("D") mean 1; bare digits are minutes; "S"/"T" need an explicit count like TV.
  if (digits === '' && (letter === 'S' || letter === 'T')) return null;
  const count = digits === '' ? 1 : Number(digits);
  const unit = letter === '' ? 'minute' : LETTER_UNITS[letter];
  if (!unit || count < 1 || count > MAX_COUNT[unit]) return null;
  return { count, unit };
}

/** Canonical TradingView string: "15", "60", "1D", "1W", "1M", "1S", "10T". */
export function formatResolution({ count, unit }: Resolution): string {
  switch (unit) {
    case 'minute':
      return String(count);
    case 'tick':
      return `${count}T`;
    case 'second':
      return `${count}S`;
    case 'day':
      return `${count}D`;
    case 'week':
      return `${count}W`;
    case 'month':
      return `${count}M`;
  }
}

/**
 * Short label used in the chart legend: "1s", "15", "1h", "4h", "1D", "1W", "1M", "100T".
 * Minutes stay bare numbers and whole hours get "h", as in TradingView's legend.
 */
export function resolutionLabel({ count, unit }: Resolution): string {
  switch (unit) {
    case 'minute':
      return count % 60 === 0 ? `${count / 60}h` : String(count);
    case 'second':
      return `${count}s`;
    case 'tick':
      return `${count}T`;
    case 'day':
      return `${count}D`;
    case 'week':
      return `${count}W`;
    case 'month':
      return `${count}M`;
  }
}

/** Length of one bar in ms, or null for ticks and calendar months (which vary). */
export function resolutionDurationMs({ count, unit }: Resolution): number | null {
  switch (unit) {
    case 'second':
      return count * SECOND;
    case 'minute':
      return count * MINUTE;
    case 'day':
      return count * DAY;
    case 'week':
      return count * WEEK;
    case 'tick':
    case 'month':
      return null;
  }
}

/** True for intervals shorter than a day (the time axis then shows clock times). */
export function isIntraday({ unit }: Resolution): boolean {
  return unit === 'tick' || unit === 'second' || unit === 'minute';
}

const floorTo = (value: number, step: number, origin = 0) =>
  origin + Math.floor((value - origin) / step) * step;

const startOfUtcDay = (ms: number) => floorTo(ms, DAY);

/**
 * Open time (ms) of the bar that contains `ms`.
 * - Seconds/minutes restart at 00:00 UTC each day (a 45-minute day ends with a full bar at 23:15).
 * - Days count from the epoch, so 3-day bars line up with Binance's.
 * - Weeks open Monday 00:00 UTC. Months are calendar months; 3M/6M/12M start in January.
 */
export function barOpenTime(resolution: Resolution, ms: number): number {
  const { count, unit } = resolution;
  switch (unit) {
    case 'second':
    case 'minute': {
      const day = startOfUtcDay(ms);
      return floorTo(ms, resolutionDurationMs(resolution) ?? MINUTE, day);
    }
    case 'day':
      return floorTo(ms, count * DAY);
    case 'week':
      return floorTo(ms, count * WEEK, FIRST_MONDAY);
    case 'month': {
      const date = new Date(ms);
      const months = date.getUTCFullYear() * 12 + date.getUTCMonth();
      const aligned = months - (((months % count) + count) % count);
      return Date.UTC(Math.floor(aligned / 12), aligned % 12, 1);
    }
    case 'tick':
      throw new Error('Tick bars have no fixed open time');
  }
}

/** End (exclusive, ms) of the bar that opened at `openMs`. */
export function barCloseTime(resolution: Resolution, openMs: number): number {
  const { count, unit } = resolution;
  switch (unit) {
    case 'second':
    case 'minute': {
      const nextDay = startOfUtcDay(openMs) + DAY;
      return Math.min(openMs + (resolutionDurationMs(resolution) ?? MINUTE), nextDay);
    }
    case 'day':
    case 'week':
      return openMs + (resolutionDurationMs(resolution) ?? DAY);
    case 'month': {
      const date = new Date(openMs);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1);
    }
    case 'tick':
      throw new Error('Tick bars have no fixed close time');
  }
}
