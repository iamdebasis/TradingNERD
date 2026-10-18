import {
  formatResolution,
  parseResolution,
  type Resolution,
  type ResolutionUnit,
} from './resolution.ts';

/**
 * Intervals as TradingView's interval menu and toolbar present them: sections, labels, its
 * built-in list, ordering, and what can be typed into the interval prompt.
 */

/** The interval menu's sections, top to bottom. */
export type IntervalSection = 'ticks' | 'seconds' | 'minutes' | 'hours' | 'days';

export const INTERVAL_SECTIONS: readonly IntervalSection[] = [
  'ticks',
  'seconds',
  'minutes',
  'hours',
  'days',
];

/** TradingView's built-in intervals, as its menu lists them (TradingView notation). */
export const STANDARD_INTERVALS: readonly string[] = [
  '1T',
  '10T',
  '100T',
  '1000T',
  '1S',
  '5S',
  '10S',
  '15S',
  '30S',
  '45S',
  '1',
  '2',
  '3',
  '5',
  '10',
  '15',
  '30',
  '45',
  '60',
  '120',
  '180',
  '240',
  '1D',
  '1W',
  '1M',
  '3M',
  '6M',
  '12M',
];

const isWholeHours = ({ count, unit }: Resolution) => unit === 'minute' && count % 60 === 0;

export function intervalSection(resolution: Resolution): IntervalSection {
  switch (resolution.unit) {
    case 'tick':
      return 'ticks';
    case 'second':
      return 'seconds';
    case 'minute':
      return isWholeHours(resolution) ? 'hours' : 'minutes';
    case 'day':
    case 'week':
    case 'month':
      return 'days';
  }
}

/** The toolbar's short label: "1m", "15m", "1h", "D", "2D", "W", "M", "6M", "5s", "100T". */
export function toolbarLabel(resolution: Resolution): string {
  const { count, unit } = resolution;
  switch (unit) {
    case 'tick':
      return `${count}T`;
    case 'second':
      return `${count}s`;
    case 'minute':
      return isWholeHours(resolution) ? `${count / 60}h` : `${count}m`;
    case 'day':
      return count === 1 ? 'D' : `${count}D`;
    case 'week':
      return count === 1 ? 'W' : `${count}W`;
    case 'month':
      return count === 1 ? 'M' : `${count}M`;
  }
}

const NOUNS: Record<ResolutionUnit | 'hour', string> = {
  tick: 'tick',
  second: 'second',
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
};

/** The menu's full label: "1 tick", "10 ticks", "5 seconds", "1 minute", "2 hours", "3 months". */
export function menuLabel(resolution: Resolution): string {
  const hours = isWholeHours(resolution);
  const count = hours ? resolution.count / 60 : resolution.count;
  const noun = NOUNS[hours ? 'hour' : resolution.unit];
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const UNIT_ORDER: Record<ResolutionUnit, number> = {
  tick: 0,
  second: 1,
  minute: 2,
  day: 3,
  week: 4,
  month: 5,
};

/** Menu and toolbar order: ticks first, then from the shortest bar to the longest. */
export function compareIntervals(a: Resolution, b: Resolution): number {
  return UNIT_ORDER[a.unit] - UNIT_ORDER[b.unit] || a.count - b.count;
}

const INPUT = /^(\d{1,4})?([a-zA-Z])?$/;

/**
 * Reads what the user types into the interval prompt: bare numbers are minutes ("15"), and a
 * letter picks another unit: s seconds, h hours, d days, w weeks, M months, t ticks ("4h",
 * "1D", "W", "3M", "100t"). Lowercase "m" means minutes ("15m", as the toolbar writes it);
 * uppercase "M" means months. Returns null for anything that isn't a valid interval.
 */
export function parseIntervalInput(text: string): Resolution | null {
  const match = INPUT.exec(text.trim());
  if (!match) return null;
  const [, digits, letter] = match;
  if (digits === undefined && letter === undefined) return null;
  const count = digits === undefined ? 1 : Number(digits);
  let resolution: Resolution;
  switch (letter) {
    case undefined:
    case 'm':
      resolution = { count, unit: 'minute' };
      break;
    case 'h':
    case 'H':
      resolution = { count: count * 60, unit: 'minute' };
      break;
    case 'M':
      resolution = { count, unit: 'month' };
      break;
    default: {
      const unit = LETTER_UNITS[letter.toLowerCase()];
      if (!unit) return null;
      resolution = { count, unit };
    }
  }
  // The canonical parser enforces each unit's limits.
  return parseResolution(formatResolution(resolution));
}

const LETTER_UNITS: Record<string, ResolutionUnit> = {
  s: 'second',
  t: 'tick',
  d: 'day',
  w: 'week',
};
