import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayOf } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { MarketError } from '../src/market/types.ts';
import type { AlpacaCalendarDay } from '../src/stocks/alpaca.ts';
import { MarketCalendar, scheduleFromCalendar } from '../src/stocks/MarketCalendar.ts';

/** Thanksgiving week 2026 as Alpaca's calendar lists it. */
const THANKSGIVING_WEEK: AlpacaCalendarDay[] = [
  { date: '2026-11-23', open: '09:30', close: '16:00' },
  { date: '2026-11-24', open: '09:30', close: '16:00' },
  { date: '2026-11-25', open: '09:30', close: '16:00' },
  { date: '2026-11-27', open: '09:30', close: '13:00' },
  { date: '2026-11-30', open: '09:30', close: '16:00' },
];

describe("a schedule from Alpaca's calendar", () => {
  it('finds the holidays and early closes', () => {
    expect(scheduleFromCalendar(THANKSGIVING_WEEK)).toEqual({
      timezone: 'America/New_York',
      regular: [570, 960],
      extended: [240, 1200],
      from: '2026-11-23',
      to: '2026-11-30',
      holidays: ['2026-11-26'],
      special: { '2026-11-27': [570, 780] },
    });
    expect(() => scheduleFromCalendar([])).toThrow();
  });
});

describe('the market calendar', () => {
  function setup(
    fetchDays: (from: string, to: string) => Promise<AlpacaCalendarDay[]>,
    dataDir?: string,
  ) {
    const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'tn-calendar-'));
    let now = Date.parse('2026-10-19T12:00:00Z');
    const calls: [string, string][] = [];
    const calendar = new MarketCalendar({
      dataDir: dir,
      fetchDays: (from, to) => {
        calls.push([from, to]);
        return fetchDays(from, to);
      },
      now: () => now,
    });
    return { calendar, calls, dataDir: dir, advance: (ms: number) => (now += ms) };
  }

  it('fetches from 2015 to three years ahead, saves it, and reuses it for a month', async () => {
    const first = setup(async () => THANKSGIVING_WEEK);
    expect(first.calendar.isKnown()).toBe(false);
    await first.calendar.ensure();
    expect(first.calls).toEqual([['2015-01-01', '2029-12-31']]);
    expect(first.calendar.schedule().isTradingDay(dayOf('2026-11-26'))).toBe(false);

    const again = setup(async () => [], first.dataDir);
    await again.calendar.ensure();
    expect(again.calls).toEqual([]);
    expect(again.calendar.schedule().hours(dayOf('2026-11-27'), 'regular')).toEqual([570, 780]);

    again.advance(31 * 86_400_000);
    await again.calendar.ensure().catch(() => {});
    expect(again.calls).toHaveLength(1);
    // The refresh failed (an empty calendar), so the saved one stays.
    expect(again.calendar.isKnown()).toBe(true);
  });

  it('weekdays all trade until a calendar comes, and without a key there is none', async () => {
    const { calendar } = setup(async () => {
      throw new MarketError('needs_key', 'US stock data needs your Alpaca key');
    });
    await expect(calendar.ensure()).rejects.toMatchObject({ code: 'needs_key' });
    expect(calendar.schedule().isTradingDay(dayOf('2026-11-26'))).toBe(true);
  });
});
