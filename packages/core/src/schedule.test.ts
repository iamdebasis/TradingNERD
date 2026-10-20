import { describe, expect, it } from 'vitest';
import { MarketSchedule, parseMarketSchedule } from './schedule.ts';
import { NYSE_2026 } from './testing.ts';
import { dateOf, dayOf } from './timezone.ts';

const nyse = new MarketSchedule(NYSE_2026);
const at = (iso: string) => Date.parse(iso);

describe('a market schedule', () => {
  it('trades on weekdays that are not holidays', () => {
    expect(nyse.isTradingDay(dayOf('2026-10-19'))).toBe(true); // Monday
    expect(nyse.isTradingDay(dayOf('2026-10-17'))).toBe(false); // Saturday
    expect(nyse.isTradingDay(dayOf('2026-10-18'))).toBe(false); // Sunday
    expect(nyse.isTradingDay(dayOf('2026-11-26'))).toBe(false); // Thanksgiving
    // Beyond the calendar, every weekday trades.
    expect(nyse.isTradingDay(dayOf('2027-01-01'))).toBe(true);
  });

  it('knows regular and extended hours, early closes included', () => {
    expect(nyse.hours(dayOf('2026-10-19'), 'regular')).toEqual([570, 960]);
    expect(nyse.hours(dayOf('2026-10-19'), 'extended')).toEqual([240, 1200]);
    expect(nyse.hours(dayOf('2026-11-27'), 'regular')).toEqual([570, 780]);
    expect(nyse.hours(dayOf('2026-11-27'), 'extended')).toEqual([240, 1020]);
    expect(nyse.hours(dayOf('2026-11-26'), 'regular')).toBeNull();
    expect(nyse.boundaryMinutes).toBe(30);
  });

  it('gives sessions as instants, in New York time whatever the season', () => {
    expect(nyse.session(dayOf('2026-10-19'), 'regular')).toEqual({
      day: dayOf('2026-10-19'),
      open: at('2026-10-19T13:30:00Z'),
      close: at('2026-10-19T20:00:00Z'),
    });
    expect(nyse.session(dayOf('2026-11-27'), 'regular')).toMatchObject({
      open: at('2026-11-27T14:30:00Z'),
      close: at('2026-11-27T18:00:00Z'),
    });
    expect(nyse.session(dayOf('2026-10-19'), 'extended')).toMatchObject({
      open: at('2026-10-19T08:00:00Z'),
      close: at('2026-10-20T00:00:00Z'),
    });
  });

  it('finds the session holding a moment, or the last one before it', () => {
    const dayAt = (iso: string, hours: 'regular' | 'extended' = 'regular') =>
      dateOf(nyse.sessionAtOrBefore(at(iso), hours).day);
    expect(dayAt('2026-10-19T15:00:00Z')).toBe('2026-10-19'); // in the session
    expect(dayAt('2026-10-19T21:00:00Z')).toBe('2026-10-19'); // after the close
    expect(dayAt('2026-10-19T12:00:00Z')).toBe('2026-10-16'); // before Monday's open
    expect(dayAt('2026-10-19T12:00:00Z', 'extended')).toBe('2026-10-19'); // in pre-market
    expect(dayAt('2026-10-18T15:00:00Z')).toBe('2026-10-16'); // Sunday
    expect(dayAt('2026-11-26T17:00:00Z')).toBe('2026-11-25'); // Thanksgiving
    // 23:00 UTC on the 19th is 19:00 in New York: after-hours of the 19th.
    expect(dayAt('2026-10-19T23:00:00Z', 'extended')).toBe('2026-10-19');
  });

  it('steps between trading days over weekends and holidays', () => {
    expect(dateOf(nyse.sessionAfter(dayOf('2026-11-25'), 'regular').day)).toBe('2026-11-27');
    expect(dateOf(nyse.sessionAfter(dayOf('2026-10-16'), 'regular').day)).toBe('2026-10-19');
    expect(dateOf(nyse.tradingDayFrom(dayOf('2026-10-17')))).toBe('2026-10-19');
    expect(dateOf(nyse.tradingDayFrom(dayOf('2026-10-19')))).toBe('2026-10-19');
    expect(dateOf(nyse.tradingDayBefore(dayOf('2026-11-27')))).toBe('2026-11-25');
  });

  it('numbers trading days without gaps, and back', () => {
    let previous: number | null = null;
    for (let day = dayOf('2025-12-01'); day <= dayOf('2027-01-31'); day++) {
      if (!nyse.isTradingDay(day)) continue;
      const index = nyse.tradingDayIndex(day);
      if (previous !== null) expect(index).toBe(previous + 1);
      expect(nyse.tradingDayAt(index)).toBe(day);
      previous = index;
    }
    // Days before 1970-01-05 count back from it.
    expect(nyse.tradingDayIndex(dayOf('1970-01-05'))).toBe(0);
    expect(nyse.tradingDayIndex(dayOf('1970-01-02'))).toBe(-1);
    expect(dateOf(nyse.tradingDayAt(-1))).toBe('1970-01-02');
  });
});

describe('parsing a schedule', () => {
  it('accepts a valid one, sorting its holidays', () => {
    const shuffled = { ...NYSE_2026, holidays: [...NYSE_2026.holidays].reverse() };
    expect(parseMarketSchedule(JSON.parse(JSON.stringify(shuffled)))).toEqual(NYSE_2026);
  });

  it('rejects anything malformed', () => {
    const broken: unknown[] = [
      null,
      { ...NYSE_2026, timezone: 'Mars/Olympus_Mons' },
      { ...NYSE_2026, regular: [960, 570] },
      { ...NYSE_2026, extended: [600, 1200] }, // starts after the regular open
      { ...NYSE_2026, from: '2026-13-01' },
      { ...NYSE_2026, holidays: ['26 Nov 2026'] },
      { ...NYSE_2026, special: { '2026-11-27': [570] } },
    ];
    for (const value of broken) expect(parseMarketSchedule(value)).toBeNull();
  });
});
