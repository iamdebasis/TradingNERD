import type { Bar } from '@tradingnerd/core';
import {
  type BackgroundSpec,
  type BarChange,
  type FillSpec,
  type IndicatorDefinition,
  type IndicatorKind,
  type InputSpec,
  type Inputs,
  type InputValue,
  type LevelSpec,
  PINE_DISPLAY,
  type PlotSpec,
  type StyleValue,
  type ValueFormat,
} from '@tradingnerd/indicators';
import {
  colorHex,
  colorOpacity,
  type InputDef,
  type OutputRef,
  type ScriptDescription,
  type ScriptProgram,
  ScriptRun,
  type ScriptSymbol,
  type Value,
} from '@tradingnerd/pine';

/**
 * A Pine script on the chart (docs/SPEC.md §6.17): its code as it went on, a snapshot that
 * Update on chart replaces, and where it came from.
 */
export interface ChartScript {
  source: string;
  /** The saved script it was added from (data/scripts.json); null for an unsaved draft. */
  scriptId: string | null;
  /** The built-in whose code it started from, if any (the editor's Reset to original). */
  from: IndicatorKind | null;
}

/** What the chart knows of its symbol, for scripts: Pine's syminfo.* and timeframe.*. */
export interface ScriptContext {
  symbol: ScriptSymbol;
  /** Decimals the chart writes prices with: a script's format.inherit and format.price. */
  priceDecimals: number;
}

/** A script input's id in its settings: by its place, as TradingView keys them ("in_0"). */
export const inputId = (index: number) => `in_${index}`;

/** Ids of a script's outputs in its settings' styles, by kind and place. */
export const plotId = (index: number) => `plot_${index}`;
export const hlineId = (index: number) => `hline_${index}`;
export const fillId = (index: number) => `fill_${index}`;
export const backgroundId = (index: number) => `bg_${index}`;

/** The settings' inputs in the script's order: what ScriptProgram takes. */
export function scriptInputs(program: ScriptProgram, inputs: Inputs): Value[] {
  return program.sanitize(program.inputs.map((input) => inputs[inputId(input.index)]));
}

const pane = (display: number) => (display & PINE_DISPLAY.pane) !== 0;

/** A packed color as the Style tab keeps colors: "#RRGGBB" and an opacity. */
function look(color: number | null): Pick<StyleValue, 'color' | 'opacity'> {
  if (color === null) return { color: '#000000', opacity: 0 };
  return { color: colorHex(color), opacity: Math.round(colorOpacity(color) * 1000) / 1000 };
}

/** A Pine input as the Inputs tab shows it. */
function inputSpec(
  input: InputDef,
  enabled: (index: number) => (inputs: Inputs) => boolean,
): InputSpec {
  const base = {
    id: inputId(input.index),
    title: input.title,
    ...(input.group ? { group: input.group } : {}),
    ...(input.tooltip ? { tooltip: input.tooltip } : {}),
    ...(input.inline ? { inline: input.inline } : {}),
    ...(input.active ? { enabledWhen: enabled(input.index) } : {}),
  };
  switch (input.kind) {
    case 'int':
    case 'float':
      if (input.options) {
        return {
          ...base,
          kind: 'numbers',
          default: input.defval as number,
          options: input.options as number[],
        };
      }
      // Pine's own limits are none; its step, when not given, is 1 (provisional, §11).
      return input.kind === 'int'
        ? {
            ...base,
            kind: 'int',
            default: input.defval as number,
            min: input.minval ?? Number.NEGATIVE_INFINITY,
            max: input.maxval ?? Number.POSITIVE_INFINITY,
          }
        : {
            ...base,
            kind: 'float',
            default: input.defval as number,
            min: input.minval ?? Number.NEGATIVE_INFINITY,
            max: input.maxval ?? Number.POSITIVE_INFINITY,
            step: input.step ?? 1,
          };
    case 'bool':
      return { ...base, kind: 'bool', default: input.defval as boolean };
    case 'string':
      return input.options
        ? {
            ...base,
            kind: 'select',
            default: input.defval as string,
            options: input.options as string[],
          }
        : { ...base, kind: 'string', default: input.defval as string };
    case 'color':
      return { ...base, kind: 'color', default: input.defval as number };
    case 'source':
      return { ...base, kind: 'source', default: input.defval as 'close' };
  }
}

/** A fill's edge: the plot's or hline's id in the settings. */
const edgeId = (ref: OutputRef) => (ref.output === 'plot' ? plotId(ref.index) : hlineId(ref.index));

/** An input's value as the legend writes it ("14", "close"); null for one it doesn't show. */
function legendValue(value: Value): string | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

/** The values' format: the script's, at the chart's price decimals where it inherits them. */
function valueFormat(d: ScriptDescription, priceDecimals: number): ValueFormat {
  switch (d.format) {
    case 'volume':
      return d.precision === null ? { kind: 'volume' } : { kind: 'volume', decimals: d.precision };
    case 'percent':
      return { kind: 'percent', decimals: d.precision ?? 2 };
    default:
      return { kind: 'decimals', decimals: d.precision ?? priceDecimals };
  }
}

/**
 * A compiled script as the chart, the legend and the settings dialog read a built-in: its inputs
 * by place ("in_0"), its plots, hlines, fills and backgrounds by kind and place ("plot_0"), as
 * these input values make them. Its settings keep only the looks the Style tab changed, so the
 * rest follows the code (an input's color, say).
 */
export function scriptDefinition(
  program: ScriptProgram,
  inputs: Inputs,
  context: ScriptContext,
): IndicatorDefinition {
  const values = scriptInputs(program, inputs);
  const d = program.describe(values);
  const enabled = (index: number) => (current: Inputs) =>
    program.describe(scriptInputs(program, current)).inputs[index]?.active ?? true;
  const name = d.shorttitle || d.title;
  const plots: PlotSpec[] = d.plots.map((plot, i) => ({
    id: plotId(i),
    // An untitled plot is "Plot" (provisional, §11).
    title: plot.title || 'Plot',
    kind: plot.style === 'histogram' || plot.style === 'columns' ? 'columns' : 'line',
    style: {
      visible: true,
      ...look(plot.colorChanges ? null : plot.color),
      ...(plot.colorChanges ? { color: '#2962FF', opacity: 1 } : {}),
      width: plot.linewidth,
      dash: plot.linestyle,
    },
    // display = display.none: not drawn, not listed (as the built-ins' hidden plots).
    shownWhen: () => plot.display !== 0,
    look: {
      style: plot.style,
      colorChanges: plot.colorChanges,
      offset: plot.offset,
      showLast: plot.showLast,
      trackprice: plot.trackprice,
      histbase: plot.histbase,
      display: plot.display,
      editable: plot.editable,
    },
  }));
  const levels: LevelSpec[] = d.hlines.map((hline, i) => ({
    id: hlineId(i),
    title: hline.title || 'Line',
    style: {
      visible: pane(hline.display),
      ...look(hline.color),
      width: hline.linewidth,
      dash: hline.linestyle,
      value: hline.price,
    },
    display: hline.display,
    editable: hline.editable,
  }));
  const fills: FillSpec[] = d.fills.map((fill, i) => ({
    id: fillId(i),
    title: fill.title || 'Background',
    between: [edgeId(fill.between[0]), edgeId(fill.between[1])],
    style: {
      visible: true,
      ...look(fill.colorChanges ? null : fill.color),
      ...(fill.colorChanges ? { color: '#2962FF', opacity: 0.1 } : {}),
      ...(fill.gradient
        ? {
            bottomColor: look(fill.gradient.bottomColor).color,
            bottomOpacity: look(fill.gradient.bottomColor).opacity,
          }
        : {}),
    },
    ...(fill.gradient
      ? { gradient: { top: fill.gradient.top, bottom: fill.gradient.bottom } }
      : {}),
    shownWhen: () => fill.display !== 0,
    colorChanges: fill.colorChanges,
    display: fill.display,
    editable: fill.editable,
  }));
  const backgrounds: BackgroundSpec[] = d.backgrounds.map((background, i) => ({
    id: backgroundId(i),
    title: background.title || 'Background',
    style: { visible: pane(background.display), ...look(background.color) },
    offset: background.offset,
    showLast: background.showLast,
    display: background.display,
    editable: background.editable,
  }));
  return {
    kind: 'script',
    name: d.title,
    shortName: name,
    aliases: [],
    placement: d.overlay ? 'price' : 'pane',
    format: valueFormat(d, context.priceDecimals),
    inputs: program.inputs.map((input) => inputSpec(input, enabled)),
    plots,
    levels,
    fills,
    backgrounds,
    styleOverrides: true,
    legendName: () => name,
    // The inputs the script shows in the status line (display.status_line; Pine docs, Inputs).
    legendInputs: (current) => {
      const now = program.describe(scriptInputs(program, current));
      return now.inputs
        .filter((input) => (input.display & PINE_DISPLAY.statusLine) !== 0)
        .map((input) => legendValue(input.value))
        .filter((text): text is string => text !== null)
        .join(' ');
    },
    create: () => {
      throw new Error('A script runs as a ScriptLayerRun, not a built-in calculator');
    },
    settledFrom: () => 0,
  };
}

/** A script's input values for its settings, from the script's defaults. */
export function scriptDefaultInputs(program: ScriptProgram): Record<string, InputValue> {
  const inputs: Record<string, InputValue> = {};
  for (const input of program.inputs) {
    const value = input.defval;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      inputs[inputId(input.index)] = value;
    }
  }
  return inputs;
}

/**
 * A script's run, read by the indicator layer as it reads a built-in's (IndicatorRun): values by
 * plot, with the script's own extras (each bar's colors, its backgrounds) and its warm-up starts.
 */
export class ScriptLayerRun {
  readonly run: ScriptRun;
  readonly symbol: unknown;
  /** Columns colored by direction are a built-in's (Volume's): a script colors its own. */
  readonly growing: readonly boolean[] = [];
  private fromListing = false;

  constructor(program: ScriptProgram, inputs: Inputs, context: ScriptContext, symbol: unknown) {
    this.run = new ScriptRun(program, scriptInputs(program, inputs), context.symbol);
    this.symbol = symbol;
  }

  get length(): number {
    return this.run.length;
  }

  get values(): readonly Float64Array[] {
    return this.run.values;
  }

  setListing(fromListing: boolean): void {
    this.fromListing = fromListing;
  }

  setBars(bars: readonly Bar[]): void {
    this.run.setBars(bars, this.fromListing);
  }

  update(bars: readonly Bar[], change: BarChange, index: number): number[] | 'all' {
    return this.run.update(bars, change, index);
  }
}
