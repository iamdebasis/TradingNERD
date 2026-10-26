import { describe, expect, it } from 'vitest';
import { INDICATORS, indicatorDefinition, isIndicatorKind, searchIndicators } from './registry.ts';
import { RSI } from './rsi.ts';
import { defaultSettings, sanitizeSettings } from './settings.ts';
import { SOURCES, sourceValue } from './types.ts';
import { VOLUME } from './volume.ts';
import { emaSettling, rmaSettling, settlingBars } from './warmup.ts';

describe('the built-ins', () => {
  it('are listed by name, as the Indicators dialog lists them', () => {
    expect(INDICATORS.map((d) => d.name)).toEqual(['Relative Strength Index', 'Volume']);
    expect(indicatorDefinition('rsi')).toBe(RSI);
    expect(isIndicatorKind('volume')).toBe(true);
    expect(isIndicatorKind('macd')).toBe(false);
  });

  it('are found by the start of any word of their names', () => {
    expect(searchIndicators('rsi').map((d) => d.kind)).toEqual(['rsi']);
    expect(searchIndicators('relative str').map((d) => d.kind)).toEqual(['rsi']);
    expect(searchIndicators('VOL').map((d) => d.kind)).toEqual(['volume']);
    expect(searchIndicators('  ').map((d) => d.kind)).toEqual(['rsi', 'volume']);
    expect(searchIndicators('macd')).toEqual([]);
  });
});

describe('settings', () => {
  it("default to TradingView's", () => {
    expect(defaultSettings(RSI).inputs).toEqual({
      length: 14,
      source: 'close',
      maType: 'SMA',
      maLength: 14,
      bbMult: 2,
    });
    expect(defaultSettings(RSI).styles.upper).toMatchObject({ value: 70, dash: 'dashed' });
    expect(defaultSettings(VOLUME).inputs).toEqual({ maLength: 20, previousClose: false });
  });

  it('from storage fall back to the defaults wherever they are missing or wrong', () => {
    const settings = sanitizeSettings(RSI, {
      inputs: { length: 21.6, source: 'hlc3', maType: 'Kalman', maLength: -5, bbMult: 'x' },
      styles: { rsi: { color: '#abcdef', opacity: 3, width: 9 }, upper: { value: 80 } },
    });
    expect(settings.inputs).toEqual({
      length: 22,
      source: 'hlc3',
      maType: 'SMA',
      maLength: 1,
      bbMult: 2,
    });
    expect(settings.styles.rsi).toEqual({ visible: true, color: '#ABCDEF', opacity: 1, width: 1 });
    expect(settings.styles.upper?.value).toBe(80);
    expect(sanitizeSettings(VOLUME, null)).toEqual(defaultSettings(VOLUME));
  });
});

describe('sources', () => {
  it("are Pine's", () => {
    const bar = { time: 0, open: 1, high: 4, low: 2, close: 3, volume: 0 };
    expect(SOURCES.map((source) => sourceValue(bar, source))).toEqual([1, 4, 2, 3, 3, 3, 2.5, 3]);
  });
});

describe('settling', () => {
  it('counts the bars until older ones weigh under a billionth', () => {
    expect(settlingBars(0.5)).toBe(30);
    expect(rmaSettling(14)).toBe(280);
    expect(emaSettling(200)).toBe(2073);
    expect(settlingBars(0)).toBe(0);
  });
});
