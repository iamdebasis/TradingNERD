import {
  type Bar,
  type BarClock,
  isIntraday,
  type Resolution,
  timeZone,
  UTC_CLOCK,
} from '@tradingnerd/core';
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
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { formatCountdown, formatCrosshairTime, formatPrice, formatTickMark } from './format';
import { installKeyboard } from './interaction/keyboard';
import { installVerticalDrag } from './interaction/verticalDrag';
import { TimeViewport } from './interaction/viewport';
import { installWheel, spacingLimits } from './interaction/wheel';
import { AXIS_LABEL, axisLabelWidth, PRICE_AXIS_MIN_WIDTH } from './plugins/axisLabel';
import { CrosshairPrimitive } from './plugins/CrosshairPrimitive';
import { LastPricePrimitive } from './plugins/LastPricePrimitive';
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

export interface ChartInstrument {
  pricePrecision: number;
  tickSize: number;
  resolution: Resolution;
  /** The exchange's time zone, which the time axis shows (UTC when absent). */
  timezone?: string;
  /** Where its bars begin and end, for the countdown (UTC bars when absent). */
  clock?: BarClock;
  /** How far behind real time its data runs, ms. */
  delayMs?: number;
}

export interface HoverInfo {
  bar: Bar;
  /** The bar before it, for the change figures; null for the very first bar. */
  previous: Bar | null;
}

export interface ChartControllerOptions {
  theme: ChartTheme;
  /** The bar under the cursor, or null once the cursor leaves the pane. */
  onHover?: (info: HoverInfo | null) => void;
  /** Called when less than two screens of history remain to the left of the view. */
  onNeedHistory?: () => void;
  /** Each gesture setting a wheel or trackpad gesture used (see WheelOptions.onGesture). */
  onGesture?: (setting: TuningNumber) => void;
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
  priceAxisWidth: number;
}

const toCandle = (bar: Bar, time: number): CandlestickData<Time> => ({
  time: time as UTCTimestamp,
  open: bar.open,
  high: bar.high,
  low: bar.low,
  close: bar.close,
});

const UTC_ZONES = new Set(['Etc/UTC', 'UTC']);

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
  private readonly crosshair: CrosshairPrimitive;
  private readonly cleanups: (() => void)[] = [];
  private readonly viewport: TimeViewport;
  private bars: Bar[] = [];
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
    this.lastPrice = new LastPricePrimitive(this.font, theme.labelText, axis);
    this.crosshair = new CrosshairPrimitive(theme.crosshairLabel, theme.labelText, this.font, axis);
    this.series.attachPrimitive(this.lastPrice);
    this.series.attachPrimitive(this.crosshair);

    const onCrosshairMove = (param: MouseEventParams<Time>) => this.onCrosshairMove(param);
    this.chart.subscribeCrosshairMove(onCrosshairMove);
    const onRangeChange = (range: LogicalRange | null) => this.checkHistory(range);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

    this.cleanups.push(
      () => this.chart.unsubscribeCrosshairMove(onCrosshairMove),
      () => this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange),
      installWheel(this.chart, this.series, this.viewport, {
        tuning: () => this.tuning,
        lastPrice: () => this.bars.at(-1)?.close ?? null,
        ...(options.onGesture ? { onGesture: options.onGesture } : {}),
      }),
      () => this.viewport.clear(),
      installVerticalDrag(this.chart, this.series),
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
    const { pricePrecision: precision, tickSize, resolution } = instrument;
    // Lightweight Charts has no time zones; it shows UTC, so local times go in as if they were
    // (its docs' own advice). Bars keep their real times everywhere else.
    const zone =
      instrument.timezone && !UTC_ZONES.has(instrument.timezone)
        ? timeZone(instrument.timezone)
        : null;
    this.shift = zone ? (seconds) => seconds + zone.offset(seconds * 1000) / 1000 : null;
    this.series.applyOptions({ priceFormat: { type: 'price', precision, minMove: tickSize } });
    this.chart.applyOptions({
      localization: {
        locale: 'en-US',
        priceFormatter: (price: number) => formatPrice(price, precision),
        // Also records where the tick labels are, so our labels can hide the ones they hit.
        tickmarksPriceFormatter: (prices: readonly number[]) => {
          this.tickPrices = [...prices];
          return prices.map((price) => formatPrice(price, precision));
        },
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

  /** Replaces all data. */
  setBars(bars: readonly Bar[]): void {
    this.bars = [...bars];
    this.setSeriesData();
    this.refreshLastPrice();
  }

  /** Adds older history on the left; the view stays where it is. */
  prependBars(older: readonly Bar[]): void {
    const first = this.bars[0]?.time ?? Number.POSITIVE_INFINITY;
    const fresh = older.filter((bar) => bar.time < first);
    if (fresh.length === 0) return;
    this.bars = [...fresh, ...this.bars];
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
   * Applies a live update to the current bar or opens a new one. A `historical` update corrects
   * an earlier bar (the exchange's final word on it); other stale updates are ignored.
   */
  updateBar(bar: Bar, historical = false): void {
    const last = this.bars.at(-1);
    if (!last || bar.time > last.time) {
      const time = this.displayTime(bar.time, this.displayTimes.at(-1));
      this.bars.push(bar);
      this.displayTimes.push(time);
      this.series.update(toCandle(bar, time));
    } else if (bar.time === last.time) {
      this.bars[this.bars.length - 1] = bar;
      this.series.update(toCandle(bar, this.displayTimes.at(-1) ?? bar.time));
    } else {
      const index = historical ? indexOfTime(this.bars, bar.time) : -1;
      if (index < 0) return;
      this.bars[index] = bar;
      this.series.update(toCandle(bar, this.displayTimes[index] ?? bar.time), true);
    }
    this.refreshLastPrice();
  }

  firstBarTime(): number | null {
    return this.bars[0]?.time ?? null;
  }

  /** The latest bar and the one before it, for the legend when nothing is hovered. */
  latest(): { bar: Bar; previous: Bar | null } | null {
    const bar = this.bars.at(-1);
    return bar ? { bar, previous: this.bars.at(-2) ?? null } : null;
  }

  /** Auto-scale on, default zoom, scrolled to the latest bar (TradingView's Alt + R). */
  resetView(): void {
    this.viewport.clear();
    this.series.priceScale().setAutoScale(true);
    this.chart.timeScale().resetTimeScale();
  }

  /**
   * After new data (another interval or symbol): the latest bar at the default right margin,
   * auto-scale on, and the zoom (bar spacing) kept.
   */
  showLatest(): void {
    this.viewport.clear();
    this.series.priceScale().setAutoScale(true);
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
      priceAxisWidth: this.chart.priceScale('right').width(),
    };
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

  /** The crosshair's time label for a bar time, as the chart draws it. */
  timeLabel(time: number): string {
    const formatter = this.chart.options().localization.timeFormatter;
    const shown = this.shift ? this.shift(time) : time;
    return formatter ? formatter(shown as Time) : String(time);
  }

  destroy(): void {
    clearTimeout(this.countdownTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.chart.remove();
  }

  private onCrosshairMove(param: MouseEventParams<Time>): void {
    const { point, logical } = param;
    if (!point || logical === undefined || this.bars.length === 0) {
      this.crosshair.update(null);
      this.options.onHover?.(null);
      return;
    }
    const price = this.series.coordinateToPrice(point.y);
    this.crosshair.update(price === null ? null : { y: point.y, text: this.format(price) });
    // Past either end of the data, the legend shows the nearest bar, as TradingView does.
    const index = Math.min(Math.max(Math.round(logical), 0), this.bars.length - 1);
    const bar = this.bars[index];
    if (bar) this.options.onHover?.({ bar, previous: this.bars[index - 1] ?? null });
  }

  private checkHistory(range: LogicalRange | null): void {
    if (!range || this.bars.length === 0) return;
    if (range.from < (range.to - range.from) * 2) this.options.onNeedHistory?.();
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
    return formatPrice(price, this.instrument?.pricePrecision ?? 2);
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
