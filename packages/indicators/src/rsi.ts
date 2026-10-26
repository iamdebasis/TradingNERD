import type { Bar } from '@tradingnerd/core';
import { Change, Ema, type Kernel, Rma, Sma, Stdev, Vwma, Wma } from './kernels.ts';
import {
  type IndicatorCalculator,
  type IndicatorDefinition,
  type Inputs,
  type SourceName,
  type StepResult,
  type SymbolContext,
  sourceValue,
} from './types.ts';
import { emaSettling, rmaSettling } from './warmup.ts';

/**
 * TradingView's built-in Relative Strength Index (docs/SPEC.md §4.15, §5.15). Its formula is the
 * built-in's own code:
 *
 *   up = ta.rma(math.max(ta.change(src), 0), length)
 *   down = ta.rma(-math.min(ta.change(src), 0), length)
 *   rsi = down == 0 ? 100 : up == 0 ? 0 : 100 - 100 / (1 + up / down)
 *
 * with its "Smoothing" moving average of the RSI ("RSI-based MA"), and Bollinger Bands around it
 * for "SMA + Bollinger Bands". Defaults: length 14 on close (TradingView's Help Center), smoothing
 * SMA 14, BB StdDev 2 (the built-in's code, as pasted in a public GitHub issue; OANDA's and
 * JYForex's guides agree). Colors: the RSI #7E57C2 (Charting Library); the rest provisional
 * until measured from the user's screenshots (§11).
 */

export const RSI_SMOOTHING = [
  'None',
  'SMA',
  'SMA + Bollinger Bands',
  'EMA',
  'SMMA (RMA)',
  'WMA',
  'VWMA',
] as const;
export type RsiSmoothing = (typeof RSI_SMOOTHING)[number];

const withBands = (inputs: Inputs) => inputs.maType === 'SMA + Bollinger Bands';
const smoothed = (inputs: Inputs) => inputs.maType !== 'None';

/** The smoothing average of the RSI, by type; VWMA weighs by the bar's volume. */
interface Smoothing {
  next(value: number, volume: number, final: boolean): number;
  save(): unknown;
  restore(state: unknown): void;
}

const plain = (kernel: Kernel): Smoothing => ({
  next: (value, _volume, final) => kernel.next(value, final),
  save: () => kernel.save(),
  restore: (state) => kernel.restore(state),
});

function smoothing(type: RsiSmoothing, length: number, hasVolume: boolean): Smoothing | null {
  switch (type) {
    case 'None':
      return null;
    case 'SMA':
    case 'SMA + Bollinger Bands':
      return plain(new Sma(length));
    case 'EMA':
      return plain(new Ema(length));
    case 'SMMA (RMA)':
      return plain(new Rma(length));
    case 'WMA':
      return plain(new Wma(length));
    case 'VWMA': {
      // Without real volume there's nothing to weigh by: no values, as Pine stops there.
      if (!hasVolume) return { next: () => Number.NaN, save: () => null, restore: () => {} };
      const vwma = new Vwma(length);
      return {
        next: (value, volume, final) => vwma.next(value, volume, final),
        save: () => vwma.save(),
        restore: (state) => vwma.restore(state),
      };
    }
  }
}

class RsiCalculator implements IndicatorCalculator {
  private readonly source: SourceName;
  private readonly bandsMultiplier: number;
  private readonly change = new Change();
  private readonly up: Rma;
  private readonly down: Rma;
  private readonly average: Smoothing | null;
  private readonly deviation: Stdev | null;

  constructor(inputs: Inputs, symbol: SymbolContext) {
    const length = inputs.length as number;
    const maLength = inputs.maLength as number;
    this.source = inputs.source as SourceName;
    this.bandsMultiplier = inputs.bbMult as number;
    this.up = new Rma(length);
    this.down = new Rma(length);
    this.average = smoothing(inputs.maType as RsiSmoothing, maLength, symbol.hasVolume);
    this.deviation = withBands(inputs) ? new Stdev(maLength) : null;
  }

  step(bar: Bar, final: boolean): StepResult {
    const change = this.change.next(sourceValue(bar, this.source), final);
    const up = this.up.next(Math.max(change, 0), final);
    const down = this.down.next(-Math.min(change, 0), final);
    const rsi = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
    const ma = this.average ? this.average.next(rsi, bar.volume, final) : Number.NaN;
    const deviation = this.deviation
      ? this.deviation.next(rsi, final) * this.bandsMultiplier
      : Number.NaN;
    return { values: [rsi, ma, ma + deviation, ma - deviation] };
  }

  save(): unknown {
    return {
      change: this.change.save(),
      up: this.up.save(),
      down: this.down.save(),
      average: this.average?.save(),
      deviation: this.deviation?.save(),
    };
  }

  restore(state: unknown): void {
    const s = state as Record<'change' | 'up' | 'down' | 'average' | 'deviation', unknown>;
    this.change.restore(s.change);
    this.up.restore(s.up);
    this.down.restore(s.down);
    this.average?.restore(s.average);
    this.deviation?.restore(s.deviation);
  }
}

const BAND_GRAY = '#787B86';
const BANDS_GREEN = '#4CAF50';

export const RSI: IndicatorDefinition = {
  kind: 'rsi',
  name: 'Relative Strength Index',
  shortName: 'RSI',
  aliases: ['RSI', 'Relative Strength Index'],
  placement: 'pane',
  format: { kind: 'decimals', decimals: 2 },
  inputs: [
    {
      id: 'length',
      kind: 'int',
      title: 'RSI Length',
      group: 'RSI Settings',
      default: 14,
      min: 1,
      max: 2000,
    },
    { id: 'source', kind: 'source', title: 'Source', group: 'RSI Settings', default: 'close' },
    {
      id: 'maType',
      kind: 'select',
      title: 'Type',
      group: 'Smoothing',
      default: 'SMA',
      options: RSI_SMOOTHING,
    },
    {
      id: 'maLength',
      kind: 'int',
      title: 'Length',
      group: 'Smoothing',
      default: 14,
      min: 1,
      max: 10000,
      enabledWhen: smoothed,
    },
    {
      id: 'bbMult',
      kind: 'float',
      title: 'BB StdDev',
      group: 'Smoothing',
      default: 2,
      min: 0.001,
      max: 50,
      step: 0.5,
      enabledWhen: withBands,
    },
  ],
  plots: [
    {
      id: 'rsi',
      title: 'RSI',
      kind: 'line',
      style: { visible: true, color: '#7E57C2', opacity: 1, width: 1 },
    },
    {
      id: 'ma',
      title: 'RSI-based MA',
      kind: 'line',
      // The built-in's color.yellow; reported as orange by one guide: to measure (§11).
      style: { visible: true, color: '#FDD835', opacity: 1, width: 1 },
      shownWhen: smoothed,
    },
    {
      id: 'bbUpper',
      title: 'Upper Bollinger Band',
      kind: 'line',
      style: { visible: true, color: BANDS_GREEN, opacity: 1, width: 1 },
      shownWhen: withBands,
    },
    {
      id: 'bbLower',
      title: 'Lower Bollinger Band',
      kind: 'line',
      style: { visible: true, color: BANDS_GREEN, opacity: 1, width: 1 },
      shownWhen: withBands,
    },
  ],
  levels: [
    {
      id: 'upper',
      title: 'RSI Upper Band',
      style: { visible: true, color: BAND_GRAY, opacity: 1, width: 1, dash: 'dashed', value: 70 },
    },
    {
      id: 'middle',
      title: 'RSI Middle Band',
      style: { visible: true, color: BAND_GRAY, opacity: 0.5, width: 1, dash: 'dashed', value: 50 },
    },
    {
      id: 'lower',
      title: 'RSI Lower Band',
      style: { visible: true, color: BAND_GRAY, opacity: 1, width: 1, dash: 'dashed', value: 30 },
    },
  ],
  fills: [
    {
      id: 'background',
      title: 'RSI Background Fill',
      between: ['upper', 'lower'],
      style: { visible: true, color: '#7E57C2', opacity: 0.1 },
    },
    {
      id: 'bbBackground',
      title: 'Bollinger Bands Background Fill',
      between: ['bbUpper', 'bbLower'],
      style: { visible: true, color: BANDS_GREEN, opacity: 0.1 },
      shownWhen: withBands,
    },
  ],
  title: (inputs) => `RSI ${inputs.length} ${inputs.source}`,
  create: (inputs, symbol) => new RsiCalculator(inputs, symbol),
  settledFrom(plotId, inputs) {
    const length = inputs.length as number;
    const maLength = inputs.maLength as number;
    const rsi = length + rmaSettling(length);
    switch (plotId) {
      case 'rsi':
        return rsi;
      case 'ma':
        switch (inputs.maType as RsiSmoothing) {
          case 'None':
            return Number.POSITIVE_INFINITY;
          case 'EMA':
            return rsi + maLength - 1 + emaSettling(maLength);
          case 'SMMA (RMA)':
            return rsi + maLength - 1 + rmaSettling(maLength);
          default:
            return rsi + maLength - 1;
        }
      case 'bbUpper':
      case 'bbLower':
        return withBands(inputs) ? rsi + maLength - 1 : Number.POSITIVE_INFINITY;
      default:
        return Number.POSITIVE_INFINITY;
    }
  },
};
