import { describe, expect, it } from 'vitest';
import { DAY_MS, dateOf, dayOf, TimeZone, timeZone, weekdayOf } from './timezone.ts';

const HOUR = 3_600_000;
const NEW_YORK = timeZone('America/New_York');

describe('dates as day numbers', () => {
  it('converts both ways and knows the weekday', () => {
    expect(dayOf('1970-01-01')).toBe(0);
    expect(dayOf('2026-10-19')).toBe(Date.UTC(2026, 9, 19) / DAY_MS);
    expect(dateOf(dayOf('2026-10-19'))).toBe('2026-10-19');
    expect(weekdayOf(dayOf('2026-10-19'))).toBe(1); // a Monday
    expect(weekdayOf(dayOf('2026-10-18'))).toBe(0);
    expect(weekdayOf(dayOf('1969-12-31'))).toBe(3);
    expect(() => dayOf('19 Oct 2026')).toThrow();
  });
});

describe('New York time', () => {
  it('is UTC-4 in summer and UTC-5 in winter', () => {
    expect(NEW_YORK.offset(Date.UTC(2026, 9, 19, 13, 30))).toBe(-4 * HOUR);
    expect(NEW_YORK.offset(Date.UTC(2026, 11, 1, 14, 30))).toBe(-5 * HOUR);
  });

  it('switches at 02:00 local on the official days, to the minute', () => {
    // 8 March 2026: 02:00 EST (07:00 UTC) becomes 03:00 EDT.
    expect(NEW_YORK.offset(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5 * HOUR);
    expect(NEW_YORK.offset(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4 * HOUR);
    // 1 November 2026: 02:00 EDT (06:00 UTC) becomes 01:00 EST.
    expect(NEW_YORK.offset(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4 * HOUR);
    expect(NEW_YORK.offset(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5 * HOUR);
    // An older year follows the rules of its time (2006: first Sunday of April).
    expect(NEW_YORK.offset(Date.UTC(2006, 3, 2, 6, 59))).toBe(-5 * HOUR);
    expect(NEW_YORK.offset(Date.UTC(2006, 3, 2, 7, 0))).toBe(-4 * HOUR);
  });

  it('gives the local date and time of an instant', () => {
    expect(NEW_YORK.local(Date.UTC(2026, 9, 19, 13, 30))).toEqual({
      day: dayOf('2026-10-19'),
      minutes: 9 * 60 + 30,
    });
    // 02:00 UTC on the 20th is still the evening of the 19th in New York.
    expect(NEW_YORK.local(Date.UTC(2026, 9, 20, 2, 0))).toEqual({
      day: dayOf('2026-10-19'),
      minutes: 22 * 60,
    });
  });

  it('finds the instant of a local time, either side of a switch', () => {
    const open = 9 * 60 + 30;
    expect(NEW_YORK.utc(dayOf('2026-10-19'), open)).toBe(Date.UTC(2026, 9, 19, 13, 30));
    expect(NEW_YORK.utc(dayOf('2026-11-02'), open)).toBe(Date.UTC(2026, 10, 2, 14, 30));
    expect(NEW_YORK.utc(dayOf('2026-03-09'), open)).toBe(Date.UTC(2026, 2, 9, 13, 30));
    // On the switch days themselves, after the switch.
    expect(NEW_YORK.utc(dayOf('2026-11-01'), open)).toBe(Date.UTC(2026, 10, 1, 14, 30));
    expect(NEW_YORK.utc(dayOf('2026-03-08'), open)).toBe(Date.UTC(2026, 2, 8, 13, 30));
  });

  it('agrees with Intl at every hour of a year', () => {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
    });
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += HOUR) {
      const { minutes } = NEW_YORK.local(ms);
      const expected = format.format(new Date(ms));
      const pad = (value: number) => String(value).padStart(2, '0');
      const actual = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
      if (actual !== expected) throw new Error(`${new Date(ms).toISOString()}: ${actual}`);
    }
  });

  it('is shared per name, and works for zones without daylight saving', () => {
    expect(timeZone('America/New_York')).toBe(NEW_YORK);
    const utc = new TimeZone('Etc/UTC');
    expect(utc.offset(Date.UTC(2026, 6, 1))).toBe(0);
    expect(utc.utc(dayOf('2026-07-01'), 60)).toBe(Date.UTC(2026, 6, 1, 1, 0));
  });
});
