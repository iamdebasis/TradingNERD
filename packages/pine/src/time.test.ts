import { describe, expect, it } from 'vitest';
import { DEFAULT_SYMBOL } from './runtime.ts';
import { plots } from './testing.ts';
import {
  calendarOf,
  formatDate,
  fromSeconds,
  ISO_FORMAT,
  parseDate,
  parseSession,
  secondsOf,
  sessionOpen,
  weekOfYear,
  zoneOf,
} from './time.ts';

/**
 * Pine's time (Pine docs: Time, Sessions, Timeframes; the v6 reference), on our own examples and
 * the manual's.
 */

const UTC = zoneOf('UTC');
const HOUR = 3_600_000;

describe('time zones', () => {
  it('reads UTC offsets and IANA names, and refuses others', () => {
    const t = Date.UTC(2024, 0, 15, 12, 0);
    expect(zoneOf('UTC+3')?.offset(t)).toBe(3 * HOUR);
    expect(zoneOf('GMT-0530')?.offset(t)).toBe(-5.5 * HOUR);
    expect(zoneOf('UTC+05:30')?.offset(t)).toBe(5.5 * HOUR);
    // New York keeps its daylight saving: −5 h in January, −4 h in July.
    expect(zoneOf('America/New_York')?.offset(t)).toBe(-5 * HOUR);
    expect(zoneOf('America/New_York')?.offset(Date.UTC(2024, 6, 15))).toBe(-4 * HOUR);
    expect(zoneOf('Mars/Olympus')).toBeNull();
  });

  it('gives a moment’s calendar values in a zone, dayofweek 1 being Sunday', () => {
    const t = Date.UTC(2024, 0, 14, 23, 30); // a Sunday, 23:30 UTC
    expect(calendarOf(t, UTC as never)).toMatchObject({ day: 14, hour: 23, weekday: 1 });
    expect(calendarOf(t, zoneOf('UTC+1') as never)).toMatchObject({ day: 15, hour: 0, weekday: 2 });
    // ISO weeks: 2024-12-30 is in week 1 of 2025.
    expect(weekOfYear(2024, 12, 30)).toBe(1);
    expect(weekOfYear(2024, 6, 15)).toBe(24);
  });
});

describe('timestamp() date strings', () => {
  it('reads ISO 8601 and RFC 2822, UTC unless the string gives a zone', () => {
    expect(parseDate('2020-02-20')).toBe(Date.UTC(2020, 1, 20));
    expect(parseDate('2020-02-20T15:30:00+0300')).toBe(Date.UTC(2020, 1, 20, 12, 30));
    expect(parseDate('20 Feb 2020 15:30:00 GMT+0300')).toBe(Date.UTC(2020, 1, 20, 12, 30));
    expect(parseDate('29 Aug 2024')).toBe(Date.UTC(2024, 7, 29));
    expect(parseDate('Feb 01 2020 22:10:05')).toBe(Date.UTC(2020, 1, 1, 22, 10, 5));
    expect(parseDate('yesterday')).toBeNaN();
  });
});

describe('str.format_time', () => {
  it('writes the manual’s examples', () => {
    const t = 1279411200000; // 2010-07-18 00:00 UTC
    expect(formatDate(t, ISO_FORMAT, UTC as never)).toBe('2010-07-18T00:00:00+0000');
    expect(formatDate(t, 'yyyy-MM-dd', UTC as never)).toBe('2010-07-18');
    expect(formatDate(t, 'HH:mm:ss, yyyy-MM-dd', zoneOf('America/New_York') as never)).toBe(
      '20:00:00, 2010-07-17',
    );
    // Java's 12-hour clock writes midnight as 12, as the manual's example shows.
    expect(formatDate(t, 'hh:mm:ss a', UTC as never)).toBe('12:00:00 AM');
  });

  it('writes month and day names, quoted text and offsets', () => {
    const t = Date.UTC(2024, 0, 1, 15, 4, 5, 7);
    expect(formatDate(t, "EEEE, MMMM d 'at' HH:mm:ss.SSS Z", zoneOf('UTC+4') as never)).toBe(
      'Monday, January 1 at 19:04:05.007 +0400',
    );
    expect(formatDate(t, "MMM dd ''yy", UTC as never)).toBe("Jan 01 '24");
  });
});

describe('sessions', () => {
  it('reads session strings and finds a moment’s session open', () => {
    const periods = parseSession('0930-1600:23456');
    expect(periods).toHaveLength(1);
    const monday = Date.UTC(2024, 0, 15);
    expect(sessionOpen(periods ?? [], monday + 10 * HOUR, UTC as never)).toBe(monday + 9.5 * HOUR);
    expect(sessionOpen(periods ?? [], monday + 17 * HOUR, UTC as never)).toBeNaN();
    // Sunday isn't a day of 23456.
    expect(sessionOpen(periods ?? [], monday - 14 * HOUR, UTC as never)).toBeNaN();
    expect(parseSession('9:30-16:00')).toBeNull();
  });

  it('takes an overnight session as belonging to the day it ends on', () => {
    // "1700-1700:23456": Monday's session starts on Sunday at 17:00.
    const periods = parseSession('1700-1700:23456') ?? [];
    const sunday = Date.UTC(2024, 0, 14);
    expect(sessionOpen(periods, sunday + 18 * HOUR, UTC as never)).toBe(sunday + 17 * HOUR);
    expect(sessionOpen(periods, sunday + 10 * HOUR, UTC as never)).toBeNaN();
  });
});

describe('timeframes', () => {
  it('counts a timeframe’s seconds, a month as 2,628,003 (the reference)', () => {
    expect(secondsOf({ count: 1, unit: 'day' })).toBe(86_400);
    expect(secondsOf({ count: 60, unit: 'minute' })).toBe(3_600);
    expect(secondsOf({ count: 1, unit: 'month' })).toBe(2_628_003);
  });

  it('turns seconds into the reference’s timeframes, rounding up', () => {
    expect([1, 3, 61, 604_799, 604_800, 40_000_000].map(fromSeconds)).toEqual([
      '1S',
      '5S',
      '2',
      '7D',
      '1W',
      '12M',
    ]);
  });
});

describe('time in scripts', () => {
  // Hourly bars from 2024-01-14 22:00 UTC (a Sunday).
  const start = Date.UTC(2024, 0, 14, 22) / 1000;
  const bars = Array.from({ length: 6 }, (_, i) => ({
    time: start + i * 3600,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 1,
  }));
  const hourly = { ...DEFAULT_SYMBOL, timeframe: '60' };
  const run = (body: string) => plots(`//@version=6\nindicator("T")\n${body}`, bars, [], hourly);

  it('gives the calendar variables in the exchange’s zone, and hour[1] the bar before’s', () => {
    const [hour, day, before] = run('plot(hour)\nplot(dayofweek)\nplot(hour[1])');
    expect(hour).toEqual([22, 23, 0, 1, 2, 3]);
    expect(day).toEqual([1, 1, 2, 2, 2, 2]);
    expect(before?.slice(1)).toEqual([22, 23, 0, 1, 2]);
  });

  it('works out timestamp() in the exchange’s zone, or the zone given', () => {
    const [a, b, c] = run(
      'plot(timestamp(2024, 1, 15, 0, 0))\nplot(timestamp("UTC+2", 2024, 1, 15, 0, 0))\nplot(timestamp("2024-01-15T00:00:00Z"))',
    );
    expect(a?.[0]).toBe(Date.UTC(2024, 0, 15));
    expect(b?.[0]).toBe(Date.UTC(2024, 0, 14, 22));
    expect(c?.[0]).toBe(Date.UTC(2024, 0, 15));
  });

  it('finds a new day with timeframe.change() and time("D")', () => {
    const [change, day] = run('plot(timeframe.change("D") ? 1 : 0)\nplot(time("D"))');
    expect(change).toEqual([1, 0, 1, 0, 0, 0]);
    expect(day?.[2]).toBe(Date.UTC(2024, 0, 15));
  });

  it('gives na outside a time() session, and the bar’s close with time_close', () => {
    const [inSession, close] = run(
      'plot(na(time(timeframe.period, "0000-0200")) ? 0 : 1)\nplot(time_close - time)',
    );
    expect(inSession).toEqual([0, 0, 1, 1, 0, 0]);
    expect(close?.[0]).toBe(3_600_000);
  });

  it('marks each day’s first and last bars around the clock', () => {
    const [first, last] = run('plot(session.isfirstbar ? 1 : 0)\nplot(session.islastbar ? 1 : 0)');
    expect(first).toEqual([0, 0, 1, 0, 0, 0]);
    expect(last).toEqual([0, 1, 0, 0, 0, 0]);
  });
});
