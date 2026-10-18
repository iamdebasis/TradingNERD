import { describe, expect, it } from 'vitest';
import {
  barCloseTime,
  barOpenTime,
  formatResolution,
  isIntraday,
  parseResolution,
  type Resolution,
  resolutionDurationMs,
  resolutionLabel,
} from './resolution.ts';

const utc = (iso: string) => Date.parse(`${iso}Z`);
const res = (text: string): Resolution => {
  const parsed = parseResolution(text);
  if (!parsed) throw new Error(`bad resolution ${text}`);
  return parsed;
};

describe('parseResolution', () => {
  it.each([
    ['1', { count: 1, unit: 'minute' }],
    ['15', { count: 15, unit: 'minute' }],
    ['240', { count: 240, unit: 'minute' }],
    ['1440', { count: 1440, unit: 'minute' }],
    ['D', { count: 1, unit: 'day' }],
    ['1D', { count: 1, unit: 'day' }],
    ['3D', { count: 3, unit: 'day' }],
    ['W', { count: 1, unit: 'week' }],
    ['M', { count: 1, unit: 'month' }],
    ['6M', { count: 6, unit: 'month' }],
    ['12M', { count: 12, unit: 'month' }],
    ['1S', { count: 1, unit: 'second' }],
    ['45S', { count: 45, unit: 'second' }],
    ['100T', { count: 100, unit: 'tick' }],
  ])('parses %s', (text, expected) => {
    expect(parseResolution(text)).toEqual(expected);
  });

  it.each(['', 'abc', '0', '0D', '1441', '13M', '60S', 'S', 'T', '1d', '1m', '1h', '-5', '1.5'])(
    'rejects %j',
    (text) => {
      expect(parseResolution(text)).toBeNull();
    },
  );

  it('round-trips through formatResolution', () => {
    for (const text of ['1', '60', '1D', '3D', '1W', '1M', '6M', '1S', '10T']) {
      expect(formatResolution(res(text))).toBe(text);
    }
    expect(formatResolution(res('D'))).toBe('1D');
  });
});

describe('resolutionLabel', () => {
  it.each([
    ['1', '1'],
    ['15', '15'],
    ['90', '90'],
    ['60', '1h'],
    ['240', '4h'],
    ['1D', '1D'],
    ['1W', '1W'],
    ['1M', '1M'],
    ['5S', '5s'],
    ['100T', '100T'],
  ])('labels %s as %s', (text, label) => {
    expect(resolutionLabel(res(text))).toBe(label);
  });
});

describe('durations and intraday', () => {
  it('knows fixed bar lengths', () => {
    expect(resolutionDurationMs(res('15'))).toBe(15 * 60_000);
    expect(resolutionDurationMs(res('1D'))).toBe(86_400_000);
    expect(resolutionDurationMs(res('1W'))).toBe(7 * 86_400_000);
    expect(resolutionDurationMs(res('1M'))).toBeNull();
    expect(resolutionDurationMs(res('10T'))).toBeNull();
  });

  it('marks sub-day intervals as intraday', () => {
    expect(isIntraday(res('1S'))).toBe(true);
    expect(isIntraday(res('720'))).toBe(true);
    expect(isIntraday(res('1D'))).toBe(false);
  });
});

describe('barOpenTime', () => {
  it.each([
    ['15', '2026-10-18T13:37:12', '2026-10-18T13:30:00'],
    ['60', '2026-10-18T13:37:12', '2026-10-18T13:00:00'],
    ['240', '2026-10-18T13:37:12', '2026-10-18T12:00:00'],
    ['1S', '2026-10-18T13:37:12.900', '2026-10-18T13:37:12'],
    ['45', '2026-10-18T23:20:00', '2026-10-18T23:15:00'],
    ['45', '2026-10-18T00:44:59', '2026-10-18T00:00:00'],
    ['1D', '2026-10-18T13:37:12', '2026-10-18T00:00:00'],
    // Binance's 3-day bars opened on 2026-10-10, 10-13 and 10-16.
    ['3D', '2026-10-17T05:00:00', '2026-10-16T00:00:00'],
    ['3D', '2026-10-12T23:59:59', '2026-10-10T00:00:00'],
    // 2026-10-18 is a Sunday: its week opened Monday 2026-10-12.
    ['1W', '2026-10-18T13:37:12', '2026-10-12T00:00:00'],
    ['1W', '2026-10-19T00:00:00', '2026-10-19T00:00:00'],
    ['1M', '2026-10-18T13:37:12', '2026-10-01T00:00:00'],
    ['3M', '2026-02-15T00:00:00', '2026-01-01T00:00:00'],
    ['6M', '2026-10-18T13:37:12', '2026-07-01T00:00:00'],
    ['12M', '2026-10-18T13:37:12', '2026-01-01T00:00:00'],
  ])('%s bar containing %s opens at %s', (text, at, open) => {
    expect(barOpenTime(res(text), utc(at))).toBe(utc(open));
  });

  it('is stable for a bar open time itself', () => {
    const open = utc('2026-10-18T00:00:00');
    expect(barOpenTime(res('1D'), open)).toBe(open);
  });

  it('refuses tick bars', () => {
    expect(() => barOpenTime(res('10T'), 0)).toThrow();
  });
});

describe('barCloseTime', () => {
  it.each([
    ['15', '2026-10-18T13:30:00', '2026-10-18T13:45:00'],
    ['1D', '2026-10-18T00:00:00', '2026-10-19T00:00:00'],
    ['1W', '2026-10-12T00:00:00', '2026-10-19T00:00:00'],
    ['1M', '2026-10-01T00:00:00', '2026-11-01T00:00:00'],
    ['1M', '2026-12-01T00:00:00', '2027-01-01T00:00:00'],
    ['6M', '2026-07-01T00:00:00', '2027-01-01T00:00:00'],
    // The last 45-minute bar of a day is cut at midnight.
    ['45', '2026-10-18T23:15:00', '2026-10-19T00:00:00'],
  ])('%s bar opened %s closes at %s', (text, open, close) => {
    expect(barCloseTime(res(text), utc(open))).toBe(utc(close));
  });
});
