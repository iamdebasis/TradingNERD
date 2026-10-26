import type { Bar } from '@tradingnerd/core';
import { Sma } from './kernels.ts';
import type {
  IndicatorCalculator,
  IndicatorDefinition,
  Inputs,
  StepResult,
  SymbolContext,
} from './types.ts';

/**
 * TradingView's built-in Volume (docs/SPEC.md §4.15, §5.15). It isn't a Pine script: TradingView
 * draws it at the bottom of the price pane on a scale of its own (Pine FAQ, Charting Library).
 * Columns are growing when the bar closed at or above its open, or with "Color based on previous
 * close" at or above the previous close; its MA is a 20-bar SMA, hidden by default (OANDA's and
 * JYForex's guides). Colors provisional until measured (§11): ours at 50%, as the Charting
 * Library's 50% transparency.
 *
 * Symbols without real traded volume (CRYPTOCAP's market caps, formulas) get no values at all,
 * never their placeholder volumes (§6.16).
 */
class VolumeCalculator implements IndicatorCalculator {
  private readonly hasVolume: boolean;
  private readonly byPreviousClose: boolean;
  private readonly average: Sma;
  private previousClose = Number.NaN;

  constructor(inputs: Inputs, symbol: SymbolContext) {
    this.hasVolume = symbol.hasVolume;
    this.byPreviousClose = inputs.previousClose === true;
    this.average = new Sma(inputs.maLength as number);
  }

  step(bar: Bar, final: boolean): StepResult {
    if (!this.hasVolume) return { values: [Number.NaN, Number.NaN], growing: true };
    // Pine's own test reads "falling when the reference is above the close"; a missing
    // reference (the first bar) counts as growing.
    const reference = this.byPreviousClose ? this.previousClose : bar.open;
    const growing = !(reference > bar.close);
    const average = this.average.next(bar.volume, final);
    if (final) this.previousClose = bar.close;
    return { values: [bar.volume, average], growing };
  }

  save(): unknown {
    return { average: this.average.save(), previousClose: this.previousClose };
  }

  restore(state: unknown): void {
    const s = state as { average: unknown; previousClose: number };
    this.average.restore(s.average);
    this.previousClose = s.previousClose;
  }
}

export const VOLUME: IndicatorDefinition = {
  kind: 'volume',
  name: 'Volume',
  shortName: 'Vol',
  aliases: ['Volume', 'Vol'],
  placement: 'volume',
  format: { kind: 'volume' },
  inputs: [
    { id: 'maLength', kind: 'int', title: 'MA Length', default: 20, min: 1, max: 10000 },
    {
      id: 'previousClose',
      kind: 'bool',
      title: 'Color based on previous close',
      default: false,
    },
  ],
  plots: [
    {
      id: 'volume',
      title: 'Volume',
      kind: 'columns',
      style: { visible: true, color: '#089981', fallingColor: '#F23645', opacity: 0.5 },
    },
    {
      id: 'ma',
      title: 'Volume MA',
      kind: 'line',
      style: { visible: false, color: '#2196F3', opacity: 1, width: 1 },
    },
  ],
  levels: [],
  fills: [],
  title: (_inputs, symbol) => `Vol · ${symbol.base}`,
  create: (inputs, symbol) => new VolumeCalculator(inputs, symbol),
  settledFrom(plotId, inputs) {
    if (plotId === 'volume') return 0;
    if (plotId === 'ma') return (inputs.maLength as number) - 1;
    return Number.POSITIVE_INFINITY;
  },
};
