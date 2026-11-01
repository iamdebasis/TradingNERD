import {
  type BarClock,
  formatResolution,
  parseResolution,
  type Resolution,
  resolutionDurationMs,
  timeZone,
} from '@tradingnerd/core';

/**
 * Pine's dates and times (Pine docs: Time; Sessions; Timeframes). Times are UNIX milliseconds;
 * calendar values are in a time zone, the exchange's unless a `timezone` argument names
 * another, written "UTC+3", "GMT-0530" or as an IANA name ("America/New_York").
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

/** A time zone of Pine's `timezone` arguments. */
export interface Zone {
  /** Milliseconds to add to UTC at `ms` for local time. */
  offset(ms: number): number;
  /** The IANA name, or null for a fixed UTC offset. */
  readonly iana: string | null;
}

const UTC_ZONE: Zone = { offset: () => 0, iana: null };
const zones = new Map<string, Zone | null>();

/** The zone a Pine `timezone` string names, or null when it names none. */
export function zoneOf(name: string): Zone | null {
  const cached = zones.get(name);
  if (cached !== undefined) return cached;
  const zone = parseZone(name.trim());
  zones.set(name, zone);
  return zone;
}

function parseZone(text: string): Zone | null {
  const fixed = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(text);
  if (fixed) {
    if (!fixed[1]) return UTC_ZONE;
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3] ?? 0);
    if (minutes > 14 * 60) return null;
    const offset = (fixed[1] === '-' ? -1 : 1) * minutes * MINUTE;
    return { offset: () => offset, iana: null };
  }
  try {
    const zone = timeZone(text);
    return { offset: (ms) => zone.offset(ms), iana: text };
  } catch {
    // Intl refuses a name it doesn't know.
    return null;
  }
}

/** A moment's calendar values in a zone (Pine's year, month … second). */
export interface Calendar {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** Pine's dayofweek: 1 for Sunday … 7 for Saturday. */
  weekday: number;
}

export function calendarOf(ms: number, zone: Zone): Calendar {
  const date = new Date(ms + zone.offset(ms));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
    weekday: date.getUTCDay() + 1,
  };
}

/**
 * The ISO 8601 week (Monday first; week 1 holds the year's first Thursday). TradingView doesn't
 * say which week numbering weekofyear uses: provisional (docs/SPEC.md §11).
 */
export function weekOfYear(year: number, month: number, day: number): number {
  const date = Date.UTC(year, month - 1, day);
  const weekday = (new Date(date).getUTCDay() + 6) % 7;
  const thursday = date + (3 - weekday) * DAY;
  const start = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return 1 + Math.floor((thursday - start) / (7 * DAY));
}

/**
 * The UNIX time of a calendar date and time in a zone (timestamp()): out-of-range values carry
 * over as JavaScript's Date does (month 13 is January of the next year); na gives na.
 */
export function timeOf(
  zone: Zone,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const local = date.getTime();
  if (Number.isNaN(local)) return Number.NaN;
  return local - zone.offset(local - zone.offset(local));
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  return MONTHS.findIndex((month) => month.toLowerCase().startsWith(lower.slice(0, 3)));
}

/** "+0300", "+03:00", "GMT+3", "UTC", "Z" in a date string → the offset (ms), or null. */
function offsetIn(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.trim();
  if (/^(Z|UTC|GMT)$/i.test(t)) return 0;
  const match = /^(?:UTC|GMT)?\s*([+-])(\d{1,2}):?(\d{2})?$/i.exec(t);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return (match[1] === '-' ? -1 : 1) * minutes * MINUTE;
}

/**
 * timestamp(dateString): RFC 2822 ("20 Feb 2020 15:30:00 +0300") or ISO 8601
 * ("2020-02-20T15:30:00+03:00"). Without a time it's 00:00; without a time zone, UTC (the v6
 * reference: "If no time zone is supplied, GMT+0 will be used"). NaN when it can't be read.
 */
export function parseDate(text: string): number {
  const t = text.trim();
  const zone = String.raw`(\s*(?:Z|(?:UTC|GMT)?\s*[+-]\d{1,2}(?::?\d{2})?|UTC|GMT))?`;
  const time = String.raw`(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?`;
  const iso = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${time}${zone}$`, 'i').exec(t);
  let fields: [number, number, number, number, number, number, number] | null = null;
  let offset: number | null = null;
  if (iso) {
    fields = [
      Number(iso[1]),
      Number(iso[2]),
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
      Number((iso[7] ?? '0').padEnd(3, '0')),
    ];
    offset = offsetIn(iso[8]);
  } else {
    const dayFirst = new RegExp(
      String.raw`^(?:[A-Za-z]{3,},?\s+)?(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})${time}${zone}$`,
    ).exec(t);
    const monthFirst = new RegExp(
      String.raw`^(?:[A-Za-z]{3,},?\s+)?([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})${time}${zone}$`,
    ).exec(t);
    const m = dayFirst ?? monthFirst;
    if (m) {
      const month = monthIndex(dayFirst ? (m[2] as string) : (m[1] as string));
      if (month < 0) return Number.NaN;
      fields = [
        Number(m[3]),
        month + 1,
        Number(dayFirst ? m[1] : m[2]),
        Number(m[4] ?? 0),
        Number(m[5] ?? 0),
        Number(m[6] ?? 0),
        Number((m[7] ?? '0').padEnd(3, '0')),
      ];
      offset = offsetIn(m[8]);
    }
  }
  if (!fields) return Number.NaN;
  const [year, month, day, hour, minute, second, ms] = fields;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 60)
    return Number.NaN;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - (offset ?? 0);
}

// ---- str.format_time(): Java's SimpleDateFormat ----

const zoneNames = new Map<string, Intl.DateTimeFormat>();

/** "EDT", "Eastern Daylight Time", "GMT+03:00": the zone's name at `ms`, as `z` writes it. */
function zoneName(zone: Zone, ms: number, long: boolean): string {
  if (zone.iana) {
    const key = `${zone.iana}|${long}`;
    let format = zoneNames.get(key);
    if (!format) {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone: zone.iana,
        timeZoneName: long ? 'long' : 'short',
      });
      zoneNames.set(key, format);
    }
    return format.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? '';
  }
  const offset = zone.offset(ms) / MINUTE;
  if (offset === 0) return 'GMT';
  const abs = Math.abs(offset);
  return `GMT${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const pad = (value: number, width: number) =>
  `${value < 0 ? '-' : ''}${String(Math.abs(value)).padStart(width, '0')}`;

/**
 * A UNIX time written with a SimpleDateFormat pattern in a zone (Pine docs, Time: Formatting
 * dates and times). `h` is the 12-hour clock from 12 to 11, as Java's: the manual's own example
 * writes midnight as "12:00:00" with "hh:mm:ss".
 */
export function formatDate(ms: number, pattern: string, zone: Zone): string {
  const time = Number.isNaN(ms) ? 0 : ms;
  const c = calendarOf(time, zone);
  const local = Date.UTC(c.year, c.month - 1, c.day);
  const dayOfYear = 1 + Math.round((local - Date.UTC(c.year, 0, 1)) / DAY);
  let out = '';
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i] as string;
    if (ch === "'") {
      if (pattern[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      const end = pattern.indexOf("'", i + 1);
      out += end < 0 ? pattern.slice(i + 1) : pattern.slice(i + 1, end);
      i = end < 0 ? pattern.length : end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    let n = 1;
    while (pattern[i + n] === ch) n++;
    i += n;
    switch (ch) {
      case 'G':
        out += c.year > 0 ? 'AD' : 'BC';
        break;
      case 'y':
      case 'Y':
      case 'u':
        if (ch === 'u') out += String(c.weekday === 1 ? 7 : c.weekday - 1);
        else out += n === 2 ? pad(c.year % 100, 2) : pad(c.year, n);
        break;
      case 'M':
      case 'L':
        out +=
          n >= 4
            ? (MONTHS[c.month - 1] as string)
            : n === 3
              ? (MONTHS[c.month - 1] as string).slice(0, 3)
              : pad(c.month, n);
        break;
      case 'w':
        out += pad(weekOfYear(c.year, c.month, c.day), n);
        break;
      case 'W': {
        const first = new Date(Date.UTC(c.year, c.month - 1, 1)).getUTCDay();
        out += pad(Math.floor((c.day + first - 1) / 7) + 1, n);
        break;
      }
      case 'D':
        out += pad(dayOfYear, n);
        break;
      case 'd':
        out += pad(c.day, n);
        break;
      case 'F':
        out += pad(Math.floor((c.day - 1) / 7) + 1, n);
        break;
      case 'E': {
        const name = WEEKDAYS[c.weekday - 1] as string;
        out += n >= 4 ? name : name.slice(0, 3);
        break;
      }
      case 'a':
        out += c.hour < 12 ? 'AM' : 'PM';
        break;
      case 'H':
        out += pad(c.hour, n);
        break;
      case 'k':
        out += pad(c.hour === 0 ? 24 : c.hour, n);
        break;
      case 'K':
        out += pad(c.hour % 12, n);
        break;
      case 'h':
        out += pad(c.hour % 12 === 0 ? 12 : c.hour % 12, n);
        break;
      case 'm':
        out += pad(c.minute, n);
        break;
      case 's':
        out += pad(c.second, n);
        break;
      case 'S':
        out += pad(c.millisecond, n);
        break;
      case 'z':
        out += zoneName(zone, time, n >= 4);
        break;
      case 'Z':
      case 'X': {
        const offset = zone.offset(time) / MINUTE;
        if (ch === 'X' && offset === 0) {
          out += 'Z';
          break;
        }
        const abs = Math.abs(offset);
        const hh = String(Math.floor(abs / 60)).padStart(2, '0');
        const mm = String(abs % 60).padStart(2, '0');
        const sign = offset < 0 ? '-' : '+';
        out +=
          ch === 'Z'
            ? `${sign}${hh}${mm}`
            : n === 1
              ? `${sign}${hh}`
              : n === 2
                ? `${sign}${hh}${mm}`
                : `${sign}${hh}:${mm}`;
        break;
      }
      default:
        out += ch.repeat(n);
    }
  }
  return out;
}

/** str.format_time()'s default format: ISO 8601 with the offset ("2010-07-18T00:00:00+0000"). */
export const ISO_FORMAT = "yyyy-MM-dd'T'HH:mm:ssZ";

// ---- sessions ----

/** One period of a session string, in local minutes, and the days it trades. */
interface SessionPeriod {
  start: number;
  end: number;
  /** Pine's day numbers, 1 (Sunday) … 7 (Saturday), that have this period. */
  days: ReadonlySet<number>;
}

const sessions = new Map<string, SessionPeriod[] | null>();

/**
 * A session string (Pine docs, Sessions: Session strings): "0930-1600", "0930-1600:23456",
 * "1700-1700:23456" (an overnight session belongs to the day it ends on), "0000-0000" or
 * "24x7" for the whole day, periods joined by commas. Null when it isn't one.
 */
export function parseSession(text: string): SessionPeriod[] | null {
  const cached = sessions.get(text);
  if (cached !== undefined) return cached;
  const t = text.trim();
  let parsed: SessionPeriod[] | null = [];
  if (/^24x7$/i.test(t)) parsed = [{ start: 0, end: 0, days: new Set([1, 2, 3, 4, 5, 6, 7]) }];
  else {
    // "<periods>:<days>": the days, given once at the end, are every period's.
    const [periods = '', daysText = '1234567', extra] = t.split(':');
    if (extra !== undefined || !/^[1-7]+$/.test(daysText)) parsed = null;
    const days = new Set(daysText.split('').map(Number));
    for (const part of periods.split(',')) {
      if (!parsed) break;
      const match = /^\s*(\d{2})(\d{2})-(\d{2})(\d{2})\s*$/.exec(part);
      const start = match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
      const end = match ? Number(match[3]) * 60 + Number(match[4]) : Number.NaN;
      if (!(start <= 24 * 60 && end <= 24 * 60)) parsed = null;
      else parsed.push({ start, end, days });
    }
  }
  sessions.set(text, parsed);
  return parsed;
}

/**
 * The opening time of the session period holding `ms`, or NaN when `ms` falls outside every
 * period: an overnight period opens the evening before the day it belongs to.
 */
export function sessionOpen(periods: readonly SessionPeriod[], ms: number, zone: Zone): number {
  const offset = zone.offset(ms);
  const local = ms + offset;
  const day = Math.floor(local / DAY);
  const minutes = (local - day * DAY) / MINUTE;
  const weekday = (d: number) => ((((d + 4) % 7) + 7) % 7) + 1;
  for (const { start, end, days } of periods) {
    if (start === 0 && end === 0) {
      // "0000-0000": the whole calendar day (another equal pair, like "1700-1700", is 24 hours
      // from the evening before: Pine docs, Sessions).
      if (days.has(weekday(day))) return day * DAY - offset;
      continue;
    }
    if (start < end) {
      if (minutes >= start && minutes < end && days.has(weekday(day)))
        return day * DAY + start * MINUTE - offset;
      continue;
    }
    // Overnight: from `start` on the day before to `end` on the session's day.
    if (minutes >= start && days.has(weekday(day + 1))) return day * DAY + start * MINUTE - offset;
    if (minutes < end && days.has(weekday(day))) return (day - 1) * DAY + start * MINUTE - offset;
  }
  return Number.NaN;
}

// ---- timeframes ----

/**
 * A timeframe string ("1", "60", "D", "1D", "W", "3M", "1S"), or the chart's own for "" (Pine
 * docs, Timeframes: Timeframe string specifications); null when it isn't one.
 */
export function timeframeOf(text: string, chart: Resolution): Resolution | null {
  if (text === '') return chart;
  return parseResolution(text);
}

/** Seconds in a month for timeframe.in_seconds(): 365/12 days (the v6 reference). */
const MONTH_SECONDS = 2_628_003;

/** timeframe.in_seconds(); na for ticks, which have no length of their own. */
export function secondsOf(resolution: Resolution): number {
  const ms = resolutionDurationMs(resolution);
  if (ms !== null) return ms / 1000;
  if (resolution.unit === 'month') return resolution.count * MONTH_SECONDS;
  return Number.NaN;
}

/**
 * timeframe.from_seconds() (the v6 reference): the timeframe of that many seconds, else the next
 * longer one ("5S" for 2 to 5 seconds, "7D" for 604,799); of two the longer unit ("1W", not
 * "7D"); "12M" above 366 days.
 */
export function fromSeconds(seconds: number): string {
  const s = Math.ceil(seconds);
  if (!(s > 1)) return '1S';
  if (s < 60) {
    for (const n of [5, 10, 15, 30, 45]) if (s <= n) return `${n}S`;
    return '1';
  }
  if (s < 86_400) return String(Math.ceil(s / 60));
  if (s > 31_622_400) return '12M';
  if (s % MONTH_SECONDS === 0) return `${s / MONTH_SECONDS}M`;
  if (s % 604_800 === 0) return `${s / 604_800}W`;
  const days = Math.ceil(s / 86_400);
  return days <= 365 ? `${days}D` : '12M';
}

export const timeframeText = formatResolution;

/**
 * The opening and closing times (ms) of the `resolution` bar holding the bar opened at `ms`,
 * on the chart's clock (crypto's UTC bars, or a market's sessions).
 */
export function barOf(clock: BarClock, resolution: Resolution, ms: number): [number, number] {
  const open = clock.open(resolution, ms);
  return [open, clock.close(resolution, open)];
}
