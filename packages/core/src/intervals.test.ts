import { describe, expect, it } from 'vitest';
import {
  compareIntervals,
  INTERVAL_SECTIONS,
  intervalSection,
  menuLabel,
  parseIntervalInput,
  STANDARD_INTERVALS,
  toolbarLabel,
} from './intervals.ts';
import { formatResolution, parseResolution, type Resolution } from './resolution.ts';

const r = (text: string): Resolution => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(`bad resolution ${text}`);
  return resolution;
};

describe('the standard interval list', () => {
  it('is valid, canonical, and already in menu order', () => {
    const parsed = STANDARD_INTERVALS.map(r);
    expect(parsed.map(formatResolution)).toEqual(STANDARD_INTERVALS);
    expect([...parsed].sort(compareIntervals).map(formatResolution)).toEqual(STANDARD_INTERVALS);
  });

  it('walks through the menu sections in order', () => {
    const sections = STANDARD_INTERVALS.map((text) => intervalSection(r(text)));
    expect([...new Set(sections)]).toEqual(INTERVAL_SECTIONS);
  });
});

describe('labels', () => {
  it('writes toolbar labels the way TradingView does', () => {
    const cases: [string, string][] = [
      ['1', '1m'],
      ['5', '5m'],
      ['15', '15m'],
      ['90', '90m'],
      ['60', '1h'],
      ['120', '2h'],
      ['240', '4h'],
      ['480', '8h'],
      ['720', '12h'],
      ['1D', 'D'],
      ['2D', '2D'],
      ['1W', 'W'],
      ['1M', 'M'],
      ['6M', '6M'],
      ['12M', '12M'],
      ['1S', '1s'],
      ['45S', '45s'],
      ['100T', '100T'],
    ];
    for (const [text, label] of cases) expect(toolbarLabel(r(text)), text).toBe(label);
  });

  it('writes menu labels in words, singular for one', () => {
    const cases: [string, string][] = [
      ['1T', '1 tick'],
      ['1000T', '1000 ticks'],
      ['1S', '1 second'],
      ['45S', '45 seconds'],
      ['1', '1 minute'],
      ['45', '45 minutes'],
      ['90', '90 minutes'],
      ['60', '1 hour'],
      ['180', '3 hours'],
      ['1D', '1 day'],
      ['3D', '3 days'],
      ['1W', '1 week'],
      ['1M', '1 month'],
      ['12M', '12 months'],
    ];
    for (const [text, label] of cases) expect(menuLabel(r(text)), text).toBe(label);
  });

  it('files whole hours under Hours and other minute counts under Minutes', () => {
    expect(intervalSection(r('60'))).toBe('hours');
    expect(intervalSection(r('720'))).toBe('hours');
    expect(intervalSection(r('90'))).toBe('minutes');
    expect(intervalSection(r('1W'))).toBe('days');
    expect(intervalSection(r('12M'))).toBe('days');
  });
});

describe('parseIntervalInput', () => {
  it('reads numbers as minutes and letters as units', () => {
    const cases: [string, string][] = [
      ['15', '15'],
      ['15m', '15'],
      [' 5 ', '5'],
      ['1h', '60'],
      ['4H', '240'],
      ['H', '60'],
      ['1D', '1D'],
      ['1d', '1D'],
      ['D', '1D'],
      ['W', '1W'],
      ['2w', '2W'],
      ['M', '1M'],
      ['3M', '3M'],
      ['30s', '30S'],
      ['30S', '30S'],
      ['100t', '100T'],
      ['1440', '1440'],
    ];
    for (const [input, expected] of cases) {
      const parsed = parseIntervalInput(input);
      expect(parsed && formatResolution(parsed), input).toBe(expected);
    }
  });

  it('rejects anything that is not an interval', () => {
    for (const input of [
      '',
      ' ',
      '0',
      '0D',
      '1441',
      '25h',
      '60s',
      '13M',
      '53W',
      'x',
      '5x',
      '1.5',
    ]) {
      expect(parseIntervalInput(input), input).toBeNull();
    }
    for (const input of ['-5', '5 m', 'h1', '12345', '1hh']) {
      expect(parseIntervalInput(input), input).toBeNull();
    }
  });
});
