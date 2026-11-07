import { TimeZone } from '@tradingnerd/core';
import type { LogEntry } from '@tradingnerd/pine';
import { describe, expect, it } from 'vitest';
import {
  logMatcher,
  logTime,
  setStartLabel,
  shownLogs,
  startLabel,
  zonedInstant,
} from './logFormat';

const NEW_YORK = new TimeZone('America/New_York');
const UTC = new TimeZone('Etc/UTC');

const entry = (level: LogEntry['level'], message: string, time = 0): LogEntry => ({
  level,
  message,
  bar: 0,
  time,
  realtime: false,
  line: 1,
});

describe('Pine Logs’ timestamps, as TradingView’s pane writes them (Pine docs, Debugging)', () => {
  it('writes the exchange’s time with its offset, UTC as -00:00', () => {
    // Figure 347 (COMEX, New York in winter) and Figure 348 (Kraken, UTC; a live tick's ms).
    expect(logTime(Date.UTC(2008, 0, 3, 23, 0), NEW_YORK)).toBe('2008-01-03T18:00:00.000-05:00');
    expect(logTime(Date.UTC(2024, 1, 13, 21, 6), UTC)).toBe('2024-02-13T21:06:00.000-00:00');
    expect(logTime(Date.UTC(2024, 1, 13, 21, 11, 36, 508), UTC)).toBe(
      '2024-02-13T21:11:36.508-00:00',
    );
    // Figure 359: New York in summer.
    expect(logTime(Date.UTC(2023, 3, 26, 13, 30), NEW_YORK)).toBe('2023-04-26T09:30:00.000-04:00');
  });

  it('writes the start date’s tag and button as Figures 356 and 357 show them', () => {
    const start = zonedInstant('2024-02-13', '00:00', UTC) as number;
    expect(start).toBe(Date.UTC(2024, 1, 13));
    expect(startLabel(start, UTC)).toBe('February 13, 2024 at 00:00');
    expect(setStartLabel(start, UTC)).toBe('Set Feb 13, 00:00');
    expect(zonedInstant('2024-02-13', '09:30', NEW_YORK)).toBe(Date.UTC(2024, 1, 13, 14, 30));
    expect(zonedInstant('2024-02-13', '25:00', UTC)).toBeNull();
  });
});

describe('Pine Logs’ filters (Figures 353 to 358)', () => {
  const plain = { matchCase: false, wholeWord: false, regex: false };

  it('finds text anywhere, or whole words only, as the manual’s “confirmed” search shows', () => {
    const anywhere = logMatcher({ text: 'confirmed', ...plain });
    const whole = logMatcher({ text: 'confirmed', ...plain, wholeWord: true });
    if (typeof anywhere !== 'function' || typeof whole !== 'function')
      throw new Error('no matcher');
    expect(anywhere('Values (unconfirmed):')).toEqual([[10, 19]]);
    expect(whole('Values (unconfirmed):')).toBeNull();
    expect(whole('Values (confirmed):')).toEqual([[8, 17]]);
    const cased = logMatcher({ text: 'values', ...plain, matchCase: true });
    if (typeof cased !== 'function') throw new Error('no matcher');
    expect(cased('Values (confirmed):')).toBeNull();
  });

  it('takes a regular expression, as the manual’s average search does, and says when it’s broken', () => {
    const text = 'average:\\s*(0\\.[6-9]\\d*|0\\.5\\d*[1-9]\\d*|1\\.0*)';
    const regex = logMatcher({ text, ...plain, regex: true });
    if (typeof regex !== 'function') throw new Error('no matcher');
    expect(regex('ratio: 1\naverage: 0.53425926')).not.toBeNull();
    expect(regex('average: 0.6')).not.toBeNull();
    expect(regex('average: 0.33425926')).toBeNull();
    expect(logMatcher({ text: '(', ...plain, regex: true })).toBe('invalid');
    expect(logMatcher({ text: '', ...plain })).toBeNull();
  });

  it('lists the entries at the levels shown, from the start date, that match', () => {
    const logs = [
      entry('info', 'Values (confirmed)', 1_000),
      entry('error', 'Division by 0', 2_000),
      entry('warning', 'Values (unconfirmed)', 3_000),
    ];
    const all = { info: true, warning: true, error: true };
    expect(shownLogs(logs, all, null, null).map(({ entry }) => entry.level)).toEqual([
      'info',
      'error',
      'warning',
    ]);
    // Figure 358: errors only.
    const errors = { info: false, warning: false, error: true };
    expect(shownLogs(logs, errors, null, null).map(({ entry }) => entry.message)).toEqual([
      'Division by 0',
    ]);
    expect(shownLogs(logs, all, 2_000, null)).toHaveLength(2);
    const matcher = logMatcher({
      text: 'values',
      matchCase: false,
      wholeWord: false,
      regex: false,
    });
    expect(shownLogs(logs, all, null, typeof matcher === 'function' ? matcher : null)).toHaveLength(
      2,
    );
  });
});
