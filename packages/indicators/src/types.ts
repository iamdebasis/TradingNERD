import type { Bar } from '@tradingnerd/core';

/** The built-in indicators we have, by TradingView's own names (docs/SPEC.md §5.15). */
export type IndicatorKind = 'volume' | 'rsi';

/** TradingView's price sources for an indicator's "Source" input. */
export const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'] as const;
export type SourceName = (typeof SOURCES)[number];

export const isSourceName = (value: unknown): value is SourceName =>
  SOURCES.includes(value as SourceName);

/** A bar's value for a source, as Pine defines hl2, hlc3, ohlc4 and hlcc4. */
export function sourceValue(bar: Bar, source: SourceName): number {
  switch (source) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'close':
      return bar.close;
    case 'hl2':
      return (bar.high + bar.low) / 2;
    case 'hlc3':
      return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
    case 'hlcc4':
      return (bar.high + bar.low + bar.close + bar.close) / 4;
  }
}

export type InputValue = number | string | boolean;
export type Inputs = Readonly<Record<string, InputValue>>;

interface InputBase {
  id: string;
  /** The label in the Inputs tab, as TradingView words it. */
  title: string;
  /** The heading it sits under in the Inputs tab, if any. */
  group?: string;
  /** Greyed out unless this holds, as TradingView greys BB StdDev unless the type uses it. */
  enabledWhen?: (inputs: Inputs) => boolean;
}

export type InputSpec =
  | (InputBase & { kind: 'int'; default: number; min: number; max: number })
  | (InputBase & { kind: 'float'; default: number; min: number; max: number; step: number })
  | (InputBase & { kind: 'source'; default: SourceName })
  | (InputBase & { kind: 'select'; default: string; options: readonly string[] })
  | (InputBase & { kind: 'bool'; default: boolean });

/** How a line or level is drawn. */
export type LineDash = 'solid' | 'dashed' | 'dotted';

/** One plot's, level's or fill's look, as the Style tab sets it. */
export interface StyleValue {
  visible: boolean;
  /** "#RRGGBB" */
  color: string;
  /** 0–1: TradingView's opacity (100 − its transparency). */
  opacity: number;
  /** Line width in px, 1–4 (plots and levels). */
  width?: number;
  dash?: LineDash;
  /** A level's price (levels only). */
  value?: number;
  /** Columns colored by direction: the falling color (the growing one is `color`). */
  fallingColor?: string;
}

export interface PlotSpec {
  id: string;
  /** Its name in the Style tab and the legend. */
  title: string;
  kind: 'line' | 'columns';
  style: StyleValue;
  /** Whether it exists for these inputs (Bollinger Bands only with that smoothing type). */
  shownWhen?: (inputs: Inputs) => boolean;
}

/** A horizontal line at a fixed value, Pine's `hline`. */
export interface LevelSpec {
  id: string;
  title: string;
  style: StyleValue & { value: number };
}

/** A fill between two levels or two plots, Pine's `fill`. */
export interface FillSpec {
  id: string;
  title: string;
  between: readonly [string, string];
  style: StyleValue;
  shownWhen?: (inputs: Inputs) => boolean;
}

/** How an indicator's values are written: fixed decimals, or thousands to trillions. */
export type ValueFormat = { kind: 'decimals'; decimals: number } | { kind: 'volume' };

/** What an indicator needs to know about the chart's symbol. */
export interface SymbolContext {
  /** Its base asset ("XRP"), for Volume's "Vol · XRP". */
  base: string;
  /** Whether its bars carry real traded volume (docs/SPEC.md §6.16). */
  hasVolume: boolean;
}

/** One bar's outputs: a value per plot (NaN where it has none). */
export interface StepResult {
  values: number[];
  /** For columns colored by direction: true when growing. */
  growing?: boolean;
}

/** An indicator's running state over the bars, one bar at a time (see kernels.ts). */
export interface IndicatorCalculator {
  step(bar: Bar, final: boolean): StepResult;
  save(): unknown;
  restore(state: unknown): void;
}

/**
 * Where a new instance goes: a pane of its own below the chart, or Volume's place at the bottom
 * of the price pane on a scale of its own (TradingView's built-in Volume, §4.15).
 */
export type Placement = 'pane' | 'volume';

/** A built-in indicator, as TradingView defines it. */
export interface IndicatorDefinition {
  kind: IndicatorKind;
  /** "Relative Strength Index" */
  name: string;
  /** "RSI" */
  shortName: string;
  /** More words search finds it by. */
  aliases: readonly string[];
  placement: Placement;
  format: ValueFormat;
  inputs: readonly InputSpec[];
  plots: readonly PlotSpec[];
  levels: readonly LevelSpec[];
  fills: readonly FillSpec[];
  /** The legend's title: its short name and the inputs TradingView shows ("RSI 14 close"). */
  title(inputs: Inputs, symbol: SymbolContext): string;
  create(inputs: Inputs, symbol: SymbolContext): IndicatorCalculator;
  /**
   * Bars from the first one loaded before a plot's value no longer depends on older bars we
   * haven't loaded (§6.16, the warm-up rule). Infinity when the plot never shows.
   */
  settledFrom(plotId: string, inputs: Inputs): number;
}
