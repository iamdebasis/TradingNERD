import type { Bar } from '@tradingnerd/core';
import { describe, expect, it } from 'vitest';
import { Ema, Rma, Sma, Stdev, Wma } from './kernels.ts';
import { RSI, RSI_SMOOTHING } from './rsi.ts';
import { IndicatorRun } from './run.ts';
import { defaultSettings } from './settings.ts';
import { type Inputs, indicatorTitle, type SymbolContext } from './types.ts';
import { rmaSettling } from './warmup.ts';

const XRP: SymbolContext = { base: 'XRP', hasVolume: true };

/** Bars closing at `closes`, a day apart, with some volume. */
function bars(closes: readonly number[]): Bar[] {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 86_400,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000 + ((i * 37) % 101),
  }));
}

function rsiRun(closes: readonly number[], inputs: Partial<Record<string, unknown>> = {}) {
  const run = new IndicatorRun(RSI, { ...defaultSettings(RSI).inputs, ...inputs } as Inputs, XRP);
  run.setBars(bars(closes));
  return run;
}

/** A walk with ups and downs, long enough for every average to settle. */
const WALK = Array.from(
  { length: 400 },
  (_, i) => 1.3 * (1 + 0.2 * Math.sin(i * 0.37) + 0.05 * Math.cos(i * 2.1)),
);

describe("TradingView's RSI", () => {
  it("matches Tulip's reference row for RSI 5 (Wilder's averages of gains and losses)", () => {
    const closes = [
      81.59, 81.06, 82.87, 83.0, 83.61, 83.15, 82.84, 83.99, 84.55, 84.36, 85.53, 86.54, 86.89,
      87.77, 87.29,
    ];
    const run = rsiRun(closes, { length: 5, maType: 'None' });
    const rsi = run.values[0] as number[];
    expect(rsi.slice(0, 5).every(Number.isNaN)).toBe(true);
    [72.034, 64.927, 75.936, 79.796, 74.713, 83.033, 87.478, 88.755, 91.483, 78.498].forEach(
      (value, i) => {
        expect(rsi[5 + i]).toBeCloseTo(value, 3);
      },
    );
  });

  it('starts on the 15th bar with its defaults, its MA 13 bars later', () => {
    const run = rsiRun(WALK);
    const [rsi, ma] = run.values as [number[], number[]];
    expect(Number.isNaN(rsi[13] as number)).toBe(true);
    expect(Number.isNaN(rsi[14] as number)).toBe(false);
    expect(Number.isNaN(ma[26] as number)).toBe(true);
    expect(Number.isNaN(ma[27] as number)).toBe(false);
  });

  it('is 100 when nothing fell and 0 when nothing rose', () => {
    const rising = rsiRun(
      Array.from({ length: 30 }, (_, i) => 1 + i),
      { maType: 'None' },
    );
    const falling = rsiRun(
      Array.from({ length: 30 }, (_, i) => 100 - i),
      { maType: 'None' },
    );
    expect(rising.values[0]?.at(-1)).toBe(100);
    expect(falling.values[0]?.at(-1)).toBe(0);
  });

  it('stays between 0 and 100', () => {
    const rsi = rsiRun(WALK).values[0] as number[];
    for (const value of rsi.slice(14)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('computes from the chosen source', () => {
    const run = new IndicatorRun(RSI, { ...defaultSettings(RSI).inputs, source: 'hl2' }, XRP);
    const series = bars(WALK);
    run.setBars(series);
    const byClose = rsiRun(WALK).values[0] as number[];
    // hl2 here is the close (high and low are ±1% around it), so the two agree.
    expect(run.values[0]?.at(-1)).toBeCloseTo(byClose.at(-1) as number, 9);
  });

  describe('its smoothing (the RSI-based MA)', () => {
    const rsi = rsiRun(WALK, { maType: 'None' }).values[0] as number[];
    const smoothBy = (make: () => { next(value: number, final: boolean): number }) => {
      const kernel = make();
      return rsi.map((value) => kernel.next(value, true));
    };

    it.each([
      ['SMA', () => new Sma(14)],
      ['SMA + Bollinger Bands', () => new Sma(14)],
      ['EMA', () => new Ema(14)],
      ['SMMA (RMA)', () => new Rma(14)],
      ['WMA', () => new Wma(14)],
    ] as const)('%s averages the RSI', (type, make) => {
      const ma = rsiRun(WALK, { maType: type }).values[1] as number[];
      const expected = smoothBy(make);
      expect(ma.at(-1)).toBeCloseTo(expected.at(-1) as number, 10);
      expect(ma.findIndex((v) => !Number.isNaN(v))).toBe(
        expected.findIndex((v) => !Number.isNaN(v)),
      );
    });

    it('VWMA weighs each RSI value by its bar’s volume', () => {
      const ma = rsiRun(WALK, { maType: 'VWMA' }).values[1] as number[];
      const volumes = bars(WALK).map((bar) => bar.volume);
      const last = rsi.length - 1;
      let weighted = 0;
      let total = 0;
      for (let i = last - 13; i <= last; i++) {
        weighted += (rsi[i] as number) * (volumes[i] as number);
        total += volumes[i] as number;
      }
      expect(ma.at(-1)).toBeCloseTo(weighted / total, 10);
    });

    it('None has no MA', () => {
      const ma = rsiRun(WALK, { maType: 'None' }).values[1] as number[];
      expect(ma.every(Number.isNaN)).toBe(true);
    });

    it('SMA + Bollinger Bands puts bands at BB StdDev deviations around it', () => {
      const run = rsiRun(WALK, { maType: 'SMA + Bollinger Bands', bbMult: 2 });
      const [, ma, upper, lower] = run.values as [number[], number[], number[], number[]];
      const deviation = smoothBy(() => new Stdev(14));
      const i = WALK.length - 1;
      expect(upper[i]).toBeCloseTo((ma[i] as number) + 2 * (deviation[i] as number), 10);
      expect(lower[i]).toBeCloseTo((ma[i] as number) - 2 * (deviation[i] as number), 10);
    });

    it('other types have no bands', () => {
      const run = rsiRun(WALK, { maType: 'SMA' });
      expect(run.values[2]?.every(Number.isNaN)).toBe(true);
    });

    it('lists TradingView’s seven types', () => {
      expect(RSI_SMOOTHING).toEqual([
        'None',
        'SMA',
        'SMA + Bollinger Bands',
        'EMA',
        'SMMA (RMA)',
        'WMA',
        'VWMA',
      ]);
    });
  });

  describe('the warm-up rule', () => {
    const inputs = defaultSettings(RSI).inputs;

    it('settles once the bars we lack weigh under a billionth', () => {
      expect(rmaSettling(14)).toBe(280);
      expect(RSI.settledFrom('rsi', inputs)).toBe(14 + 280);
      expect(RSI.settledFrom('ma', inputs)).toBe(14 + 280 + 13);
    });

    it('the bands settle with the SMA; plots that never show, never', () => {
      expect(RSI.settledFrom('bbUpper', { ...inputs, maType: 'SMA + Bollinger Bands' })).toBe(
        14 + 280 + 13,
      );
      expect(RSI.settledFrom('bbUpper', inputs)).toBe(Number.POSITIVE_INFINITY);
      expect(RSI.settledFrom('ma', { ...inputs, maType: 'None' })).toBe(Number.POSITIVE_INFINITY);
    });

    it('two runs that start 100 bars apart agree, far under a shown digit, once settled', () => {
      const long = rsiRun(WALK).values[0] as number[];
      const short = rsiRun(WALK.slice(100)).values[0] as number[];
      const settled = RSI.settledFrom('rsi', inputs);
      expect(settled).toBeLessThan(short.length);
      for (let i = settled; i < short.length; i++) {
        expect(Math.abs((short[i] as number) - (long[i + 100] as number))).toBeLessThan(1e-6);
      }
      // Before settling they still differ: those are the bars the rule leaves blank.
      expect(Math.abs((short[20] as number) - (long[120] as number))).toBeGreaterThan(1e-6);
    });
  });

  it('is titled as TradingView’s legend writes it: the name, then the inputs it shows', () => {
    const { inputs } = defaultSettings(RSI);
    expect(indicatorTitle(RSI, inputs, XRP)).toBe('RSI 14 close');
    expect(RSI.legendName(XRP)).toBe('RSI');
    expect(RSI.legendInputs({ ...inputs, length: 21, source: 'hl2' })).toBe('21 hl2');
  });

  it("fills beyond 70 and 30 with the built-in's gradients, between the RSI and 50", () => {
    const overbought = RSI.fills.find((fill) => fill.id === 'overbought');
    const oversold = RSI.fills.find((fill) => fill.id === 'oversold');
    expect(overbought).toMatchObject({
      title: 'Overbought Gradient Fill',
      between: ['rsi', 50],
      gradient: { top: 100, bottom: 70 },
      style: { color: '#4CAF50', opacity: 1, bottomColor: '#4CAF50', bottomOpacity: 0 },
    });
    expect(oversold).toMatchObject({
      title: 'Oversold Gradient Fill',
      between: ['rsi', 50],
      gradient: { top: 30, bottom: 0 },
      style: { color: '#F23645', opacity: 0, bottomColor: '#F23645', bottomOpacity: 1 },
    });
    // In the code's order: the background, the two gradients, then the bands' background.
    expect(RSI.fills.map((fill) => fill.id)).toEqual([
      'background',
      'overbought',
      'oversold',
      'bbBackground',
    ]);
  });
});
