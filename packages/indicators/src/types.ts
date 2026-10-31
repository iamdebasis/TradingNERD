import type { Bar } from '@tradingnerd/core';

/** The built-in indicators we have, by TradingView's own names (docs/SPEC.md §5.15). */
export type IndicatorKind = 'volume' | 'rsi';

/** What a definition is of: a built-in, or a Pine script (packages/pine, §5.16). */
export type DefinitionKind = IndicatorKind | 'script';

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
  /** A script's input: the (i) icon's text beside it. */
  tooltip?: string;
  /** A script's input: inputs with the same `inline` share a row. */
  inline?: string;
  /** Greyed out unless this holds, as TradingView greys BB StdDev unless the type uses it. */
  enabledWhen?: (inputs: Inputs) => boolean;
}

export type InputSpec =
  | (InputBase & { kind: 'int'; default: number; min: number; max: number })
  | (InputBase & { kind: 'float'; default: number; min: number; max: number; step: number })
  | (InputBase & { kind: 'source'; default: SourceName })
  | (InputBase & { kind: 'select'; default: string; options: readonly string[] })
  | (InputBase & { kind: 'bool'; default: boolean })
  /** A script's free text (input.string without options). */
  | (InputBase & { kind: 'string'; default: string })
  /** A script's color (input.color): Pine's packed color, red to transparency (packages/pine). */
  | (InputBase & { kind: 'color'; default: number })
  /** A script's input.int or input.float with options: a menu of numbers. */
  | (InputBase & { kind: 'numbers'; default: number; options: readonly number[] });

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
  /** A gradient fill's color at its bottom value (`color` is the one at its top). */
  bottomColor?: string;
  /** 0–1: the opacity of `bottomColor`. */
  bottomOpacity?: number;
}

export interface PlotSpec {
  id: string;
  /** Its name in the Style tab and the legend. */
  title: string;
  kind: 'line' | 'columns';
  style: StyleValue;
  /** Whether it exists for these inputs (Bollinger Bands only with that smoothing type). */
  shownWhen?: (inputs: Inputs) => boolean;
  /** A script's plot: how Pine's plot() arguments draw it (docs/SPEC.md §6.17). */
  look?: PlotLook;
}

/** Pine's plot.style_* (the v6 reference). */
export type PinePlotStyle =
  | 'line'
  | 'linebr'
  | 'stepline'
  | 'stepline_diamond'
  | 'steplinebr'
  | 'histogram'
  | 'cross'
  | 'area'
  | 'areabr'
  | 'columns'
  | 'circles';

/** Pine's display.* flags: where an output shows (the v6 reference). */
export const PINE_DISPLAY = {
  pane: 1,
  dataWindow: 2,
  statusLine: 4,
  priceScale: 8,
} as const;

/** What a script's plot() says beyond its style (packages/pine's ScriptPlot). */
export interface PlotLook {
  style: PinePlotStyle;
  /** Its color changes from bar to bar: the run has one per bar. */
  colorChanges: boolean;
  /** Bars it's drawn shifted by, to the right when positive. */
  offset: number;
  /** Only its last this many bars are drawn; null for all. */
  showLast: number | null;
  /** A dotted line across the pane at its latest value. */
  trackprice: boolean;
  /** Where histograms, columns and areas start from. */
  histbase: number;
  /** Pine's display flags (PINE_DISPLAY). */
  display: number;
  /** Shown in the Style tab. */
  editable: boolean;
}

/** A horizontal line at a fixed value, Pine's `hline`. */
export interface LevelSpec {
  id: string;
  title: string;
  style: StyleValue & { value: number };
  /** A script's hline: Pine's display flags, and whether the Style tab shows it. */
  display?: number;
  editable?: boolean;
}

/**
 * One edge of a fill: a level or a plot by id, or a fixed value (Pine's hidden `plot(50)` that
 * RSI's gradient fills reach to).
 */
export type FillEdge = string | number;

/**
 * Pine's gradient fill, `fill(plot1, plot2, top_value, bottom_value, top_color, bottom_color)`
 * (TradingView's blog, "Pine Script vertical gradients", 2022): the color runs from the style's
 * `color` at `top` to its `bottomColor` at `bottom`, and the two edges mask which part shows.
 */
export interface FillGradient {
  top: number;
  bottom: number;
}

/** A fill between two levels or two plots, Pine's `fill`. */
export interface FillSpec {
  id: string;
  title: string;
  between: readonly [FillEdge, FillEdge];
  style: StyleValue;
  gradient?: FillGradient;
  shownWhen?: (inputs: Inputs) => boolean;
  /** A script's fill whose color changes from bar to bar: the run has one per bar. */
  colorChanges?: boolean;
  /** A script's fill: Pine's display flags, and whether the Style tab shows it. */
  display?: number;
  editable?: boolean;
}

/**
 * A script's bgcolor(): a color behind each bar, the pane's full height (Pine docs, Backgrounds).
 * Its colors are the run's, bar by bar.
 */
export interface BackgroundSpec {
  id: string;
  title: string;
  /** Shown or not, by the Style tab (its color is the script's). */
  style: StyleValue;
  /** Bars it's drawn shifted by. */
  offset: number;
  showLast: number | null;
  display: number;
  editable: boolean;
}

/**
 * How an indicator's values are written: fixed decimals, or thousands to trillions (with at
 * most `decimals` decimals, two unless the Style tab's Precision says otherwise).
 */
export type ValueFormat =
  | { kind: 'decimals'; decimals: number }
  | { kind: 'volume'; decimals?: number }
  /** A script's format.percent: decimals, then "%". */
  | { kind: 'percent'; decimals: number };

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
 * Where a new instance goes: a pane of its own below the chart, Volume's place at the bottom of
 * the price pane on a scale of its own (TradingView's built-in Volume, §4.15), or the price pane
 * on the candles' own scale (a script's `overlay = true`).
 */
export type Placement = 'pane' | 'volume' | 'price';

/** A built-in indicator, as TradingView defines it, or a Pine script as it reads. */
export interface IndicatorDefinition {
  kind: DefinitionKind;
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
  /** A script's bgcolor() calls. */
  backgrounds?: readonly BackgroundSpec[];
  /**
   * A script's: its settings keep only the styles the Style tab changed, so the rest follows its
   * code (a color from an input, say); a built-in's keep every style.
   */
  styleOverrides?: boolean;
  /** The legend's name before its inputs: the short name ("RSI"), or Volume's "Vol · XRP". */
  legendName(symbol: SymbolContext): string;
  /**
   * The inputs TradingView's legend writes after the name ("14 close"), '' for none: the ones
   * its Pine code doesn't hide with `display = display.none`.
   */
  legendInputs(inputs: Inputs): string;
  create(inputs: Inputs, symbol: SymbolContext): IndicatorCalculator;
  /**
   * Bars from the first one loaded before a plot's value no longer depends on older bars we
   * haven't loaded (§6.16, the warm-up rule). Infinity when the plot never shows.
   */
  settledFrom(plotId: string, inputs: Inputs): number;
}

/** The legend's whole title: its name, then the inputs it shows ("RSI 14 close", "Vol · XRP"). */
export function indicatorTitle(
  definition: IndicatorDefinition,
  inputs: Inputs,
  symbol: SymbolContext,
): string {
  const shown = definition.legendInputs(inputs);
  const name = definition.legendName(symbol);
  return shown === '' ? name : `${name} ${shown}`;
}
