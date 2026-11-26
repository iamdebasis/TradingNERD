import {
  type Bar,
  type BarClock,
  type Drawing,
  formatResolution,
  isIntraday,
  type MarketSchedule,
  type PriceFormat,
  type Resolution,
  type SessionHours,
  timeZone,
  UTC_CLOCK,
  UTC_ZONE,
} from '@tradingnerd/core';
import type { BarChange } from '@tradingnerd/indicators';
import {
  DEFAULT_SYMBOL,
  hexColor,
  type RequestFeed,
  type RequestKey,
  type ScriptSymbol,
} from '@tradingnerd/pine';
import {
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type Logical,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { crosshairLinesShow, cursorCss } from './drawings/cursors';
import {
  DrawingEngine,
  type DrawingEvents,
  type DrawingHost,
  type DrawingSettings,
  type PointerInput,
} from './drawings/DrawingEngine';
import { DrawingLayer, type DrawingLayerHost } from './drawings/DrawingLayer';
import type { Pt } from './drawings/geometry';
import { formatCountdown, formatCrosshairTime, formatTickMark, formatValue } from './format';
import {
  type IndicatorDebugState,
  IndicatorLayer,
  type IndicatorValues,
  type ScriptLibraries,
  type ScriptLogs,
  type ScriptStrategy,
} from './indicators/IndicatorLayer';
import { type ChartIndicator, paneAt } from './indicators/model';
import type { ScriptRunner } from './indicators/script';
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
/**
 * Bars asked for at least, per page of older history, with a Pine script on the chart: each page
 * runs the scripts again over every bar, so fewer, bigger pages (zooming out on 4h with the
 * user's VuManChu B, measured 2026-11-15: 39 s of the tab blocked with 1,000-bar pages, 23 s
 * with these).
 */
export const SCRIPT_PAGE_BARS = 5_000;
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
  /** The time zone the time axis shows (UTC when absent): the exchange's, or the user's choice. */
  timezone?: string;
  /** The exchange's own time zone, which a Pine script's calendar values follow (UTC when absent). */
  exchangeTimezone?: string;
  /** The market's trading calendar, for a Pine script's sessions; absent around the clock. */
  schedule?: MarketSchedule;
  /** The hours an intraday chart shows ("regular" when absent). */
  hours?: SessionHours;
  /** Where its bars begin and end, for the countdown (UTC bars when absent). */
  clock?: BarClock;
  /** How far behind real time its data runs, ms. */
  delayMs?: number;
  /** Its base asset, for Volume's legend ("Vol · XRP"). */
  base?: string;
  /** Whether its bars carry real traded volume: CRYPTOCAP's and formulas' don't (§6.16). */
  hasVolume?: boolean;
}

/** The chart's background as a Pine color (chart.bg_color); the default for other CSS. */
const scriptColor = (css: string): number =>
  /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(css) ? hexColor(css) : DEFAULT_SYMBOL.background;

/**
 * What a Pine script knows of an instrument (syminfo.* and timeframe.*; docs/SPEC.md §6.17): the
 * chart's, and each symbol a script's requests ask for (§6.18), the same way.
 */
export function instrumentSymbol(instrument: ChartInstrument, background: string): ScriptSymbol {
  return {
    ticker: instrument.ticker ?? '',
    tickerid: instrument.tickerid ?? '',
    description: instrument.description ?? '',
    type: instrument.symbolType ?? 'crypto',
    basecurrency: instrument.base ?? '',
    currency: instrument.currency ?? '',
    mintick: instrument.tickSize,
    timeframe: formatResolution(instrument.resolution),
    hasVolume: instrument.hasVolume ?? true,
    timezone: instrument.exchangeTimezone ?? UTC_ZONE,
    session: instrument.hours ?? 'regular',
    clock: instrument.clock ?? UTC_CLOCK,
    schedule: instrument.schedule ?? null,
    background: scriptColor(background),
  };
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
  /**
   * Called when less than two screens of history remain to the left of the view, with how many
   * bars short it is (indicators' warm-up included), so they can come in one page.
   */
  onNeedHistory?: (bars: number) => void;
  /** Each gesture setting a wheel or trackpad gesture used (see WheelOptions.onGesture). */
  onGesture?: (setting: TuningNumber) => void;
  /**
   * After a pane separator is dragged: each indicator pane's height as a share of the price
   * pane's, by its indicator's id, to keep.
   */
  onPaneHeights?: (heights: Record<string, number>) => void;
  /** The panes moved or resized (see paneLayout), e.g. so their legends follow. */
  onLayout?: () => void;
  /**
   * Runs each Pine script in a worker of its own (docs/SPEC.md §6.23), so the page never waits
   * on one; without it, scripts run in the page.
   */
  scriptRunner?: ScriptRunner;
  /**
   * A script's results came from its worker and were drawn: its errors, logs, strategy, requests
   * and legend values may have changed.
   */
  onScripts?: () => void;
  /**
   * The user's drawings (docs/SPEC.md §6.24): each edit made on the chart (the app keeps and
   * saves them, and gives them back with setDrawings), the selection, and a tool's end.
   */
  drawings?: DrawingEvents;
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
  /** The chart's bars a script's barcolor() colors: each one's index and body color. */
  barColors: { index: number; color: string }[];
  /** Every pane, the price pane first: its height in CSS px, stretch factor and auto-scale. */
  panes: { height: number; stretch: number; autoScale: boolean }[];
}

/**
 * A bar as the candles draw it. `body`: a script's barcolor() color, which takes only the body's
 * place: the wick and the border keep the chart's up and down colors (the Pine manual's figure of
 * Bar coloring).
 */
const toCandle = (bar: Bar, time: number, body?: string | null): CandlestickData<Time> => ({
  time: time as UTCTimestamp,
  open: bar.open,
  high: bar.high,
  low: bar.low,
  close: bar.close,
  ...(body ? { color: body } : {}),
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
  /**
   * An invisible series holding one empty point at the first bar's time, so the candles are never
   * the only series with data. Setting a lone series' data again over the same times, Lightweight
   * Charts 5.2.1 rebuilds its map of time points but keeps its sorted list of the old ones; a script's
   * series given its data after that, then the candles set again (barcolor()'s colors), dropped the
   * last bar's place to 0 and every frame threw "Value is null" (reproduced on the library alone,
   * 2026-11-16; 5.3.0 fixes it in replaceTimeScalePoints). Scripts in workers made it likely: their
   * series wait empty while the candles are set (docs/SPEC.md §11, item 139).
   */
  private readonly anchor: ISeriesApi<'Line'>;
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
  /** The user's drawings, and the layer that paints them on each pane's scale series. */
  private readonly drawings: DrawingEngine;
  private readonly drawingLayers = new Map<ISeriesApi<SeriesType>, DrawingLayer>();
  private readonly drawingLayerHost: DrawingLayerHost;
  /** Presses the drawings took: the chart's own drags leave them alone. */
  private readonly takenPresses = new WeakSet<PointerEvent>();
  /** The pointer whose press the drawings took, while it's down. */
  private drawingPointer: number | null = null;
  private drawingCursor: string | null = null;
  private bars: Bar[] = [];
  /** Some bar's body has a script's barcolor() color. */
  private recolored = false;
  /** The first bar is the pair's listing, where TradingView's history starts too. */
  private fromListing = false;
  /** The exchange has no bars older than the chart's first (drawings: a regression trend). */
  private historyEnded = false;
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
    this.anchor = this.chart.addSeries(LineSeries, {
      visible: false,
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
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
    this.indicators = new IndicatorLayer(this.chart, theme, this.font, this.series, {
      ...(options.scriptRunner ? { runner: options.scriptRunner } : {}),
      onScripts: () => this.scriptsChanged(),
    });
    this.drawings = new DrawingEngine(this.drawingHost(), options.drawings ?? {});
    this.drawingLayerHost = {
      engine: this.drawings,
      background: theme.background,
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
      formatPrice: (pane, price) =>
        pane === 0 ? this.format(price) : (this.indicators.paneFormat(pane, price) ?? `${price}`),
      formatTime: (time) => this.timeLabel(time),
      tickSize: (pane) => (pane === 0 ? (this.instrument?.tickSize ?? 0.01) : 0.01),
      tickYs: (pane) => (pane === 0 ? this.tickYs() : this.indicators.paneTickYs(pane)),
      axisBackground: theme.background,
    };
    this.syncDrawingLayers();

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
    // The drawings take a press on one of them, or any while a tool is chosen; the chart's own
    // drags (panning, the price scale's) then leave it alone. Added before the vertical drag's
    // listener, which runs after this one and asks.
    const onDrawingDown = (event: PointerEvent) => this.drawingDown(event);
    const onDrawingMove = (event: PointerEvent) => this.drawingMove(event);
    const onDrawingUp = (event: PointerEvent) => this.drawingUp(event, false);
    const onDrawingCancel = (event: PointerEvent) => this.drawingUp(event, true);
    const onDrawingOpen = (event: MouseEvent) => this.drawingOpen(event);
    const onDrawingMenu = (event: MouseEvent) => this.drawingMenu(event);
    element.addEventListener('pointerdown', onDrawingDown, { capture: true });
    element.addEventListener('dblclick', onDrawingOpen);
    element.addEventListener('contextmenu', onDrawingMenu);
    window.addEventListener('pointermove', onDrawingMove);
    window.addEventListener('pointerup', onDrawingUp);
    window.addEventListener('pointercancel', onDrawingCancel);
    const sizes = new ResizeObserver(() => this.options.onLayout?.());
    sizes.observe(element);

    this.cleanups.push(
      () => this.chart.unsubscribeCrosshairMove(onCrosshairMove),
      () => this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange),
      () => element.removeEventListener('pointerdown', onPointerDown, { capture: true }),
      () => window.removeEventListener('pointermove', onPointerMove),
      () => window.removeEventListener('pointerup', onPointerUp),
      () => cancelAnimationFrame(frame),
      () => element.removeEventListener('pointerdown', onDrawingDown, { capture: true }),
      () => window.removeEventListener('pointermove', onDrawingMove),
      () => window.removeEventListener('pointerup', onDrawingUp),
      () => window.removeEventListener('pointercancel', onDrawingCancel),
      () => element.removeEventListener('dblclick', onDrawingOpen),
      () => element.removeEventListener('contextmenu', onDrawingMenu),
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
      installVerticalDrag(
        this.chart,
        (y) => this.paneAtPoint(y),
        (event) => this.takenPresses.has(event),
      ),
      installKeyboard({
        reset: () => this.resetView(),
        zoom: (notches) => this.zoom(notches),
        scrollBars: (bars) => this.scrollBars(bars),
        // Not while a dialog or a menu has the keys (a menu's arrows move through its items).
        nudge: (bars, dy) =>
          document.querySelector('[role="dialog"], [role="menu"]') === null &&
          this.drawings.nudge(bars, dy),
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
      { symbol: instrumentSymbol(instrument, this.theme.background), priceDecimals: precision },
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
    // Another interval spaces future bars differently, and shows other drawings (Visibility).
    this.drawings.barsChanged();
  }

  /**
   * Replaces all data. `fromListing`: the first bar is the pair's listing, where TradingView's
   * history starts too, so indicators start where TradingView's do (BarsResponse.fromListing).
   */
  setBars(bars: readonly Bar[], fromListing = false, hasMore = true): void {
    this.bars = [...bars];
    this.fromListing = fromListing;
    this.historyEnded = !hasMore;
    this.setSeriesData();
    this.refreshLastPrice();
  }

  /**
   * Adds older history on the left; the view stays where it is. `fromListing` as for setBars;
   * `hasMore` false once the exchange has none older (BarsResponse.hasMore).
   */
  prependBars(older: readonly Bar[], fromListing = false, hasMore = true): void {
    const first = this.bars[0]?.time ?? Number.POSITIVE_INFINITY;
    const fresh = older.filter((bar) => bar.time < first);
    if (fresh.length === 0 && fromListing === this.fromListing) {
      // Only the history's end learned: a regression trend waiting for older bars stops waiting.
      if (this.historyEnded !== !hasMore) {
        this.historyEnded = !hasMore;
        this.drawings.barsChanged();
      }
      return;
    }
    this.bars = [...fresh, ...this.bars];
    this.fromListing = fromListing;
    this.historyEnded = !hasMore;
    this.setSeriesData(fresh.length);
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
    this.afterIndicators();
  }

  /**
   * The Pine libraries scripts import (docs/SPEC.md §5.17): the scripts that import compile again
   * with them when they change.
   */
  setLibraries(libraries: ScriptLibraries): void {
    this.indicators.setLibraries(libraries);
    this.afterIndicators();
  }

  /** After the indicators changed: bar colors, pane heights, history and the panes' layout. */
  private afterIndicators(): void {
    this.recolorBars();
    // An indicator's pane came, went or was built again: its drawings' layer follows its scale.
    this.syncDrawingLayers();
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

  /** Each logging script's Pine Logs, in the legend's order (IndicatorLayer.logs). */
  scriptLogs(): ScriptLogs[] {
    return this.indicators.logs();
  }

  /** Each strategy's trades and figures, in the legend's order (the Strategy Tester). */
  scriptStrategies(): ScriptStrategy[] {
    return this.indicators.strategies();
  }

  /**
   * Where scripts' requests get their data from (docs/SPEC.md §6.18): the app's loader. The
   * scripts run again with it.
   */
  setRequestFeed(feed: RequestFeed | undefined): void {
    this.indicators.setFeed(feed);
    this.recolorBars();
  }

  /** The contexts the scripts on the chart ask for: all they use, and those not loaded yet. */
  scriptRequests(): { used: RequestKey[]; missing: RequestKey[] } {
    return this.indicators.requests();
  }

  /** The scripts waiting for their requests' data, by id (their legend rows say so). */
  waitingIndicators(): Set<string> {
    return this.indicators.waiting();
  }

  /**
   * A requested context's data changed: the scripts that request run again, afresh after a page
   * of its history arrived, or their live bar after a live update.
   */
  requestsChanged(kind: 'history' | 'live'): void {
    this.indicators.refreshRequests(kind);
    this.recolorBars();
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
      this.drawings.barsChanged();
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
    // The update drew the bar in the chart's own colors: its barcolor() color goes back on.
    this.recolorBars(index);
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

  /**
   * Brings bar `index` to the middle of the view, the zoom kept: a Pine Logs entry's Scroll to
   * bar (Pine docs, Debugging). Its time label, as the crosshair writes it, for the tooltip the
   * pane shows over it; null for a bar the chart doesn't have.
   */
  scrollToBar(index: number): string | null {
    const bar = this.bars[index];
    const range = this.viewport.range();
    if (!bar || !range) return null;
    const half = (range.to - range.from) / 2;
    this.viewport.set({ from: index - half, to: index + half });
    return this.timeLabel(bar.time);
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
      // As the candles hold them, not as the scripts would give them.
      barColors: this.series.data().flatMap((point, index) => {
        const color = 'color' in point ? point.color : undefined;
        return color ? [{ index, color }] : [];
      }),
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

  // ---- the user's drawings (docs/SPEC.md §6.24) ----

  /** The chart symbol's drawings, as the app keeps them (in drawing order, the last on top). */
  setDrawings(drawings: readonly Drawing[]): void {
    this.drawings.setDrawings(drawings);
  }

  /**
   * The left toolbar's tool, cursor and modes. The arrow and the eraser hide the crosshair's
   * lines; its labels stay (provisional, §11).
   */
  setDrawingSettings(settings: Partial<DrawingSettings>): void {
    this.drawings.setSettings(settings);
    if (settings.cursor !== undefined) {
      const visible = crosshairLinesShow(settings.cursor);
      this.chart.applyOptions({ crosshair: { vertLine: { visible }, horzLine: { visible } } });
    }
  }

  selectedDrawings(): readonly string[] {
    return this.drawings.selection();
  }

  selectDrawings(ids: readonly string[]): void {
    this.drawings.select(ids);
  }

  /** Escape: a drawing being drawn or dragged, else the selection, else the tool. */
  cancelDrawing(): boolean {
    return this.drawings.cancel();
  }

  /** Delete: the selected drawings go, but locked ones. True when any went. */
  removeSelectedDrawings(): boolean {
    return this.drawings.removeSelected();
  }

  /**
   * The arrow keys: the selected drawings moved by `bars` and `dy` px (D3a). True while any is
   * selected, so the keys don't scroll the chart meanwhile.
   */
  nudgeDrawings(bars: number, dy: number): boolean {
    return this.drawings.nudge(bars, dy);
  }

  /** The bar a drawing's time is on, as its Coordinates tab numbers bars: from the first loaded. */
  drawingBarOf(time: number): number {
    return Math.round(this.drawings.logicalOf(time));
  }

  /** The time of bar `bar` (from the first loaded), past the last at the interval's length. */
  drawingTimeOf(bar: number): number {
    return this.drawings.timeOfLogical(bar);
  }

  /**
   * The drawings' state for the browser tests: the engine's, and each pane's drawings as shown
   * (their points, handles and lines in chart px from the chart's top left).
   */
  debugDrawings(): ReturnType<DrawingEngine['debug']> & {
    shapes: {
      id: string;
      pane: number;
      points: (Pt | null)[];
      handles: Pt[];
      lines: Pt[][];
      looks: { line: Pt[]; color: string }[];
      fills: { points: Pt[]; color: string }[];
      label: string | null;
    }[];
  } {
    const tops = this.paneTops();
    const shapes = this.chart.panes().flatMap((_, pane) =>
      this.drawings.shapes(pane).map((shape) => {
        const top = tops[pane] ?? 0;
        const move = (point: Pt) => ({ x: point.x, y: point.y + top });
        return {
          id: shape.drawing.id,
          pane,
          points: shape.points.map((point) => (point ? move(point) : null)),
          handles: shape.handles.map(move),
          lines: shape.lines.map((line) => line.map(move)),
          looks: shape.looks.map((look) => ({
            line: [move(look.a), move(look.b)],
            color: look.color,
          })),
          fills: shape.fills.map((fill) => ({ points: fill.points.map(move), color: fill.color })),
          label: shape.label?.text ?? null,
        };
      }),
    );
    return { ...this.drawings.debug(), shapes };
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
    const wanted = (range.to - range.from) * 2;
    if (loaded < wanted) {
      const short = Math.ceil(wanted - loaded);
      const scripts = this.indicators.hasScripts();
      this.options.onNeedHistory?.(scripts ? Math.max(short, SCRIPT_PAGE_BARS) : short);
    }
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

  /** Each pane's top, CSS px from the chart's top, the price pane first. */
  private paneTops(): number[] {
    let top = 0;
    return this.chart.panes().map((pane) => {
      const at = top;
      top += pane.getHeight() + PANE_SEPARATOR;
      return at;
    });
  }

  /** What the drawing engine needs of the chart (DrawingHost). */
  private drawingHost(): DrawingHost {
    const timeScale = () => this.chart.timeScale();
    // The library places whole bars only (5.2.1 gives 0 for a fraction), and x is linear in the
    // index: fractions are worked out from bars 0 and 1.
    const origin = () => {
      const x0 = timeScale().logicalToCoordinate(0 as Logical);
      const x1 = timeScale().logicalToCoordinate(1 as Logical);
      return x0 === null || x1 === null || x1 === x0 ? null : { x0, spacing: x1 - x0 };
    };
    return {
      logicalToX: (logical) => {
        const at = origin();
        return at ? at.x0 + logical * at.spacing : null;
      },
      xToLogical: (x) => {
        const at = origin();
        return at ? (x - at.x0) / at.spacing : null;
      },
      priceToY: (pane, price) =>
        pane === 0 ? this.series.priceToCoordinate(price) : this.indicators.paneY(pane, price),
      yToPrice: (pane, y) =>
        pane === 0 ? this.series.coordinateToPrice(y) : this.indicators.paneValue(pane, y),
      paneKey: (pane) => (pane === 0 ? null : this.indicators.paneOwners().get(pane)),
      paneIndex: (key) => {
        if (key === null) return 0;
        for (const [index, id] of this.indicators.paneOwners()) if (id === key) return index;
        return null;
      },
      paneSize: (pane) => {
        if (pane < 0 || pane >= this.chart.panes().length) return null;
        const { width, height } = this.chart.paneSize(pane);
        return { width, height };
      },
      bars: () => this.bars,
      resolution: () => this.instrument?.resolution ?? null,
      // A regression trend's older bars: the same pages back as scrolling loads. Asked once the
      // code that gave the chart its bars has finished, as the engine asks from inside setBars
      // and prependBars, before the app's session counts its load as done (a request then would
      // be dropped).
      needHistory: (bars) => queueMicrotask(() => this.options.onNeedHistory?.(bars)),
      historyEnded: () => this.historyEnded,
      requestUpdate: () => {
        for (const layer of this.drawingLayers.values()) layer.requestUpdate();
      },
      // A drawing being drawn or dragged mustn't move the chart too.
      setPanning: (enabled) =>
        this.chart.applyOptions({
          handleScroll: {
            pressedMouseMove: enabled,
            horzTouchDrag: enabled,
            vertTouchDrag: enabled,
          },
        }),
      setCursor: (cursor) => {
        this.drawingCursor = cursor;
        this.applyDrawingCursor();
      },
    };
  }

  /**
   * One drawing layer on each pane's scale series: the candles', and each indicator pane's
   * first plot's. A series rebuilt or removed takes its layer with it; a new one gets one.
   */
  private syncDrawingLayers(): void {
    const wanted = new Set<ISeriesApi<SeriesType>>();
    this.chart.panes().forEach((_, index) => {
      const series = index === 0 ? this.series : this.indicators.scaleSeries(index);
      if (series) wanted.add(series);
    });
    for (const [series, layer] of this.drawingLayers) {
      if (wanted.has(series)) continue;
      if (layer.isAttached()) series.detachPrimitive(layer);
      this.drawingLayers.delete(series);
    }
    for (const series of wanted) {
      if (this.drawingLayers.has(series)) continue;
      const layer = new DrawingLayer(this.drawingLayerHost);
      series.attachPrimitive(layer);
      this.drawingLayers.set(series, layer);
    }
    this.applyDrawingCursor();
  }

  /**
   * The drawings' cursor on every pane's row: set on the row, it wins over the one the library
   * sets on the chart as the crosshair moves, and the axes keep their own.
   */
  private applyDrawingCursor(): void {
    const css = this.drawingCursor === null ? null : cursorCss(this.drawingCursor);
    for (const pane of this.chart.panes()) {
      const row = pane.getHTMLElement();
      if (!row) continue;
      if (css) row.style.setProperty('cursor', css);
      else row.style.removeProperty('cursor');
    }
  }

  /** Where a pointer is: the pane under it, or pane `pane` however far off it, in pane px. */
  private pointerInput(event: MouseEvent, pane?: number): PointerInput | null {
    const box = this.chart.chartElement().getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const mods = { shift: event.shiftKey, mod: event.ctrlKey || event.metaKey };
    if (pane !== undefined) {
      const top = this.paneTops()[pane];
      return top === undefined ? null : { pane, x, y: y - top, ...mods };
    }
    if (x < 0 || x >= this.chart.paneSize(0).width) return null;
    const hit = paneAt(
      y,
      this.chart.panes().map((item) => item.getHeight()),
    );
    return hit ? { pane: hit.index, x, y: hit.y, ...mods } : null;
  }

  private drawingDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return;
    // A pane separator's handle resizes panes.
    if (event.target instanceof HTMLElement && event.target.style.cursor === 'row-resize') return;
    const input = this.pointerInput(event);
    if (!input || !this.drawings.pointerDown(input)) return;
    this.takenPresses.add(event);
    this.drawingPointer = event.pointerId;
  }

  private drawingMove(event: PointerEvent): void {
    const pressed = this.drawingPointer === event.pointerId;
    const active = this.drawings.activePane();
    if (pressed || active !== null) {
      this.drawings.pointerMove(this.pointerInput(event, active ?? undefined), pressed);
      return;
    }
    // While the chart's own drag runs, nothing is hovered.
    if ((event.buttons & 1) !== 0) return;
    const element = this.chart.chartElement();
    const inside = event.target instanceof Node && element.contains(event.target);
    this.drawings.pointerMove(inside ? this.pointerInput(event) : null, false);
  }

  /**
   * A right-click on a drawing opens its menu (D3a), in place of the browser's; elsewhere the
   * browser's own stays.
   */
  private drawingMenu(event: MouseEvent): void {
    const input = this.pointerInput(event);
    const id = input ? this.drawings.contextAt(input) : null;
    if (id === null) return;
    event.preventDefault();
    this.drawingPointer = null;
    this.options.drawings?.onMenu?.(id, event.clientX, event.clientY);
  }

  /** A double-click on a drawing opens its settings. */
  private drawingOpen(event: MouseEvent): void {
    const input = this.pointerInput(event);
    const hit = input ? this.drawings.hitTest(input.pane, input.x, input.y) : null;
    if (hit) this.options.drawings?.onOpen?.(hit.id);
  }

  private drawingUp(event: PointerEvent, cancelled: boolean): void {
    if (this.drawingPointer !== event.pointerId) return;
    this.drawingPointer = null;
    if (cancelled) {
      this.drawings.cancel();
      return;
    }
    const active = this.drawings.activePane();
    this.drawings.pointerUp(this.pointerInput(event, active ?? undefined));
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

  /**
   * Hands every bar to the series at its local time, each after the one before. `prepended`: how
   * many older bars went before the bars it had (a page of history), else none (a refill).
   */
  private setSeriesData(prepended = 0): void {
    const times: number[] = [];
    const candles: CandlestickData<Time>[] = [];
    for (const bar of this.bars) {
      const time = this.displayTime(bar.time, times.at(-1));
      times.push(time);
      candles.push(toCandle(bar, time));
    }
    this.displayTimes = times;
    // At the candles' first time, before them: they never take the lone series' shortcut.
    const first = candles[0];
    this.anchor.setData(first ? [{ time: first.time }] : []);
    this.series.setData(candles);
    this.recolored = false;
    this.indicators.setBars(this.bars, this.displayTimes, this.fromListing, prepended);
    this.recolorBars();
    this.drawings.barsChanged();
  }

  /**
   * A script's results came from its worker and were drawn: its barcolor() colors go on the
   * bars, its warm-up may want older history, and the app reads the scripts again.
   */
  private scriptsChanged(): void {
    this.recolorBars();
    this.syncDrawingLayers();
    this.checkHistory(this.chart.timeScale().getVisibleLogicalRange());
    this.options.onScripts?.();
  }

  /**
   * Scripts' barcolor() colors on the chart's candles (Pine docs, Bar coloring): every bar when
   * a run started over, else the bars a live update changed (`updated`, which the update drew
   * plain, among them). Without barcolor() nothing is set.
   */
  private recolorBars(updated?: number): void {
    const taken = this.indicators.takeBarColorChanges();
    const changed =
      taken === 'all' || updated === undefined || taken.includes(updated)
        ? taken
        : [...taken, updated];
    const colored = this.indicators.hasBarColors();
    if (!colored && !this.recolored) return;
    const last = this.bars.length - 1;
    if (changed === 'all') {
      this.series.setData(
        this.bars.map((bar, i) =>
          toCandle(bar, this.displayTimes[i] ?? bar.time, this.indicators.barColorAt(i)),
        ),
      );
      this.recolored = colored;
      return;
    }
    for (const i of changed) {
      const bar = this.bars[i];
      const time = this.displayTimes[i];
      if (!bar || time === undefined) continue;
      this.series.update(toCandle(bar, time, this.indicators.barColorAt(i)), i < last);
    }
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
