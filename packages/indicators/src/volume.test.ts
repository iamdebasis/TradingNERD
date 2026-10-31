import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { IndicatorRun } from './run.ts';
import { defaultSettings } from './settings.ts';
import { type InputValue, indicatorTitle, type SymbolContext } from './types.ts';
import { VOLUME } from './volume.ts';

const bar = (time: number, open: number, close: number, volume: number): Bar => ({
  time,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume,
});

const BARS = [
  bar(1, 10, 11, 100), // up
  bar(2, 11, 10.5, 200), // down, and below the close before
  bar(3, 10.5, 10.5, 300), // flat
  bar(4, 10.2, 10.4, 400), // up on its open, below the close before
];

function volumeRun(symbol: SymbolContext, inputs: Record<string, InputValue> = {}) {
  const run = new IndicatorRun(VOLUME, { ...defaultSettings(VOLUME).inputs, ...inputs }, symbol);
  run.setBars(BARS);
  return run;
}

describe("TradingView's Volume", () => {
  it('shows each bar’s traded volume', () => {
    expect(volumeRun({ base: 'XRP', hasVolume: true }).values[0]).toEqual([100, 200, 300, 400]);
  });

  it('colors a bar growing when it closed at or above its open', () => {
    expect(volumeRun({ base: 'XRP', hasVolume: true }).growing).toEqual([true, false, true, true]);
  });

  it('with "Color based on previous close", against the close before it', () => {
    const run = volumeRun({ base: 'XRP', hasVolume: true }, { previousClose: true });
    expect(run.growing).toEqual([true, false, true, false]);
  });

  it('its MA is the SMA of the volume, 20 bars by default and hidden', () => {
    const run = volumeRun({ base: 'XRP', hasVolume: true }, { maLength: 2 });
    expect(run.values[1]).toEqual([Number.NaN, 150, 250, 350]);
    expect(defaultSettings(VOLUME).inputs.maLength).toBe(20);
    expect(defaultSettings(VOLUME).styles.ma?.visible).toBe(false);
  });

  it('has no values where the symbol has no real volume (market caps, formulas)', () => {
    const run = volumeRun({ base: 'CRYPTOCAP', hasVolume: false });
    expect(run.values[0]?.every(Number.isNaN)).toBe(true);
    expect(run.values[1]?.every(Number.isNaN)).toBe(true);
  });

  it('is titled "Vol · " and the base asset, as in TradingView’s legend, with no inputs', () => {
    const xrp = { base: 'XRP', hasVolume: true };
    expect(indicatorTitle(VOLUME, defaultSettings(VOLUME).inputs, xrp)).toBe('Vol · XRP');
    expect(VOLUME.legendInputs(defaultSettings(VOLUME).inputs)).toBe('');
  });
});
