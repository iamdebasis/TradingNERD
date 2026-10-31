import type { Bar } from '@tradingnerd/core';
import {
  type BarChange,
  displayFormat,
  type FillEdge,
  type IndicatorDefinition,
  IndicatorRun,
  indicatorDefinition,
  PINE_DISPLAY,
  type PlotSpec,
  type StyleValue,
  type SymbolContext,
  styleOf,
  type ValueFormat,
} from '@tradingnerd/indicators';
import { colorCss, compileCached, DEFAULT_SYMBOL, type ScriptProgram } from '@tradingnerd/pine';
import {
  AreaSeries,
  type AutoscaleInfo,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  LineType,
  type LineWidth,
  type PriceFormatCustom,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { AxisContext } from '../plugins/axisLabel';
import { type BackgroundBand, BackgroundPrimitive } from '../plugins/BackgroundPrimitive';
import { CrosshairPrimitive } from '../plugins/CrosshairPrimitive';
import { type BandEdge, FillPrimitive, type FillShape } from '../plugins/FillPrimitive';
import { type ValueLabel, ValueLabelsPrimitive } from '../plugins/ValueLabelsPrimitive';
import type { ChartTheme } from '../theme';
import {
  type ChartIndicator,
  columnPoint,
  columnPoints,
  formatIndicatorValue,
  linePoint,
  linePoints,
  lineStyleOf,
  NEW_PANE_STRETCH,
  PRICE_PANE_STRETCH,
  paneShares,
  plotStart,
  VOLUME_MARGINS,
  withLevels,
  withOpacity,
} from './model';
import { type ScriptContext, ScriptLayerRun, scriptDefinition } from './script';

/** The overlay scale Volume and its MA share at the bottom of the price pane. */
const VOLUME_SCALE = 'tn-volume';
/** A line drawn clear: it only carries its pane's levels and fills. */
const CLEAR = 'rgba(0, 0, 0, 0)';
/** Pine's plot styles whose lines break where a value is na (the others join over it). */
const BREAKS = new Set(['linebr', 'steplinebr', 'areabr']);
/** Pine's plot styles drawn as points, without a line. */
const POINTS = new Set(['circles', 'cross']);

/** What the layer reads of a run: a built-in's IndicatorRun or a script's ScriptLayerRun. */
type LayerRun = IndicatorRun | ScriptLayerRun;

/** One plot on the chart. */
interface DrawnPlot {
  spec: PlotSpec;
  /** Its place in the run's values. */
  index: number;
  series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | ISeriesApi<'Area'>;
  /** The last bar handed to the series; updates before it are corrections of the past. */
  last: number;
  /** Drawn clear: its style hides it, but its pane's levels and fills hang on it. */
  ghost: boolean;
  /** A script's trackprice line at its latest value. */
  track: IPriceLine | null;
}

/** One indicator's state on the chart: its run and what draws it. */
class IndicatorView {
  indicator: ChartIndicator;
  readonly definition: IndicatorDefinition;
  /** A script's compiled code; null for a built-in. */
  readonly program: ScriptProgram | null;
  run: LayerRun;
  /** Why a script draws nothing: its compile error, or the runtime error that stopped it. */
  compileError: string | null = null;
  /** Each plot's first drawn bar (the warm-up rule), in the definition's order. */
  starts: number[] = [];
  plots: DrawnPlot[] = [];
  /** The series its pane's levels, fills and labels hang on; null for Volume and when hidden. */
  host: ISeriesApi<SeriesType> | null = null;
  /** Every series it added, the host included. */
  series: ISeriesApi<SeriesType>[] = [];
  levels: IPriceLine[] = [];
  fill: FillPrimitive | null = null;
  background: BackgroundPrimitive | null = null;
  crosshair: CrosshairPrimitive | null = null;
  labels: ValueLabelsPrimitive | null = null;
  /** Prices of its pane's tick labels, so its labels can hide the ones they cover. */
  tickPrices: readonly number[] = [];

  constructor(
    indicator: ChartIndicator,
    definition: IndicatorDefinition,
    program: ScriptProgram | null,
    run: LayerRun,
  ) {
    this.indicator = indicator;
    this.definition = definition;
    this.program = program;
    this.run = run;
  }

  get ownPane(): boolean {
    return this.definition.placement === 'pane';
  }

  /** The pane it's drawn in: its own, or the price pane (0). */
  paneIndex(): number {
    return this.ownPane && this.host ? this.host.getPane().paneIndex() : 0;
  }

  /** How its values are written: its own format at the Style tab's Precision. */
  get format(): ValueFormat {
    return displayFormat(this.definition.format, this.indicator.settings.display.precision);
  }

  /** A script's run; null for a built-in. */
  get script(): ScriptLayerRun | null {
    return this.run instanceof ScriptLayerRun ? this.run : null;
  }

  /** Why nothing is drawn, if something stopped the script. */
  get error(): string | null {
    return this.compileError ?? this.script?.run.error?.message ?? null;
  }
}

/** What the browser tests and the debug handle see of one indicator. */
export interface IndicatorDebugState {
  id: string;
  kind: string;
  hidden: boolean;
  pane: number;
  /** Each drawn plot: its first drawn bar, and how many bars it has a value on. */
  plots: { id: string; start: number; points: number; ghost: boolean; type: string }[];
  levels: number;
  /** Its fills, by id, as drawn: each a solid color or a gradient. */
  fills: { id: string; gradient: boolean }[];
  /** A script's backgrounds, by id. */
  backgrounds: string[];
  /** Its value labels on the price axis, as drawn. */
  valueLabels: string[];
  /** What stopped a script, if anything did. */
  error: string | null;
}

/** One indicator's values on a bar, in its definition's plot order (NaN where none shows). */
export interface IndicatorValues {
  id: string;
  values: number[];
  /** For columns colored by direction (Volume's): whether the bar was growing. */
  growing: boolean;
  /** A script's plots whose color changes from bar to bar: each one's color on the bar. */
  colors: (string | null)[];
}

const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
};

/**
 * Whether two states of an indicator draw the same series (a pane's height and how its values
 * are written aside: those change in place).
 */
const drawsSame = (a: ChartIndicator, b: ChartIndicator) =>
  a.kind === b.kind &&
  a.hidden === b.hidden &&
  a.script?.source === b.script?.source &&
  sameJson(a.settings.inputs, b.settings.inputs) &&
  sameJson(a.settings.styles, b.settings.styles);

/** A definition that draws nothing: a script that doesn't compile. */
function emptyDefinition(name: string): IndicatorDefinition {
  return {
    kind: 'script',
    name,
    shortName: name,
    aliases: [],
    placement: 'pane',
    format: { kind: 'decimals', decimals: 2 },
    inputs: [],
    plots: [],
    levels: [],
    fills: [],
    styleOverrides: true,
    legendName: () => name,
    legendInputs: () => '',
    create: () => {
      throw new Error('Nothing to run');
    },
    settledFrom: () => Number.POSITIVE_INFINITY,
  };
}

/**
 * The indicators on the chart (docs/SPEC.md §6.16, §6.17): each one's run over the chart's bars,
 * and the Lightweight Charts series, panes, levels and fills that draw it. Volume sits at the
 * bottom of the price pane on a scale of its own; a script with `overlay = true` on the candles'
 * own scale; every other indicator gets a pane below the chart, in the order added. Plots are
 * drawn from where the warm-up rule allows; hidden plots and hidden indicators get no data, so
 * they cost nothing.
 */
export class IndicatorLayer {
  private readonly chart: IChartApi;
  private readonly theme: ChartTheme;
  private readonly font: string;
  private views: IndicatorView[] = [];
  private bars: readonly Bar[] = [];
  private times: readonly number[] = [];
  private fromListing = false;
  private symbol: SymbolContext = { base: '', hasVolume: true };
  private context: ScriptContext = { symbol: DEFAULT_SYMBOL, priceDecimals: 2 };
  /** The pane the crosshair label shows in, if an indicator's. */
  private crosshairPane: number | null = null;

  constructor(chart: IChartApi, theme: ChartTheme, font: string) {
    this.chart = chart;
    this.theme = theme;
    this.font = font;
  }

  /** The chart's symbol, and what scripts know of it; runs start over with it at the next setBars. */
  setSymbol(symbol: SymbolContext, context?: ScriptContext): void {
    this.symbol = symbol;
    if (context) this.context = context;
  }

  /** Brings the chart's indicators in line with the app's list: adds, redraws and removes. */
  set(indicators: readonly ChartIndicator[]): void {
    const wanted = new Set(indicators.map((indicator) => indicator.id));
    // Removed ones first, so the panes below theirs move up before any is added.
    for (const view of this.views) if (!wanted.has(view.indicator.id)) this.teardown(view);
    const kept = new Map(
      this.views.filter((view) => wanted.has(view.indicator.id)).map((v) => [v.indicator.id, v]),
    );
    const next: IndicatorView[] = [];
    for (const indicator of indicators) {
      const old = kept.get(indicator.id);
      if (old && drawsSame(old.indicator, indicator)) {
        const display = !sameJson(old.indicator.settings.display, indicator.settings.display);
        old.indicator = indicator;
        if (display) this.applyDisplay(old);
        next.push(old);
        continue;
      }
      const view = this.createView(indicator);
      // A hidden indicator isn't computed: showing it again builds it afresh.
      if (this.bars.length > 0 && !indicator.hidden && !view.compileError) this.runBars(view);
      if (old) {
        // Into the old one's pane, so the pane keeps its place and height; then the old one goes.
        this.build(view, old.paneIndex());
        this.teardown(old);
      } else {
        this.build(view, view.ownPane ? this.chart.panes().length : 0);
      }
      next.push(view);
    }
    this.views = next;
    this.orderPanes();
    this.applyStretch();
  }

  /** New bars throughout: every run computed afresh, as Pine reloads a script. */
  setBars(bars: readonly Bar[], times: readonly number[], fromListing: boolean): void {
    this.bars = bars;
    this.times = times;
    this.fromListing = fromListing;
    for (const view of this.views) {
      if (view.indicator.hidden || view.compileError) continue;
      if (view.run.symbol !== this.symbol)
        view.run = this.makeRun(view.indicator, view.definition, view.program);
      this.runBars(view);
      this.refreshStarts(view);
      this.push(view);
    }
  }

  /** A live change to the bars at `index` (see IndicatorRun.update). */
  update(bars: readonly Bar[], times: readonly number[], change: BarChange, index: number): void {
    this.bars = bars;
    this.times = times;
    for (const view of this.views) {
      if (view.indicator.hidden || view.compileError) continue;
      const stopped = view.error !== null;
      const before = view.starts;
      const changed = view.run.update(bars, change, index);
      // A script's warm-up starts can move with a new bar; a stopped script draws nothing.
      if (view.script) this.refreshStarts(view);
      const moved = view.starts.some((start, p) => start !== before[p]);
      if (
        changed === 'all' ||
        moved ||
        (view.error !== null) !== stopped ||
        this.needsFullPush(view)
      ) {
        this.push(view);
        continue;
      }
      for (const i of changed) this.pushPoint(view, i);
      this.refreshDecorations(view);
    }
  }

  /** Each indicator's values on bar `index`, for the legend. */
  valuesAt(index: number): IndicatorValues[] {
    return this.views.map((view) => {
      const shown = !view.indicator.hidden && view.error === null;
      const colors: (string | null)[] = [];
      const values = view.definition.plots.map((spec, p) => {
        const look = spec.look;
        if (look && (look.display & PINE_DISPLAY.statusLine) === 0) return Number.NaN;
        // A shifted plot's value at a bar is the one drawn there.
        const source = index - (look?.offset ?? 0);
        if (look) colors[p] = this.barColor(view, spec, p, source);
        return shown && index >= this.drawnFrom(view, spec, p)
          ? (view.run.values[p]?.[source] ?? Number.NaN)
          : Number.NaN;
      });
      return {
        id: view.indicator.id,
        values,
        growing: view.run.growing[index] ?? true,
        colors,
      };
    });
  }

  /** Why each script draws nothing, by its id: its compile or runtime error. */
  errors(): Map<string, string> {
    const errors = new Map<string, string>();
    for (const view of this.views) {
      const error = view.error;
      if (error !== null) errors.set(view.indicator.id, error);
    }
    return errors;
  }

  /**
   * Bars at the start of the chart some drawn plot still waits on (the warm-up rule): older
   * history is fetched until they're settled or the listing is reached.
   */
  waitingBars(): number {
    let waiting = 0;
    for (const view of this.views) {
      for (const plot of view.plots) {
        if (plot.ghost) continue;
        const start = view.starts[plot.index] ?? 0;
        if (Number.isFinite(start)) waiting = Math.max(waiting, start);
      }
    }
    return waiting;
  }

  /** The crosshair's label in an indicator pane: at `y` in pane `paneIndex`, or none. */
  crosshairAt(paneIndex: number | null, y: number | null): void {
    const target = paneIndex !== null && paneIndex > 0 && y !== null ? paneIndex : null;
    if (target === null && this.crosshairPane === null) return;
    for (const view of this.views) {
      if (!view.crosshair || !view.host) continue;
      const pane = view.paneIndex();
      if (pane === target && y !== null) {
        const price = view.host.coordinateToPrice(y);
        const text = price === null ? null : formatIndicatorValue(price, view.format);
        view.crosshair.update(text === null ? null : { y, text });
      } else if (pane === this.crosshairPane) {
        view.crosshair.update(null);
      }
    }
    this.crosshairPane = target;
  }

  /** The series whose price scale a gesture in pane `paneIndex` moves (null for the price pane). */
  scaleSeries(paneIndex: number): ISeriesApi<SeriesType> | null {
    if (paneIndex === 0) return null;
    return this.views.find((view) => view.ownPane && view.paneIndex() === paneIndex)?.host ?? null;
  }

  /** Which indicator each indicator pane holds, by pane index. */
  paneOwners(): Map<number, string> {
    const owners = new Map<number, string>();
    for (const view of this.views) {
      if (view.ownPane && view.host) owners.set(view.paneIndex(), view.indicator.id);
    }
    return owners;
  }

  /** Where a price sits in an indicator's pane (pane px), or null off its scale or without one. */
  priceToY(id: string, price: number): number | null {
    const view = this.views.find((item) => item.indicator.id === id);
    return view?.host?.priceToCoordinate(price) ?? null;
  }

  /** Auto-scale back on in every indicator pane (Alt + R, a new symbol). */
  autoScale(): void {
    for (const view of this.views) if (view.ownPane) view.host?.priceScale().setAutoScale(true);
  }

  /**
   * Each indicator pane's height as a share of the price pane's, by its indicator's id, as the
   * panes are now (after dragging a separator).
   */
  paneHeights(): Record<string, number> {
    const shares = paneShares(this.chart.panes().map((pane) => pane.getStretchFactor()));
    const heights: Record<string, number> = {};
    for (const view of this.views) {
      if (!view.ownPane) continue;
      const share = shares[view.paneIndex() - 1];
      if (share !== undefined) heights[view.indicator.id] = share;
    }
    return heights;
  }

  debug(): IndicatorDebugState[] {
    return this.views.map((view) => ({
      id: view.indicator.id,
      kind: view.indicator.kind,
      hidden: view.indicator.hidden,
      pane: view.paneIndex(),
      plots: view.plots.map((plot) => ({
        id: plot.spec.id,
        start: view.starts[plot.index] ?? Number.POSITIVE_INFINITY,
        points: plot.series.data().filter((point) => 'value' in point).length,
        ghost: plot.ghost,
        type: plot.series.seriesType(),
      })),
      levels: view.levels.length,
      fills:
        view.fill?.current().map((shape) => ({
          id: shape.id,
          gradient:
            shape.kind === 'plots' && typeof shape.color === 'object' && 'top' in shape.color,
        })) ?? [],
      backgrounds: view.background?.current().map((band) => band.id) ?? [],
      valueLabels: view.labels?.current().map((label) => label.text) ?? [],
      error: view.error,
    }));
  }

  destroy(): void {
    for (const view of this.views) this.teardown(view);
    this.views = [];
  }

  /** A view for an indicator: a built-in's definition, or a script's compiled code. */
  private createView(indicator: ChartIndicator): IndicatorView {
    if (indicator.kind !== 'script') {
      const definition = indicatorDefinition(indicator.kind);
      return new IndicatorView(
        indicator,
        definition,
        null,
        this.makeRun(indicator, definition, null),
      );
    }
    const compiled = compileCached(indicator.script?.source ?? '');
    if (!compiled.ok) {
      const definition = emptyDefinition('Script');
      const view = new IndicatorView(
        indicator,
        definition,
        null,
        this.makeRun(indicator, definition, null),
      );
      view.compileError = compiled.errors[0]?.message ?? 'The script has an error';
      return view;
    }
    const { program } = compiled;
    const definition = scriptDefinition(program, indicator.settings.inputs, this.context);
    return new IndicatorView(
      indicator,
      definition,
      program,
      this.makeRun(indicator, definition, program),
    );
  }

  private makeRun(
    indicator: ChartIndicator,
    definition: IndicatorDefinition,
    program: ScriptProgram | null,
  ): LayerRun {
    if (program)
      return new ScriptLayerRun(program, indicator.settings.inputs, this.context, this.symbol);
    if (definition.kind === 'script') {
      // A script that doesn't compile: an empty run, never computed.
      return new IndicatorRun(indicatorDefinition('volume'), {}, this.symbol);
    }
    return new IndicatorRun(definition, indicator.settings.inputs, this.symbol);
  }

  private runBars(view: IndicatorView): void {
    view.script?.setListing(this.fromListing);
    view.run.setBars(this.bars);
  }

  /** Creates the series that draw an indicator, in pane `paneIndex`, and hands them its values. */
  private build(view: IndicatorView, paneIndex: number): void {
    const { definition } = view;
    const { inputs } = view.indicator.settings;
    const placement = definition.placement;
    if (view.indicator.hidden || view.compileError) {
      // Nothing drawn; an indicator with a pane keeps it, as TradingView does.
      if (view.ownPane) {
        view.host = this.chart.addSeries(LineSeries, { visible: false }, paneIndex);
        view.series.push(view.host);
      }
      return;
    }
    const shown = definition.plots.filter((spec) => spec.shownWhen?.(inputs) ?? true);
    const hosts = placement !== 'volume';
    shown.forEach((spec, k) => {
      const style = styleOf(view.indicator.settings, spec);
      // A pane's first plot carries its levels, fills and backgrounds, so it exists even hidden.
      const carries = hosts && k === 0;
      const drawn =
        style.visible && (spec.look ? (spec.look.display & PINE_DISPLAY.pane) !== 0 : true);
      if (!drawn && !carries) return;
      const ghost = !drawn;
      const common = {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: this.priceFormat(view),
        priceScaleId: placement === 'volume' ? VOLUME_SCALE : 'right',
        ...(carries ? { autoscaleInfoProvider: this.levelScale(view, ghost) } : {}),
      };
      const series = this.addPlotSeries(spec, style, ghost, common, paneIndex);
      const track =
        spec.look?.trackprice && !ghost
          ? series.createPriceLine({
              price: 0,
              color: withOpacity(style.color, style.opacity),
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              lineVisible: false,
              axisLabelVisible: false,
              title: '',
            })
          : null;
      view.series.push(series);
      view.plots.push({
        spec,
        index: definition.plots.indexOf(spec),
        series,
        last: -1,
        ghost,
        track,
      });
      if (carries) view.host = series;
    });
    if (hosts && !view.host) {
      // Nothing to plot (hlines or backgrounds only): a clear series carries them.
      const host = this.chart.addSeries(
        LineSeries,
        {
          color: CLEAR,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: this.priceFormat(view),
          priceScaleId: 'right',
          autoscaleInfoProvider: this.levelScale(view, true),
        },
        paneIndex,
      );
      host.setData(this.times.map((time) => ({ time: time as UTCTimestamp })));
      view.host = host;
      view.series.push(host);
    }
    if (placement === 'volume') {
      // Volume behind the candles, at the bottom of the price pane.
      const [first] = view.series;
      first?.priceScale().applyOptions({ scaleMargins: VOLUME_MARGINS });
      view.series.forEach((series, order) => {
        series.setSeriesOrder(order);
      });
    }
    const { host } = view;
    if (host) {
      for (const level of definition.levels) {
        const style = styleOf(view.indicator.settings, level);
        if (!style.visible) continue;
        view.levels.push(
          host.createPriceLine({
            price: style.value ?? level.style.value,
            color: withOpacity(style.color, style.opacity),
            lineWidth: (style.width ?? 1) as LineWidth,
            lineStyle: lineStyleOf(style),
            lineVisible: true,
            axisLabelVisible: false,
            title: '',
          }),
        );
      }
      const axis: AxisContext = {
        tickYs: () => this.tickYs(view),
        background: this.theme.background,
      };
      view.fill = new FillPrimitive();
      view.labels = new ValueLabelsPrimitive(this.font, this.theme.labelText, axis);
      host.attachPrimitive(view.fill);
      host.attachPrimitive(view.labels);
      if ((definition.backgrounds ?? []).length > 0) {
        view.background = new BackgroundPrimitive();
        host.attachPrimitive(view.background);
      }
      // The price pane has the chart's own crosshair label.
      if (view.ownPane) {
        view.crosshair = new CrosshairPrimitive(
          this.theme.crosshairLabel,
          this.theme.labelText,
          this.font,
          axis,
        );
        host.attachPrimitive(view.crosshair);
      }
    }
    this.refreshStarts(view);
    this.push(view);
  }

  /** The series a plot is drawn with: Pine's style for a script's, the built-in's kind otherwise. */
  private addPlotSeries(
    spec: PlotSpec,
    style: StyleValue,
    ghost: boolean,
    common: Record<string, unknown>,
    paneIndex: number,
  ): DrawnPlot['series'] {
    const color = ghost ? CLEAR : withOpacity(style.color, style.opacity);
    const lineWidth = Math.min(4, Math.max(1, style.width ?? 1)) as LineWidth;
    const pine = spec.look?.style;
    if (spec.kind === 'columns') {
      return this.chart.addSeries(
        HistogramSeries,
        { ...common, base: spec.look?.histbase ?? 0, ...(spec.look ? { color } : {}) },
        paneIndex,
      );
    }
    if (pine === 'area' || pine === 'areabr') {
      // Lightweight Charts fills an area down to the pane's bottom (Pine to histbase: provisional).
      return this.chart.addSeries(
        AreaSeries,
        {
          ...common,
          lineColor: color,
          topColor: ghost ? CLEAR : withOpacity(style.color, style.opacity * 0.4),
          bottomColor: CLEAR,
          lineWidth,
          lineStyle: lineStyleOf(style),
          crosshairMarkerVisible: false,
        },
        paneIndex,
      );
    }
    return this.chart.addSeries(
      LineSeries,
      {
        ...common,
        color,
        lineWidth,
        lineStyle: lineStyleOf(style),
        crosshairMarkerVisible: false,
        ...(pine?.startsWith('stepline') ? { lineType: LineType.WithSteps } : {}),
        // Circles and crosses as points (a cross drawn as a circle: provisional, §11).
        ...(pine && POINTS.has(pine)
          ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: lineWidth + 1 }
          : {}),
      },
      paneIndex,
    );
  }

  private teardown(view: IndicatorView): void {
    // Its series take their levels and primitives with them; an emptied pane closes.
    for (const series of view.series) this.chart.removeSeries(series);
    view.series = [];
    view.plots = [];
    view.host = null;
    view.levels = [];
    view.fill = null;
    view.background = null;
    view.labels = null;
    view.crosshair = null;
  }

  /**
   * The Style tab's Precision and "Labels on price scale" changed: its scale's numbers and its
   * labels follow, its series and values stay.
   */
  private applyDisplay(view: IndicatorView): void {
    for (const series of view.series) series.applyOptions({ priceFormat: this.priceFormat(view) });
    this.refreshDecorations(view);
  }

  /** Each indicator pane in its indicator's place in the list, below the price pane. */
  private orderPanes(): void {
    let index = 1;
    for (const view of this.views) {
      if (!view.ownPane || !view.host) continue;
      const pane = view.host.getPane();
      if (pane.paneIndex() !== index) pane.moveTo(index);
      index++;
    }
  }

  private applyStretch(): void {
    const panes = this.chart.panes();
    const set = (index: number, factor: number) => {
      const pane = panes[index];
      if (pane && Math.abs(pane.getStretchFactor() - factor) > 1e-9) pane.setStretchFactor(factor);
    };
    set(0, PRICE_PANE_STRETCH);
    for (const view of this.views) {
      if (!view.ownPane || !view.host) continue;
      set(view.paneIndex(), PRICE_PANE_STRETCH * (view.indicator.paneStretch ?? NEW_PANE_STRETCH));
    }
  }

  private refreshStarts(view: IndicatorView): void {
    const script = view.script;
    if (script) {
      view.starts = view.definition.plots.map(
        (_spec, p) => script.run.plotStarts[p] ?? Number.POSITIVE_INFINITY,
      );
      return;
    }
    const { inputs } = view.indicator.settings;
    view.starts = view.definition.plots.map((spec) =>
      plotStart(view.definition, spec.id, inputs, this.fromListing),
    );
  }

  /**
   * The first bar a plot is drawn on: its warm-up start, shifted by its offset, and no earlier
   * than its show_last allows.
   */
  private drawnFrom(view: IndicatorView, spec: PlotSpec, p: number): number {
    const start = view.starts[p] ?? Number.POSITIVE_INFINITY;
    const look = spec.look;
    if (!look) return start;
    const shifted = start + look.offset;
    return look.showLast === null ? shifted : Math.max(shifted, this.times.length - look.showLast);
  }

  /** A script's plot whose drawn bars move with each new bar (show_last): set afresh each time. */
  private needsFullPush(view: IndicatorView): boolean {
    return view.plots.some(
      (plot) => plot.spec.look?.showLast !== null && plot.spec.look !== undefined,
    );
  }

  /** A script plot's color on bar `index` (its own index, before any offset), or null for none. */
  private barColor(view: IndicatorView, spec: PlotSpec, p: number, index: number): string | null {
    const look = spec.look;
    if (!look?.colorChanges || view.indicator.settings.styles[spec.id]) return null;
    const packed = view.script?.run.plotColors[p]?.[index];
    return packed === undefined || Number.isNaN(packed) ? null : colorCss(packed);
  }

  /** Hands every drawn plot all its values. */
  private push(view: IndicatorView): void {
    const { times } = this;
    const stopped = view.error !== null;
    for (const plot of view.plots) {
      const values = view.run.values[plot.index] ?? [];
      const start = stopped
        ? Number.POSITIVE_INFINITY
        : this.drawnFrom(view, plot.spec, plot.index);
      if (plot.spec.look) {
        plot.series.setData(this.scriptPoints(view, plot, start) as never);
      } else if (plot.spec.kind === 'columns') {
        const series = plot.series as ISeriesApi<'Histogram'>;
        series.setData(
          columnPoints(values as number[], view.run.growing, times, start, this.columnColors(view)),
        );
      } else {
        (plot.series as ISeriesApi<'Line'>).setData(linePoints(values as number[], times, start));
      }
      plot.last = start < times.length ? times.length - 1 : -1;
    }
    this.refreshDecorations(view);
  }

  /**
   * A script plot's points from bar `start`: each bar shows the value its offset brings there, in
   * its bar's color when that changes; na breaks a line in the "br" styles and is joined over in
   * the others (the v6 reference's plot styles).
   */
  private scriptPoints(view: IndicatorView, plot: DrawnPlot, start: number): object[] {
    const points: object[] = [];
    const look = plot.spec.look;
    if (!look || !Number.isFinite(start)) return points;
    for (let i = Math.max(0, start); i < this.times.length; i++) {
      const point = this.scriptPoint(view, plot, i);
      if (point) points.push(point);
    }
    return points;
  }

  /** The point a script's plot draws at bar `i`, or null for none at all. */
  private scriptPoint(view: IndicatorView, plot: DrawnPlot, i: number): object | null {
    const look = plot.spec.look;
    const time = this.times[i];
    if (!look || time === undefined) return null;
    const source = i - look.offset;
    const value = view.run.values[plot.index]?.[source] ?? Number.NaN;
    const point: { time: Time; value?: number; color?: string; lineColor?: string } = {
      time: time as UTCTimestamp,
    };
    if (!Number.isFinite(value)) {
      // Joined over by the plain styles: no point at all; broken by the "br" ones and the rest.
      const joins = !BREAKS.has(look.style) && !POINTS.has(look.style) && plot.spec.kind === 'line';
      return joins ? null : point;
    }
    point.value = value;
    if (look.colorChanges && !plot.ghost && !view.indicator.settings.styles[plot.spec.id]) {
      const color = this.barColor(view, plot.spec, plot.index, source) ?? CLEAR;
      if (look.style === 'area' || look.style === 'areabr') point.lineColor = color;
      else point.color = color;
    }
    return point;
  }

  /** Hands every drawn plot its value on bar `index`. */
  private pushPoint(view: IndicatorView, index: number): void {
    const time = this.times[index];
    if (time === undefined) return;
    for (const plot of view.plots) {
      if (plot.spec.look) {
        this.pushScriptPoint(view, plot, index);
        continue;
      }
      if (index < (view.starts[plot.index] ?? Number.POSITIVE_INFINITY)) continue;
      const value = view.run.values[plot.index]?.[index] ?? Number.NaN;
      const point =
        plot.spec.kind === 'columns'
          ? columnPoint(time, value, view.run.growing[index] ?? true, this.columnColors(view))
          : linePoint(time, value);
      if (index >= plot.last) {
        (plot.series as ISeriesApi<'Line'>).update(point);
        plot.last = index;
      } else {
        (plot.series as ISeriesApi<'Line'>).update(point, true);
      }
    }
  }

  /** A script's plot after bar `index` changed: the bar its offset draws that value on. */
  private pushScriptPoint(view: IndicatorView, plot: DrawnPlot, index: number): void {
    const look = plot.spec.look;
    if (!look) return;
    const at = index + look.offset;
    // A value shifted past the last bar isn't drawn (provisional: TradingView draws it ahead).
    if (at < 0 || at >= this.times.length) return;
    if (at < this.drawnFrom(view, plot.spec, plot.index)) return;
    const point = this.scriptPoint(view, plot, at);
    if (!point) {
      // A value gone na on a joined line: only setting the data afresh takes its point away.
      plot.series.setData(
        this.scriptPoints(view, plot, this.drawnFrom(view, plot.spec, plot.index)) as never,
      );
      return;
    }
    if (at >= plot.last) {
      (plot.series as ISeriesApi<'Line'>).update(point as never);
      plot.last = at;
    } else {
      (plot.series as ISeriesApi<'Line'>).update(point as never, true);
    }
  }

  /** Its fills, backgrounds, value labels and trackprice lines, after its values changed. */
  private refreshDecorations(view: IndicatorView): void {
    const stopped = view.error !== null;
    view.fill?.update(stopped ? [] : this.fills(view));
    view.background?.update(stopped ? [] : this.backgrounds(view));
    view.labels?.update(stopped ? [] : this.valueLabels(view));
    for (const plot of view.plots) {
      if (!plot.track) continue;
      const last = this.times.length - 1 - (plot.spec.look?.offset ?? 0);
      const value = view.run.values[plot.index]?.[last] ?? Number.NaN;
      const show =
        !stopped &&
        Number.isFinite(value) &&
        last + (plot.spec.look?.offset ?? 0) >= this.drawnFrom(view, plot.spec, plot.index);
      plot.track.applyOptions(show ? { price: value, lineVisible: true } : { lineVisible: false });
    }
  }

  private fills(view: IndicatorView): FillShape[] {
    const { definition } = view;
    const { inputs } = view.indicator.settings;
    const shapes: FillShape[] = [];
    definition.fills.forEach((fill, f) => {
      const style = styleOf(view.indicator.settings, fill);
      if (!style.visible || !(fill.shownWhen?.(inputs) ?? true)) return;
      if (fill.display !== undefined && (fill.display & PINE_DISPLAY.pane) === 0) return;
      const [a, b] = fill.between.map((edge) => this.fillEdge(view, edge));
      if (!a || !b) return;
      const color = withOpacity(style.color, style.opacity);
      if (
        !fill.gradient &&
        typeof a.edge === 'number' &&
        typeof b.edge === 'number' &&
        !fill.colorChanges
      ) {
        shapes.push({ id: fill.id, kind: 'levels', from: a.edge, to: b.edge, color });
        return;
      }
      const script = view.script;
      const colors = script?.run.fillColors[f];
      const changing = fill.colorChanges && colors && !view.indicator.settings.styles[fill.id];
      shapes.push({
        id: fill.id,
        kind: 'plots',
        upper: a.edge,
        lower: b.edge,
        start: Math.max(a.start, b.start, changing ? (script?.run.fillStarts[f] ?? 0) : 0),
        color: changing
          ? {
              at: (i: number) => {
                const packed = colors[i];
                return packed === undefined || Number.isNaN(packed) ? null : colorCss(packed);
              },
            }
          : fill.gradient
            ? {
                top: fill.gradient.top,
                bottom: fill.gradient.bottom,
                topColor: color,
                bottomColor: withOpacity(
                  style.bottomColor ?? style.color,
                  style.bottomOpacity ?? style.opacity,
                ),
              }
            : color,
      });
    });
    return shapes;
  }

  /** A script's backgrounds: each bar's color from its run, or the Style tab's color. */
  private backgrounds(view: IndicatorView): BackgroundBand[] {
    const script = view.script;
    if (!script) return [];
    const last = this.times.length - 1;
    const bands: BackgroundBand[] = [];
    (view.definition.backgrounds ?? []).forEach((spec, b) => {
      const style = styleOf(view.indicator.settings, spec);
      if (!style.visible) return;
      const colors = script.run.backgrounds[b];
      if (!colors) return;
      const override = view.indicator.settings.styles[spec.id];
      const start = (script.run.backgroundStarts[b] ?? Number.POSITIVE_INFINITY) + spec.offset;
      if (!Number.isFinite(start)) return;
      bands.push({
        id: spec.id,
        start: spec.showLast === null ? start : Math.max(start, last + 1 - spec.showLast),
        end: last,
        colorAt: (i) => {
          const packed = colors[i - spec.offset];
          if (packed === undefined || Number.isNaN(packed)) return null;
          // A color set in the Style tab takes the place of the script's (provisional, §11).
          return override ? withOpacity(override.color, override.opacity) : colorCss(packed);
        },
      });
    });
    return bands;
  }

  /**
   * A fill's edge: a level's price as the Style tab sets it, a fixed price, or a plot's values
   * from its first drawn bar. Null for an id the indicator doesn't have.
   */
  private fillEdge(view: IndicatorView, edge: FillEdge): { edge: BandEdge; start: number } | null {
    if (typeof edge === 'number') return { edge, start: 0 };
    const { definition } = view;
    const level = definition.levels.find((spec) => spec.id === edge);
    if (level) {
      return { edge: styleOf(view.indicator.settings, level).value ?? level.style.value, start: 0 };
    }
    const plot = definition.plots.findIndex((spec) => spec.id === edge);
    if (plot < 0) return null;
    return { edge: view.run.values[plot] ?? [], start: view.starts[plot] ?? 0 };
  }

  /** Each drawn line's latest value, on its pane's price axis, unless the Style tab hides them. */
  private valueLabels(view: IndicatorView): ValueLabel[] {
    if (!view.indicator.settings.display.priceLabels) return [];
    const last = this.times.length - 1;
    const labels: ValueLabel[] = [];
    for (const plot of view.plots) {
      const look = plot.spec.look;
      if (plot.ghost || (!look && plot.spec.kind !== 'line')) continue;
      if (look && (look.display & PINE_DISPLAY.priceScale) === 0) continue;
      if (last < this.drawnFrom(view, plot.spec, plot.index)) continue;
      const source = last - (look?.offset ?? 0);
      const value = view.run.values[plot.index]?.[source] ?? Number.NaN;
      const style = styleOf(view.indicator.settings, plot.spec);
      if (!Number.isFinite(value)) continue;
      const color = this.barColor(view, plot.spec, plot.index, source) ?? style.color;
      labels.push({
        price: value,
        text: formatIndicatorValue(value, view.format),
        color,
      });
    }
    return labels;
  }

  private columnColors(view: IndicatorView): { growing: string; falling: string } {
    const style = view.indicator.settings.styles.volume;
    if (!style) return { growing: this.theme.up, falling: this.theme.down };
    return {
      growing: withOpacity(style.color, style.opacity),
      falling: withOpacity(style.fallingColor ?? style.color, style.opacity),
    };
  }

  /**
   * Its values' format on its pane's scale, at the Style tab's Precision; also notes where the
   * scale puts its tick labels.
   */
  private priceFormat(view: IndicatorView): PriceFormatCustom {
    const { format } = view;
    return {
      type: 'custom',
      minMove: format.kind === 'volume' ? 1e-8 : 10 ** -format.decimals,
      formatter: (price: number) => formatIndicatorValue(price, format),
      tickmarksFormatter: (prices: readonly number[]) => {
        view.tickPrices = [...prices];
        return prices.map((price) => formatIndicatorValue(price, format));
      },
    };
  }

  /**
   * A pane's scale fits its plots and its visible levels, as TradingView's RSI pane always shows
   * its 70 and 30 lines; a plot drawn clear only lends its levels.
   */
  private levelScale(view: IndicatorView, ghost: boolean) {
    return (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
      const info = ghost ? null : original();
      const levels = view.definition.levels
        .map((level) => styleOf(view.indicator.settings, level))
        .filter((style) => style.visible)
        .map((style) => style.value as number);
      const range = withLevels(info?.priceRange ?? null, levels);
      if (!range) return null;
      return info?.margins ? { priceRange: range, margins: info.margins } : { priceRange: range };
    };
  }

  private tickYs(view: IndicatorView): number[] {
    const ys: number[] = [];
    for (const price of view.tickPrices) {
      const y = view.host?.priceToCoordinate(price);
      if (y !== null && y !== undefined) ys.push(y);
    }
    return ys;
  }
}
