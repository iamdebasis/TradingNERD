import {
  type Bar,
  type BarClock,
  formatResolution,
  isIntraday,
  type PriceFormat,
  type Resolution,
  timeZone,
  UTC_CLOCK,
} from '@tradingnerd/core';
import type { BarChange } from '@tradingnerd/indicators';
import {
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineStyle,
  type Logical,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { formatCountdown, formatCrosshairTime, formatTickMark, formatValue } from './format';
import {
  type IndicatorDebugState,
  IndicatorLayer,
  type IndicatorValues,
} from './indicators/IndicatorLayer';
import { type ChartIndicator, paneAt } from './indicators/model';
import { installKeyboard } from './interaction/keyboard';
import { installVerticalDrag } from './interaction/verticalDrag';
import { TimeViewport } from './interaction/viewport';
import { installWheel, isOverPriceAxis, spacingLimits } from './interaction/wheel';
import {
  AXIS_LABEL,
  axisLabelBox,
  axisLabelWidth,
  PRICE_AXIS_MIN_WIDTH,
} from './plugins/axisLabel';
import { CrosshairPrimitive } from './plugins/CrosshairPrimitive';
import { ExtendedPricePrimitive, type ExtendedPriceState } from './plugins/ExtendedPricePrimitive';
import { LastPricePrimitive } from './plugins/LastPricePrimitive';
import { SessionShadePrimitive, type SessionShading } from './plugins/SessionShadePrimitive';
import type { ChartTheme } from './theme';
import {
  DEFAULT_GESTURE_TUNING,
  type GestureTuning,
  sanitizeTuning,
  type TuningNumber,
} from './tuning';
import { zoomRange } from './zoom';

/** TradingView defaults: 6 px bars and a right margin of 10 bars. */
export const DEFAULT_BAR_SPACING = 6;
export const DEFAULT_RIGHT_OFFSET = 10;
/** TradingView's default price margins: 10% above the highest bar, 8% below the lowest. */
const SCALE_MARGINS = { top: 0.1, bottom: 0.08 };
/** A pane separator under the mouse: the library's own highlight (provisional, §11). */
const PANE_SEPARATOR_HOVER = 'rgba(178, 181, 189, 0.2)';
/** The library's separator between panes, in CSS px. */
const PANE_SEPARATOR = 1;

export interface ChartInstrument {
  pricePrecision: number;
  tickSize: number;
  /** What a Pine script knows of the symbol (syminfo.*; docs/SPEC.md §6.17). */
  ticker?: string;
  /** "BINANCE:XRPUSDT" */
  tickerid?: string;
  description?: string;
  /** Pine's syminfo.type: "crypto", "stock", "fund", "index", "spread". */
  symbolType?: string;
  /** The currency its prices are in. */
  currency?: string;
  /** How prices are written: market caps in thousands to trillions ("price" when absent). */
  format?: PriceFormat;
  resolution: Resolution;
  /** The exchange's time zone, which the time axis shows (UTC when absent). */
  timezone?: string;
  /** Where its bars begin and end, for the countdown (UTC bars when absent). */
  clock?: BarClock;
  /** How far behind real time its data runs, ms. */
  delayMs?: number;
  /** Its base asset, for Volume's legend ("Vol · XRP"). */
  base?: string;
  /** Whether its bars carry real traded volume: CRYPTOCAP's and formulas' don't (§6.16). */
  hasVolume?: boolean;
}

/** The pre/post-market price line: the price, its "Pre"/"Post" tag and color. */
export type ExtendedPrice = Omit<ExtendedPriceState, 'text'>;

export interface HoverInfo {
  bar: Bar;
  /** The bar before it, for the change figures; null for the very first bar. */
  previous: Bar | null;
  /** Its place in the chart's bars, for the indicators' values (indicatorValues). */
  index: number;
}

export interface ChartControllerOptions {
  theme: ChartTheme;
  /** The bar under the cursor, or null once the cursor leaves the pane. */
  onHover?: (info: HoverInfo | null) => void;
  /** Called when less than two screens of history remain to the left of the view. */
  onNeedHistory?: () => void;
  /** Each gesture setting a wheel or trackpad gesture used (see WheelOptions.onGesture). */
  onGesture?: (setting: TuningNumber) => void;
  /**
   * After a pane separator is dragged: each indicator pane's height as a share of the price
   * pane's, by its indicator's id, to keep.
   */
  onPaneHeights?: (heights: Record<string, number>) => void;
  /** The panes moved or resized (see paneLayout), e.g. so their legends follow. */
  onLayout?: () => void;
}

/** A snapshot of the chart's state for tests and diagnostics. */
export interface ChartDebugState {
  logicalRange: LogicalRange | null;
  scrollPosition: number;
  width: number;
  priceRange: { from: number; to: number } | null;
  autoScale: boolean;
  barCount: number;
  firstBarTime: number | null;
  lastBar: Bar | null;
  paneWidth: number;
  paneHeight: number;
  /** The last-price label as drawn on the price axis. */
  lastPriceLabel: { text: string; countdown: string | null; color: string } | null;
  /** The pre/post-market price line's label, when one shows. */
  extendedPriceLabel: { text: string; tag: string; color: string } | null;
  /** The pre/post market background bands drawn last (pane x, CSS px). */
  sessionBands: readonly { left: number; right: number; color: string }[];
  priceAxisWidth: number;
  /** The indicators drawn, in the legend's order. */
  indicators: IndicatorDebugState[];
  /** Every pane, the price pane first: its height in CSS px, stretch factor and auto-scale. */
  panes: { height: number; stretch: number; autoScale: boolean }[];
}

const toCandle = (bar: Bar, time: number): CandlestickData<Time> => ({
  time: time as UTCTimestamp,
  open: bar.open,
  high: bar.high,
  low: bar.low,
  close: bar.close,
});

const UTC_ZONES = new Set(['Etc/UTC', 'UTC']);

const extendedLabel = (state: ExtendedPriceState | null) =>
  state ? { text: state.text, tag: state.tag, color: state.color } : null;

/** Index of the bar opening at `time` in an ascending array, or -1. */
function indexOfTime(bars: readonly Bar[], time: number): number {
  let low = 0;
  let high = bars.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const t = bars[mid]?.time ?? 0;
    if (t === time) return mid;
    if (t < time) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/**
 * The candlestick chart: Lightweight Charts configured like TradingView, plus our own price-axis
 * labels and gesture handling. Purely imperative, so live updates never involve React.
 */
export class ChartController {
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<'Candlestick'>;
  private readonly theme: ChartTheme;
  private readonly options: ChartControllerOptions;
  private readonly font: string;
  private readonly lastPrice: LastPricePrimitive;
  private readonly extendedPrice: ExtendedPricePrimitive;
  private readonly sessionShade: SessionShadePrimitive;
  private readonly crosshair: CrosshairPrimitive;
  private readonly cleanups: (() => void)[] = [];
  private readonly viewport: TimeViewport;
  private readonly indicators: IndicatorLayer;
  private bars: Bar[] = [];
  /** The first bar is the pair's listing, where TradingView's history starts too. */
  private fromListing = false;
  /** The indicator panes' heights last applied or told, to tell only a change. */
  private paneHeights: Record<string, number> = {};
  private layoutFrame = 0;
  /** The chart's time for each bar: its UTC time shifted to the exchange's local clock. */
  private displayTimes: number[] = [];
  private instrument: ChartInstrument | null = null;
  /** Seconds to add to a UTC time for the exchange's local time, or null for UTC. */
  private shift: ((seconds: number) => number) | null = null;
  private tuning: GestureTuning = DEFAULT_GESTURE_TUNING;
  private countdownTimer: ReturnType<typeof setTimeout> | undefined;
  private axisWidth = 0;
  private measureContext: CanvasRenderingContext2D | null = null;
  /** Prices of the tick labels currently on the price axis. */
  private tickPrices: readonly number[] = [];

  constructor(container: HTMLElement, options: ChartControllerOptions) {
    const { theme } = options;
    this.theme = theme;
    this.options = options;
    this.font = `${theme.fontSize}px ${theme.fontFamily}`;

    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: theme.background },
        textColor: theme.axisText,
        fontFamily: theme.fontFamily,
        fontSize: theme.fontSize,
        attributionLogo: true,
        panes: {
          separatorColor: theme.paneSeparator,
          separatorHoverColor: PANE_SEPARATOR_HOVER,
          enableResize: true,
        },
      },
      grid: { vertLines: { color: theme.grid }, horzLines: { color: theme.grid } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.LargeDashed,
          labelBackgroundColor: theme.crosshairLabel,
        },
        // The price label is drawn by CrosshairPrimitive in TradingView's style.
        horzLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.LargeDashed,
          labelVisible: false,
        },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: SCALE_MARGINS },
      timeScale: {
        borderVisible: false,
        barSpacing: DEFAULT_BAR_SPACING,
        rightOffset: DEFAULT_RIGHT_OFFSET,
        minBarSpacing: 0.5,
        // Tick bars are numbered, not timed: label them with their first trade's time. Other
        // intervals keep the library's own labels (null).
        tickMarkFormatter: (time: Time) => {
          const start = this.isTicks() ? this.tickStart(time as number) : undefined;
          return start === undefined ? null : formatTickMark(start);
        },
      },
      // The wheel is ours (see installWheel); dragging, pinching and the axes stay with the library.
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: false,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      kineticScroll: { mouse: true, touch: true },
      localization: { locale: 'en-US' },
    });

    this.viewport = new TimeViewport(this.chart);
    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
      // Replaced by LastPricePrimitive.
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const axis = { tickYs: () => this.tickYs(), background: theme.background };
    this.sessionShade = new SessionShadePrimitive(() => this.bars);
    this.extendedPrice = new ExtendedPricePrimitive(this.font, theme.labelText, axis, () =>
      this.lastPriceBox(),
    );
    this.lastPrice = new LastPricePrimitive(this.font, theme.labelText, axis);
    this.crosshair = new CrosshairPrimitive(theme.crosshairLabel, theme.labelText, this.font, axis);
    // Drawn in this order: the last price over a pre/post-market price at the same level.
    this.series.attachPrimitive(this.sessionShade);
    this.series.attachPrimitive(this.extendedPrice);
    this.series.attachPrimitive(this.lastPrice);
    this.series.attachPrimitive(this.crosshair);
    this.indicators = new IndicatorLayer(this.chart, theme, this.font);

    const onCrosshairMove = (param: MouseEventParams<Time>) => this.onCrosshairMove(param);
    this.chart.subscribeCrosshairMove(onCrosshairMove);
    const onRangeChange = (range: LogicalRange | null) => this.checkHistory(range);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    // The library resizes panes itself: while a separator is dragged, the panes' legends
    // follow it, and its new heights are told when the pointer is let go.
    let resizing = false;
    let frame = 0;
    const element = this.chart.chartElement();
    const onPointerDown = (event: PointerEvent) => {
      resizing = event.target instanceof HTMLElement && event.target.style.cursor === 'row-resize';
    };
    const onPointerMove = () => {
      if (!resizing || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        this.options.onLayout?.();
      });
    };
    const onPointerUp = () => {
      if (!resizing) return;
      resizing = false;
      this.tellPaneHeights();
      this.options.onLayout?.();
    };
    element.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    const sizes = new ResizeObserver(() => this.options.onLayout?.());
    sizes.observe(element);

    this.cleanups.push(
      () => this.chart.unsubscribeCrosshairMove(onCrosshairMove),
      () => this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange),
      () => element.removeEventListener('pointerdown', onPointerDown, { capture: true }),
      () => window.removeEventListener('pointermove', onPointerMove),
      () => window.removeEventListener('pointerup', onPointerUp),
      () => cancelAnimationFrame(frame),
      () => sizes.disconnect(),
      installWheel(this.chart, this.viewport, {
        tuning: () => this.tuning,
        lastPrice: () => this.bars.at(-1)?.close ?? null,
        priceAxisAt: (x, y) => {
          const pane = this.paneAtPoint(y);
          const size = { width: this.chart.paneSize(0).width, height: pane?.height ?? 0 };
          return pane && isOverPriceAxis(x, pane.y, size) ? pane : null;
        },
        ...(options.onGesture ? { onGesture: options.onGesture } : {}),
      }),
      () => this.viewport.clear(),
      installVerticalDrag(this.chart, (y) => this.paneAtPoint(y)),
      installKeyboard({
        reset: () => this.resetView(),
        zoom: (notches) => this.zoom(notches),
        scrollBars: (bars) => this.scrollBars(bars),
      }),
    );
    this.scheduleCountdown();
  }

  setInstrument(instrument: ChartInstrument): void {
    this.instrument = instrument;
    const { pricePrecision: precision, tickSize, resolution, format } = instrument;
    // Lightweight Charts has no time zones; it shows UTC, so local times go in as if they were
    // (its docs' own advice). Bars keep their real times everywhere else.
    const zone =
      instrument.timezone && !UTC_ZONES.has(instrument.timezone)
        ? timeZone(instrument.timezone)
        : null;
    this.shift = zone ? (seconds) => seconds + zone.offset(seconds * 1000) / 1000 : null;
    // The candles' own format, not the chart's: each indicator pane's scale writes its own.
    this.series.applyOptions({
      priceFormat: {
        type: 'custom',
        minMove: tickSize,
        formatter: (price: number) => formatValue(price, precision, format),
        // Also records where the tick labels are, so our labels can hide the ones they hit.
        tickmarksFormatter: (prices: readonly number[]) => {
          this.tickPrices = [...prices];
          return prices.map((price) => formatValue(price, precision, format));
        },
      },
    });
    this.indicators.setSymbol(
      { base: instrument.base ?? '', hasVolume: instrument.hasVolume ?? true },
      {
        symbol: {
          ticker: instrument.ticker ?? '',
          tickerid: instrument.tickerid ?? '',
          description: instrument.description ?? '',
          type: instrument.symbolType ?? 'crypto',
          basecurrency: instrument.base ?? '',
          currency: instrument.currency ?? '',
          mintick: tickSize,
          timeframe: formatResolution(resolution),
          hasVolume: instrument.hasVolume ?? true,
        },
        priceDecimals: precision,
      },
    );
    this.chart.applyOptions({
      localization: {
        locale: 'en-US',
        timeFormatter: (time: Time) => {
          // A tick bar's `time` is its number; show when its first trade happened.
          const start = resolution.unit === 'tick' ? this.tickStart(time as number) : undefined;
          const seconds = start === undefined ? (time as number) : start / 1000;
          return formatCrosshairTime(seconds, resolution);
        },
      },
      timeScale: {
        timeVisible: isIntraday(resolution),
        secondsVisible: resolution.unit === 'second' || resolution.unit === 'tick',
      },
    });
    this.refreshLastPrice();
  }

  /**
   * Replaces all data. `fromListing`: the first bar is the pair's listing, where TradingView's
   * history starts too, so indicators start where TradingView's do (BarsResponse.fromListing).
   */
  setBars(bars: readonly Bar[], fromListing = false): void {
    this.bars = [...bars];
    this.fromListing = fromListing;
    this.setSeriesData();
    this.refreshLastPrice();
  }

  /** Adds older history on the left; the view stays where it is. `fromListing` as for setBars. */
  prependBars(older: readonly Bar[], fromListing = false): void {
    const first = this.bars[0]?.time ?? Number.POSITIVE_INFINITY;
    const fresh = older.filter((bar) => bar.time < first);
    if (fresh.length === 0 && fromListing === this.fromListing) return;
    this.bars = [...fresh, ...this.bars];
    this.fromListing = fromListing;
    this.setSeriesData();
  }

  /** Replaces everything from the first of `recent` onward, e.g. to refill a gap after a reconnect. */
  mergeRecent(recent: readonly Bar[]): void {
    const first = recent[0];
    if (!first) return;
    this.bars = [...this.bars.filter((bar) => bar.time < first.time), ...recent];
    this.setSeriesData();
    this.refreshLastPrice();
  }

  /**
   * The indicators to draw, in the legend's order (docs/SPEC.md §6.16): added, changed and
   * removed ones are brought in line, each computed over the chart's bars.
   */
  setIndicators(indicators: readonly ChartIndicator[]): void {
    this.indicators.set(indicators);
    this.paneHeights = this.indicators.paneHeights();
    // A new indicator may wait on older bars than the chart has.
    this.checkHistory(this.chart.timeScale().getVisibleLogicalRange());
    // The library lays a new pane out on its next frame: tell of the layout then, too.
    this.options.onLayout?.();
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => this.options.onLayout?.());
  }

  /**
   * Each pane's place in the chart (CSS px from its top), the price pane first, and the
   * indicator in it (none for the price pane), for the panes' legends.
   */
  paneLayout(): { top: number; height: number; indicator: string | null }[] {
    const owners = this.indicators.paneOwners();
    let top = 0;
    return this.chart.panes().map((pane, index) => {
      const height = pane.getHeight();
      const box = { top, height, indicator: owners.get(index) ?? null };
      top += height + PANE_SEPARATOR;
      return box;
    });
  }

  /** Each indicator's values on bar `index` (HoverInfo.index), NaN where none shows. */
  indicatorValues(index: number): IndicatorValues[] {
    return this.indicators.valuesAt(index);
  }

  /** Why each script on the chart draws nothing, by its id: its compile or runtime error. */
  indicatorErrors(): Map<string, string> {
    return this.indicators.errors();
  }

  /**
   * Applies a live update to the current bar or opens a new one. A `historical` update corrects
   * an earlier bar (the exchange's final word on it); other stale updates are ignored.
   */
  updateBar(bar: Bar, historical = false): void {
    const last = this.bars.at(-1);
    let change: BarChange;
    let index = this.bars.length - 1;
    if (!last || bar.time > last.time) {
      const time = this.displayTime(bar.time, this.displayTimes.at(-1));
      this.bars.push(bar);
      this.displayTimes.push(time);
      this.series.update(toCandle(bar, time));
      change = 'new';
      index = this.bars.length - 1;
    } else if (bar.time === last.time) {
      this.bars[this.bars.length - 1] = bar;
      this.series.update(toCandle(bar, this.displayTimes.at(-1) ?? bar.time));
      change = 'tick';
    } else {
      index = historical ? indexOfTime(this.bars, bar.time) : -1;
      if (index < 0) return;
      this.bars[index] = bar;
      this.series.update(toCandle(bar, this.displayTimes[index] ?? bar.time), true);
      change = 'correction';
    }
    this.indicators.update(this.bars, this.displayTimes, change, index);
    this.refreshLastPrice();
  }

  firstBarTime(): number | null {
    return this.bars[0]?.time ?? null;
  }

  /**
   * TradingView's pre/post market hours background, for a chart showing extended hours:
   * which bars are pre- or post-market and their colors. Null hides it.
   */
  setSessionShading(shading: SessionShading | null): void {
    this.sessionShade.update(shading);
  }

  /** TradingView's pre/post-market price line, for a chart showing regular hours; null hides it. */
  setExtendedPrice(price: ExtendedPrice | null): void {
    this.extendedPrice.update(price ? { ...price, text: this.format(price.price) } : null);
  }

  /** The latest bar and the one before it, for the legend when nothing is hovered. */
  latest(): { bar: Bar; previous: Bar | null; index: number } | null {
    const bar = this.bars.at(-1);
    return bar ? { bar, previous: this.bars.at(-2) ?? null, index: this.bars.length - 1 } : null;
  }

  /** Auto-scale on, default zoom, scrolled to the latest bar (TradingView's Alt + R). */
  resetView(): void {
    this.viewport.clear();
    this.series.priceScale().setAutoScale(true);
    this.indicators.autoScale();
    this.chart.timeScale().resetTimeScale();
  }

  /**
   * After new data (another interval or symbol): the latest bar at the default right margin,
   * auto-scale on, and the zoom (bar spacing) kept.
   */
  showLatest(): void {
    this.viewport.clear();
    this.series.priceScale().setAutoScale(true);
    this.indicators.autoScale();
    this.chart.timeScale().scrollToPosition(DEFAULT_RIGHT_OFFSET, false);
  }

  /** Zooms by notches with the right edge fixed (TradingView's Ctrl/⌘ + ↑/↓). */
  zoom(notches: number): void {
    const range = this.viewport.range();
    if (!range) return;
    this.viewport.set(
      zoomRange(range, this.viewport.width(), notches, null, spacingLimits(this.chart)),
    );
  }

  /** Scrolls by whole bars; negative goes back in time. */
  scrollBars(bars: number): void {
    const range = this.viewport.range();
    if (!range) return;
    this.viewport.set({ from: range.from + bars, to: range.to + bars });
  }

  /**
   * Overrides gesture constants that are still being calibrated against TradingView (used by
   * the dev-only tuning panel). Out-of-range values are clamped; omitted ones are kept.
   */
  setGestureTuning(tuning: Partial<GestureTuning>): void {
    this.tuning = sanitizeTuning(tuning, this.tuning);
  }

  gestureTuning(): GestureTuning {
    return this.tuning;
  }

  debugState(): ChartDebugState {
    const timeScale = this.chart.timeScale();
    const priceScale = this.series.priceScale();
    const pane = this.chart.paneSize();
    return {
      logicalRange: timeScale.getVisibleLogicalRange(),
      scrollPosition: timeScale.scrollPosition(),
      width: timeScale.width(),
      priceRange: priceScale.getVisibleRange(),
      autoScale: priceScale.options().autoScale,
      barCount: this.bars.length,
      firstBarTime: this.firstBarTime(),
      lastBar: this.bars.at(-1) ?? null,
      paneWidth: pane.width,
      paneHeight: pane.height,
      lastPriceLabel: this.lastPrice.current(),
      extendedPriceLabel: extendedLabel(this.extendedPrice.current()),
      sessionBands: this.sessionShade.drawnBands(),
      priceAxisWidth: this.chart.priceScale('right').width(),
      indicators: this.indicators.debug(),
      panes: this.chart.panes().map((pane, index) => {
        const series = index === 0 ? this.series : this.indicators.scaleSeries(index);
        return {
          height: pane.getHeight(),
          stretch: pane.getStretchFactor(),
          autoScale: series ? series.priceScale().options().autoScale : true,
        };
      }),
    };
  }

  /** The bars the chart holds, oldest first: what the browser tests compute indicators over. */
  debugBars(): Bar[] {
    return [...this.bars];
  }

  /** Chart y (CSS px from its top) of a price in an indicator's own pane, or null. */
  indicatorPriceToY(id: string, price: number): number | null {
    const y = this.indicators.priceToY(id, price);
    if (y === null) return null;
    const pane = this.paneLayout().find((item) => item.indicator === id);
    return pane ? pane.top + y : null;
  }

  /** Pane x of the bar at a logical index (whole bars only). */
  barX(index: number): number | null {
    return this.chart.timeScale().logicalToCoordinate(index as Logical);
  }

  /** Pane y of a price, or null when it's off-screen. */
  priceToY(price: number): number | null {
    return this.series.priceToCoordinate(price);
  }

  /** Price at a pane y. */
  yToPrice(y: number): number | null {
    return this.series.coordinateToPrice(y);
  }

  /** A price as the price scale labels it ("1.8T" for a market cap). */
  priceLabel(price: number): string {
    return this.format(price);
  }

  /** The crosshair's time label for a bar time, as the chart draws it. */
  timeLabel(time: number): string {
    const formatter = this.chart.options().localization.timeFormatter;
    const shown = this.shift ? this.shift(time) : time;
    return formatter ? formatter(shown as Time) : String(time);
  }

  destroy(): void {
    clearTimeout(this.countdownTimer);
    cancelAnimationFrame(this.layoutFrame);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.indicators.destroy();
    this.chart.remove();
  }

  private onCrosshairMove(param: MouseEventParams<Time>): void {
    const { point, logical } = param;
    if (!point || logical === undefined || this.bars.length === 0) {
      this.crosshair.update(null);
      this.indicators.crosshairAt(null, null);
      this.options.onHover?.(null);
      return;
    }
    // The price label shows in the pane the pointer is in, with that pane's value.
    const pane = param.paneIndex ?? 0;
    if (pane === 0) {
      const price = this.series.coordinateToPrice(point.y);
      this.crosshair.update(price === null ? null : { y: point.y, text: this.format(price) });
    } else {
      this.crosshair.update(null);
    }
    this.indicators.crosshairAt(pane, point.y);
    // Past either end of the data, the legend shows the nearest bar, as TradingView does.
    const index = Math.min(Math.max(Math.round(logical), 0), this.bars.length - 1);
    const bar = this.bars[index];
    if (bar) this.options.onHover?.({ bar, previous: this.bars[index - 1] ?? null, index });
  }

  private checkHistory(range: LogicalRange | null): void {
    if (!range || this.bars.length === 0) return;
    // Bars an indicator still waits on count as history not loaded yet (the warm-up rule).
    const loaded = range.from - this.indicators.waitingBars();
    if (loaded < (range.to - range.from) * 2) this.options.onNeedHistory?.();
  }

  /** The pane at a chart y (CSS px from the chart's top): its scale's series and the y in it. */
  private paneAtPoint(
    y: number,
  ): { series: ISeriesApi<SeriesType>; y: number; height: number; main: boolean } | null {
    const heights = this.chart.panes().map((pane) => pane.getHeight());
    const hit = paneAt(y, heights);
    if (!hit) return null;
    const series = hit.index === 0 ? this.series : this.indicators.scaleSeries(hit.index);
    if (!series) return null;
    return { series, y: hit.y, height: heights[hit.index] ?? 0, main: hit.index === 0 };
  }

  /** Tells the app of indicator panes resized by dragging a separator. */
  private tellPaneHeights(): void {
    if (!this.options.onPaneHeights) return;
    const heights = this.indicators.paneHeights();
    const ids = Object.keys(heights);
    const changed =
      ids.length !== Object.keys(this.paneHeights).length ||
      ids.some((id) => Math.abs((heights[id] ?? 0) - (this.paneHeights[id] ?? 0)) > 1e-6);
    if (!changed) return;
    this.paneHeights = heights;
    this.options.onPaneHeights(heights);
  }

  private tickYs(): number[] {
    const ys: number[] = [];
    for (const price of this.tickPrices) {
      const y = this.series.priceToCoordinate(price);
      if (y !== null) ys.push(y);
    }
    return ys;
  }

  private isTicks(): boolean {
    return this.instrument?.resolution.unit === 'tick';
  }

  /** When tick bar number `time` began (its first trade, ms), if it is loaded. */
  private tickStart(time: number): number | undefined {
    return this.bars[indexOfTime(this.bars, time)]?.start;
  }

  private format(price: number): string {
    return formatValue(price, this.instrument?.pricePrecision ?? 2, this.instrument?.format);
  }

  /**
   * The time left in the current bar, TradingView's way: none while the market is closed, and
   * with delayed data none until the bar it shows closes after now (with a 15-minute delay,
   * only intervals over 15 minutes have one).
   */
  private countdownText(lastBar: Bar): string | null {
    const resolution = this.instrument?.resolution;
    if (!resolution || resolution.unit === 'tick') return null;
    const clock = this.instrument?.clock ?? UTC_CLOCK;
    const now = Date.now();
    const shown = now - (this.instrument?.delayMs ?? 0);
    if (!clock.isOpen(shown)) return null;
    const currentOpen = clock.open(resolution, shown);
    // No countdown for stale data (e.g. a delisted market): only for the current or previous bar.
    if (clock.close(resolution, lastBar.time * 1000) < currentOpen) return null;
    const left = clock.close(resolution, currentOpen) - now;
    return left > 0 ? formatCountdown(left) : null;
  }

  /** Hands every bar to the series at its local time, each after the one before. */
  private setSeriesData(): void {
    const times: number[] = [];
    const candles: CandlestickData<Time>[] = [];
    for (const bar of this.bars) {
      const time = this.displayTime(bar.time, times.at(-1));
      times.push(time);
      candles.push(toCandle(bar, time));
    }
    this.displayTimes = times;
    this.series.setData(candles);
    this.indicators.setBars(this.bars, this.displayTimes, this.fromListing);
  }

  /**
   * A bar's time on the chart: its exchange's local clock time. Where clocks turn back, local
   * times can repeat, so a time is never allowed before the previous one.
   */
  private displayTime(time: number, previous: number | undefined): number {
    const local = this.shift ? this.shift(time) : time;
    return previous !== undefined && local <= previous ? previous + 1 : local;
  }

  private refreshLastPrice(): void {
    const last = this.bars.at(-1);
    if (!last || !this.instrument) {
      this.lastPrice.update(null);
      return;
    }
    const text = this.format(last.close);
    const countdown = this.countdownText(last);
    this.lastPrice.update({
      price: last.close,
      text,
      countdown,
      color: last.close >= last.open ? this.theme.up : this.theme.down,
    });
    this.fitPriceAxis(text, countdown);
  }

  /** The last price's label on the axis (pane y), as LastPricePrimitive draws it. */
  private lastPriceBox(): { top: number; bottom: number; price: number } | null {
    const last = this.lastPrice.current();
    const y = last ? this.series.priceToCoordinate(last.price) : null;
    if (!last || y === null) return null;
    const { top, heights } = axisLabelBox(y, last.countdown ? 2 : 1, AXIS_LABEL.priceRowHeight);
    return { top, bottom: top + heights.reduce((sum, h) => sum + h, 0), price: last.price };
  }

  /** Widens the price axis so our labels fit, like TradingView's axis does. */
  private fitPriceAxis(price: string, countdown: string | null): void {
    this.measureContext ??= document.createElement('canvas').getContext('2d');
    if (!this.measureContext) return;
    // Measure with every digit as 0 so the axis doesn't twitch as the numbers change.
    const rows = [price, countdown ?? ''].map((text) => text.replace(/\d/g, '0'));
    const label = axisLabelWidth(this.measureContext, rows, this.font);
    const width = Math.max(
      PRICE_AXIS_MIN_WIDTH,
      AXIS_LABEL.left + label + AXIS_LABEL.minRightMargin,
    );
    if (width !== this.axisWidth) {
      this.axisWidth = width;
      this.chart.priceScale('right').applyOptions({ minimumWidth: width });
    }
  }

  private scheduleCountdown(): void {
    // Tick just after each whole second so the label changes in step with the clock.
    const wait = () => 1_000 - (Date.now() % 1_000) + 5;
    const tick = () => {
      this.refreshLastPrice();
      this.countdownTimer = setTimeout(tick, wait());
    };
    this.countdownTimer = setTimeout(tick, wait());
  }
}
