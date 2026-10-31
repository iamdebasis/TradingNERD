import type { Bar } from '@tradingnerd/core';
import {
  type BarChange,
  displayFormat,
  type FillEdge,
  type IndicatorDefinition,
  IndicatorRun,
  indicatorDefinition,
  type PlotSpec,
  type SymbolContext,
  type ValueFormat,
} from '@tradingnerd/indicators';
import {
  type AutoscaleInfo,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
  type LineWidth,
  type PriceFormatCustom,
  type SeriesType,
} from 'lightweight-charts';
import type { AxisContext } from '../plugins/axisLabel';
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

/** The overlay scale Volume and its MA share at the bottom of the price pane. */
const VOLUME_SCALE = 'tn-volume';
/** A line drawn clear: it only carries its pane's levels and fills. */
const CLEAR = 'rgba(0, 0, 0, 0)';

/** One plot on the chart. */
interface DrawnPlot {
  spec: PlotSpec;
  /** Its place in the run's values. */
  index: number;
  series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
  /** The last bar handed to the series; updates before it are corrections of the past. */
  last: number;
  /** Drawn clear: its style hides it, but its pane's levels and fills hang on it. */
  ghost: boolean;
}

/** One indicator's state on the chart: its run and what draws it. */
class IndicatorView {
  indicator: ChartIndicator;
  readonly definition: IndicatorDefinition;
  run: IndicatorRun;
  /** Each plot's first drawn bar (the warm-up rule), in the definition's order. */
  starts: number[] = [];
  plots: DrawnPlot[] = [];
  /** The series its pane's levels, fills and labels hang on; null for Volume and when hidden. */
  host: ISeriesApi<SeriesType> | null = null;
  /** Every series it added, the host included. */
  series: ISeriesApi<SeriesType>[] = [];
  levels: IPriceLine[] = [];
  fill: FillPrimitive | null = null;
  crosshair: CrosshairPrimitive | null = null;
  labels: ValueLabelsPrimitive | null = null;
  /** Prices of its pane's tick labels, so its labels can hide the ones they cover. */
  tickPrices: readonly number[] = [];

  constructor(indicator: ChartIndicator, definition: IndicatorDefinition, run: IndicatorRun) {
    this.indicator = indicator;
    this.definition = definition;
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
}

/** What the browser tests and the debug handle see of one indicator. */
export interface IndicatorDebugState {
  id: string;
  kind: string;
  hidden: boolean;
  pane: number;
  /** Each drawn plot: its first drawn bar, and how many bars it has a value on. */
  plots: { id: string; start: number; points: number; ghost: boolean }[];
  levels: number;
  /** Its fills, by id, as drawn: each a solid color or a gradient. */
  fills: { id: string; gradient: boolean }[];
  /** Its value labels on the price axis, as drawn. */
  valueLabels: string[];
}

/** One indicator's values on a bar, in its definition's plot order (NaN where none shows). */
export interface IndicatorValues {
  id: string;
  values: number[];
  /** For columns colored by direction (Volume's): whether the bar was growing. */
  growing: boolean;
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
  sameJson(a.settings.inputs, b.settings.inputs) &&
  sameJson(a.settings.styles, b.settings.styles);

/**
 * The indicators on the chart (docs/SPEC.md §6.16): each one's run over the chart's bars, and the
 * Lightweight Charts series, panes, levels and fills that draw it. Volume sits at the bottom of
 * the price pane on a scale of its own; every other indicator gets a pane below the chart, in the
 * order added. Plots are drawn from where the warm-up rule allows; hidden plots and hidden
 * indicators get no data, so they cost nothing.
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
  /** The pane the crosshair label shows in, if an indicator's. */
  private crosshairPane: number | null = null;

  constructor(chart: IChartApi, theme: ChartTheme, font: string) {
    this.chart = chart;
    this.theme = theme;
    this.font = font;
  }

  /** The chart's symbol; runs start over with it at the next setBars. */
  setSymbol(symbol: SymbolContext): void {
    this.symbol = symbol;
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
      const definition = indicatorDefinition(indicator.kind);
      const run = new IndicatorRun(definition, indicator.settings.inputs, this.symbol);
      // A hidden indicator isn't computed: showing it again builds it afresh.
      if (this.bars.length > 0 && !indicator.hidden) run.setBars(this.bars);
      const view = new IndicatorView(indicator, definition, run);
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
      if (view.indicator.hidden) continue;
      if (view.run.symbol !== this.symbol) {
        view.run = new IndicatorRun(view.definition, view.indicator.settings.inputs, this.symbol);
      }
      view.run.setBars(bars);
      this.refreshStarts(view);
      this.push(view);
    }
  }

  /** A live change to the bars at `index` (see IndicatorRun.update). */
  update(bars: readonly Bar[], times: readonly number[], change: BarChange, index: number): void {
    this.bars = bars;
    this.times = times;
    for (const view of this.views) {
      if (view.indicator.hidden) continue;
      const changed = view.run.update(bars, change, index);
      if (changed === 'all') {
        this.push(view);
        continue;
      }
      for (const i of changed) this.pushPoint(view, i);
      this.refreshDecorations(view);
    }
  }

  /** Each indicator's values on bar `index`, for the legend. */
  valuesAt(index: number): IndicatorValues[] {
    return this.views.map((view) => ({
      id: view.indicator.id,
      values: view.definition.plots.map((_spec, p) =>
        !view.indicator.hidden && index >= (view.starts[p] ?? Number.POSITIVE_INFINITY)
          ? (view.run.values[p]?.[index] ?? Number.NaN)
          : Number.NaN,
      ),
      growing: view.run.growing[index] ?? true,
    }));
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
    for (const view of this.views) view.host?.priceScale().setAutoScale(true);
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
      })),
      levels: view.levels.length,
      fills:
        view.fill?.current().map((shape) => ({
          id: shape.id,
          gradient: shape.kind === 'plots' && typeof shape.color !== 'string',
        })) ?? [],
      valueLabels: view.labels?.current().map((label) => label.text) ?? [],
    }));
  }

  destroy(): void {
    for (const view of this.views) this.teardown(view);
    this.views = [];
  }

  /** Creates the series that draw an indicator, in pane `paneIndex`, and hands them its values. */
  private build(view: IndicatorView, paneIndex: number): void {
    const { definition } = view;
    const { inputs, styles } = view.indicator.settings;
    if (view.indicator.hidden) {
      // Nothing drawn; an indicator with a pane keeps it, as TradingView does.
      if (view.ownPane) {
        view.host = this.chart.addSeries(LineSeries, { visible: false }, paneIndex);
        view.series.push(view.host);
      }
      return;
    }
    const shown = definition.plots.filter((spec) => spec.shownWhen?.(inputs) ?? true);
    shown.forEach((spec, k) => {
      const style = styles[spec.id];
      if (!style) return;
      // A pane's first plot carries its levels and fills, so it exists even when hidden.
      const carries = view.ownPane && k === 0;
      if (!style.visible && !carries) return;
      const ghost = !style.visible;
      const common = {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: this.priceFormat(view),
        priceScaleId: view.ownPane ? 'right' : VOLUME_SCALE,
        ...(carries ? { autoscaleInfoProvider: this.levelScale(view, ghost) } : {}),
      };
      const series =
        spec.kind === 'columns'
          ? this.chart.addSeries(HistogramSeries, { ...common, base: 0 }, paneIndex)
          : this.chart.addSeries(
              LineSeries,
              {
                ...common,
                color: ghost ? CLEAR : withOpacity(style.color, style.opacity),
                lineWidth: (style.width ?? 1) as LineWidth,
                lineStyle: lineStyleOf(style),
                crosshairMarkerVisible: false,
              },
              paneIndex,
            );
      view.series.push(series);
      view.plots.push({ spec, index: definition.plots.indexOf(spec), series, last: -1, ghost });
      if (carries) view.host = series;
    });
    if (!view.ownPane) {
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
        const style = styles[level.id];
        if (!style?.visible) continue;
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
      view.crosshair = new CrosshairPrimitive(
        this.theme.crosshairLabel,
        this.theme.labelText,
        this.font,
        axis,
      );
      host.attachPrimitive(view.fill);
      host.attachPrimitive(view.labels);
      host.attachPrimitive(view.crosshair);
    }
    this.refreshStarts(view);
    this.push(view);
  }

  private teardown(view: IndicatorView): void {
    // Its series take their levels and primitives with them; an emptied pane closes.
    for (const series of view.series) this.chart.removeSeries(series);
    view.series = [];
    view.plots = [];
    view.host = null;
    view.levels = [];
    view.fill = null;
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
    const { inputs } = view.indicator.settings;
    view.starts = view.definition.plots.map((spec) =>
      plotStart(view.definition, spec.id, inputs, this.fromListing),
    );
  }

  /** Hands every drawn plot all its values. */
  private push(view: IndicatorView): void {
    const { times } = this;
    for (const plot of view.plots) {
      const values = view.run.values[plot.index] ?? [];
      const start = view.starts[plot.index] ?? Number.POSITIVE_INFINITY;
      if (plot.spec.kind === 'columns') {
        const series = plot.series as ISeriesApi<'Histogram'>;
        series.setData(
          columnPoints(values, view.run.growing, times, start, this.columnColors(view)),
        );
      } else {
        (plot.series as ISeriesApi<'Line'>).setData(linePoints(values, times, start));
      }
      plot.last = start < times.length ? times.length - 1 : -1;
    }
    this.refreshDecorations(view);
  }

  /** Hands every drawn plot its value on bar `index`. */
  private pushPoint(view: IndicatorView, index: number): void {
    const time = this.times[index];
    if (time === undefined) return;
    for (const plot of view.plots) {
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

  /** Its fills and value labels, after its values changed. */
  private refreshDecorations(view: IndicatorView): void {
    view.fill?.update(this.fills(view));
    view.labels?.update(this.valueLabels(view));
  }

  private fills(view: IndicatorView): FillShape[] {
    const { definition } = view;
    const { inputs, styles } = view.indicator.settings;
    const shapes: FillShape[] = [];
    for (const fill of definition.fills) {
      const style = styles[fill.id];
      if (!style?.visible || !(fill.shownWhen?.(inputs) ?? true)) continue;
      const [a, b] = fill.between.map((edge) => this.fillEdge(view, edge));
      if (!a || !b) continue;
      const color = withOpacity(style.color, style.opacity);
      if (!fill.gradient && typeof a.edge === 'number' && typeof b.edge === 'number') {
        shapes.push({ id: fill.id, kind: 'levels', from: a.edge, to: b.edge, color });
        continue;
      }
      shapes.push({
        id: fill.id,
        kind: 'plots',
        upper: a.edge,
        lower: b.edge,
        start: Math.max(a.start, b.start),
        color: fill.gradient
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
    }
    return shapes;
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
      return { edge: view.indicator.settings.styles[edge]?.value ?? level.style.value, start: 0 };
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
      if (plot.ghost || plot.spec.kind !== 'line') continue;
      if (last < (view.starts[plot.index] ?? Number.POSITIVE_INFINITY)) continue;
      const value = view.run.values[plot.index]?.[last] ?? Number.NaN;
      const style = view.indicator.settings.styles[plot.spec.id];
      if (!Number.isFinite(value) || !style) continue;
      labels.push({
        price: value,
        text: formatIndicatorValue(value, view.format),
        color: style.color,
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
      minMove: format.kind === 'decimals' ? 10 ** -format.decimals : 1e-8,
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
      const { styles } = view.indicator.settings;
      const levels = view.definition.levels
        .filter((level) => styles[level.id]?.visible)
        .map((level) => styles[level.id]?.value ?? level.style.value);
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
