import { describe, expect, it } from 'vitest';
import { sessionClock, UTC_CLOCK } from './clock.ts';
import type { Bar } from './market.ts';
import { resampleBars, resampleBase } from './resample.ts';
import { parseResolution, type Resolution } from './resolution.ts';
import { MarketSchedule } from './schedule.ts';
import { NYSE_2026 } from './testing.ts';

const nyse = new MarketSchedule(NYSE_2026);
const regular = sessionClock(nyse);
const extended = sessionClock(nyse, 'extended');
const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
};
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString().replace(':00.000', '');
/** The inverse of `iso`. */
const fromIso = (text: string) => Date.parse(text.replace('Z', ':00Z'));

/** Every bar open from `from` while before `to`, stepping with `next`. */
function opens(clock: typeof regular, resolution: Resolution, from: string, to: string): string[] {
  const out: string[] = [];
  for (let open = clock.open(resolution, at(from)); open < at(to); ) {
    out.push(iso(open));
    open = clock.next(resolution, open);
  }
  return out;
}

describe('the UTC clock', () => {
  it('is the crypto bar math, unchanged', () => {
    expect(UTC_CLOCK.continuous).toBe(true);
    expect(UTC_CLOCK.open(r('60'), at('2026-10-19T13:45:00Z'))).toBe(at('2026-10-19T13:00:00Z'));
    expect(UTC_CLOCK.next(r('60'), at('2026-10-19T13:00:00Z'))).toBe(at('2026-10-19T14:00:00Z'));
    expect(UTC_CLOCK.isOpen(at('2026-10-18T03:00:00Z'))).toBe(true);
  });
});

describe('a session clock (NYSE, regular hours)', () => {
  it('starts intraday bars at the 09:30 open, the last one cut short by the close', () => {
    expect(opens(regular, r('60'), '2026-10-19T13:30:00Z', '2026-10-20T00:00:00Z')).toEqual([
      '2026-10-19T13:30Z',
      '2026-10-19T14:30Z',
      '2026-10-19T15:30Z',
      '2026-10-19T16:30Z',
      '2026-10-19T17:30Z',
      '2026-10-19T18:30Z',
      '2026-10-19T19:30Z',
    ]);
    expect(regular.close(r('60'), at('2026-10-19T19:30:00Z'))).toBe(at('2026-10-19T20:00:00Z'));
    expect(regular.close(r('60'), at('2026-10-19T18:30:00Z'))).toBe(at('2026-10-19T19:30:00Z'));
    // 45 minutes: 09:30, 10:15 … 15:30.
    expect(opens(regular, r('45'), '2026-10-19T13:30:00Z', '2026-10-20T00:00:00Z').at(-1)).toBe(
      '2026-10-19T19:30Z',
    );
  });

  it('goes from the last bar of a session to the next session, over weekends and holidays', () => {
    expect(regular.next(r('60'), at('2026-10-16T19:30:00Z'))).toBe(at('2026-10-19T13:30:00Z'));
    expect(regular.next(r('1'), at('2026-11-25T20:59:00Z'))).toBe(at('2026-11-27T14:30:00Z'));
  });

  it('puts a moment between sessions in the last bar before it', () => {
    expect(regular.open(r('60'), at('2026-10-17T15:00:00Z'))).toBe(at('2026-10-16T19:30:00Z'));
    expect(regular.open(r('5'), at('2026-10-19T12:00:00Z'))).toBe(at('2026-10-16T19:55:00Z'));
    expect(regular.open(r('15'), at('2026-10-19T14:44:59Z'))).toBe(at('2026-10-19T14:30:00Z'));
  });

  it('follows early closes and both sides of the clock change', () => {
    // 27 November: 09:30–13:00 EST, so the last hour bar is 12:30–13:00.
    expect(opens(regular, r('60'), '2026-11-27T14:30:00Z', '2026-11-28T00:00:00Z').at(-1)).toBe(
      '2026-11-27T17:30Z',
    );
    expect(regular.close(r('60'), at('2026-11-27T17:30:00Z'))).toBe(at('2026-11-27T18:00:00Z'));
    // The Friday before the switch opens at 13:30 UTC, the Monday after at 14:30.
    expect(regular.open(r('1D'), at('2026-10-30T15:00:00Z'))).toBe(at('2026-10-30T13:30:00Z'));
    expect(regular.next(r('1D'), at('2026-10-30T13:30:00Z'))).toBe(at('2026-11-02T14:30:00Z'));
  });

  it('times day, week and month bars at their first session open', () => {
    expect(regular.open(r('1D'), at('2026-10-19T18:00:00Z'))).toBe(at('2026-10-19T13:30:00Z'));
    expect(regular.close(r('1D'), at('2026-10-19T13:30:00Z'))).toBe(at('2026-10-19T20:00:00Z'));
    expect(regular.next(r('1D'), at('2026-11-25T14:30:00Z'))).toBe(at('2026-11-27T14:30:00Z'));
    // Thanksgiving week: Monday to the Friday half day.
    expect(regular.open(r('1W'), at('2026-11-26T16:00:00Z'))).toBe(at('2026-11-23T14:30:00Z'));
    expect(regular.close(r('1W'), at('2026-11-23T14:30:00Z'))).toBe(at('2026-11-27T18:00:00Z'));
    expect(regular.next(r('1W'), at('2026-11-23T14:30:00Z'))).toBe(at('2026-11-30T14:30:00Z'));
    // Labor Day week starts on the Tuesday.
    expect(regular.open(r('1W'), at('2026-09-10T15:00:00Z'))).toBe(at('2026-09-08T13:30:00Z'));
    // November 2026 starts trading on Monday the 2nd and ends on the 30th.
    expect(regular.open(r('1M'), at('2026-11-15T15:00:00Z'))).toBe(at('2026-11-02T14:30:00Z'));
    expect(regular.close(r('1M'), at('2026-11-02T14:30:00Z'))).toBe(at('2026-11-30T21:00:00Z'));
    expect(regular.next(r('1M'), at('2026-11-02T14:30:00Z'))).toBe(at('2026-12-01T14:30:00Z'));
    // A quarter from October.
    expect(regular.open(r('3M'), at('2026-11-15T15:00:00Z'))).toBe(at('2026-10-01T13:30:00Z'));
  });

  it('groups multi-day bars by trading days', () => {
    const days = opens(regular, r('1D'), '2026-11-16T15:00:00Z', '2026-12-05T00:00:00Z');
    const twoDay = days.map((day) => iso(regular.open(r('2D'), fromIso(day))));
    // Each 2-day bar holds two consecutive trading days, Thanksgiving skipped.
    const groups = new Map<string, number>();
    for (const open of twoDay) groups.set(open, (groups.get(open) ?? 0) + 1);
    expect([...groups.values()].every((count) => count <= 2)).toBe(true);
    for (const open of groups.keys()) {
      const next = regular.next(r('2D'), fromIso(open));
      expect(regular.open(r('2D'), next)).toBe(next);
    }
  });

  it('knows when the market trades', () => {
    expect(regular.isOpen(at('2026-10-19T13:30:00Z'))).toBe(true);
    expect(regular.isOpen(at('2026-10-19T19:59:59Z'))).toBe(true);
    expect(regular.isOpen(at('2026-10-19T20:00:00Z'))).toBe(false);
    expect(regular.isOpen(at('2026-10-17T15:00:00Z'))).toBe(false);
    expect(regular.isOpen(at('2026-10-19T12:00:00Z'))).toBe(false);
    expect(extended.isOpen(at('2026-10-19T12:00:00Z'))).toBe(true);
  });

  it('lets bases nest only where every session boundary is one of theirs', () => {
    expect(regular.nestsIn(r('30'), r('60'))).toBe(true);
    expect(regular.nestsIn(r('15'), r('45'))).toBe(true);
    expect(regular.nestsIn(r('45'), r('90'))).toBe(false); // 09:30 isn't a 45-minute boundary
    expect(regular.nestsIn(r('60'), r('120'))).toBe(false);
    expect(regular.nestsIn(r('30'), r('1D'))).toBe(true);
    expect(regular.nestsIn(r('1D'), r('1W'))).toBe(true);
    expect(regular.nestsIn(r('2D'), r('1W'))).toBe(false);
    expect(resampleBase(r('240'), [r('1'), r('5'), r('15'), r('30'), r('1D')], regular)).toEqual(
      r('30'),
    );
    expect(resampleBase(r('1M'), [r('1'), r('30'), r('1D')], regular)).toEqual(r('1D'));
  });
});

describe('an extended-hours session clock', () => {
  it('starts intraday bars at the 04:00 pre-market open and ends them at 20:00', () => {
    const hours = opens(extended, r('60'), '2026-10-19T08:00:00Z', '2026-10-20T08:00:00Z');
    expect(hours[0]).toBe('2026-10-19T08:00Z'); // 04:00 New York
    expect(hours.at(-1)).toBe('2026-10-19T23:00Z'); // 19:00 New York
    expect(hours).toHaveLength(16);
    // Day bars stay the regular sessions.
    expect(extended.open(r('1D'), at('2026-10-19T12:00:00Z'))).toBe(at('2026-10-16T13:30:00Z'));
  });
});

describe('resampling with a session clock', () => {
  const bar = (time: string, close: number, volume = 1): Bar => ({
    time: at(time) / 1000,
    open: close,
    high: close,
    low: close,
    close,
    volume,
  });

  it('folds 30-minute bars into session-aligned hours', () => {
    const bars = [
      bar('2026-10-19T13:30:00Z', 10),
      bar('2026-10-19T14:00:00Z', 11),
      bar('2026-10-19T19:00:00Z', 12),
      bar('2026-10-19T19:30:00Z', 13),
      bar('2026-10-20T13:30:00Z', 14),
    ];
    expect(resampleBars(bars, r('60'), regular).map((b) => [iso(b.time * 1000), b.close])).toEqual([
      ['2026-10-19T13:30Z', 11],
      ['2026-10-19T18:30Z', 12],
      ['2026-10-19T19:30Z', 13],
      ['2026-10-20T13:30Z', 14],
    ]);
  });

  it('folds days into weeks timed at their first session', () => {
    const days = ['2026-11-23T14:30:00Z', '2026-11-24T14:30:00Z', '2026-11-27T14:30:00Z'];
    const week = resampleBars(
      days.map((day, i) => bar(day, 20 + i, 100)),
      r('1W'),
      regular,
    );
    expect(week).toEqual([
      {
        time: at('2026-11-23T14:30:00Z') / 1000,
        open: 20,
        high: 22,
        low: 20,
        close: 22,
        volume: 300,
      },
    ]);
  });
});
