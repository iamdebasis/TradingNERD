import type { ChartController, ExtendedPrice, HoverInfo, SessionShading } from '@tradingnerd/chart';
import {
  type Bar,
  isIntraday,
  MarketSchedule,
  type MarketStatus,
  marketStatus,
  parseResolution,
  type Resolution,
  type SessionHours,
  type SymbolInfo,
  sessionClock,
  UTC_CLOCK,
} from '@tradingnerd/core';
import { ApiError, type MarketApi } from '../data/api';
import type { LiveFeed } from '../data/GatewayConnection';
import { hasRealVolume, volumeUnit } from '../indicators/symbolVolume';
import { type ChartSettings, DEFAULT_CHART_SETTINGS, type Fill } from './chartSettings';
import { intlZone } from './timezones';

export type LegendStatus = 'loading' | 'live' | 'reconnecting' | 'error';

/** What the session tells the legend overlay. */
export interface LegendView {
  setInstrument(info: SymbolInfo, resolution: Resolution): void;
  /** `index`: the bar's place on the chart, for the indicators' values on it. */
  showBar(bar: Bar, previous: Bar | null, index: number): void;
  setBook(bid: number, ask: number): void;
  setStatus(status: LegendStatus, message?: string): void;
  /** Where the symbol's market is in its day: TradingView's market status icon. */
  setMarketStatus(status: MarketStatus): void;
}

/** The parts of ChartController a session drives; an interface so tests can use a fake. */
export type ChartSurface = Pick<
  ChartController,
  | 'setInstrument'
  | 'setBars'
  | 'prependBars'
  | 'mergeRecent'
  | 'updateBar'
  | 'firstBarTime'
  | 'latest'
  | 'showLatest'
  | 'setSessionShading'
  | 'setExtendedPrice'
>;

export interface ChartSessionOptions {
  chart: ChartSurface;
  api: MarketApi;
  feed: LiveFeed;
  legend: LegendView;
  symbol: string;
  /** TradingView notation, e.g. "1D" or "60". */
  resolution: string;
  /** Told of each failure's code, e.g. `needs_key` when a stock needs the Alpaca key. */
  onError?: (code: string) => void;
  /** Chart settings → Symbol: the session, time zone and pre/post market backgrounds. */
  settings?: ChartSettings;
  /** Told of the symbol once it's resolved. */
  onInfo?: (info: SymbolInfo) => void;
}

/** Bars fetched when the chart opens, per scroll-back page, and to refill after a reconnect. */
export const INITIAL_BARS = 1_000;
export const PAGE_BARS = 1_000;
export const RESYNC_BARS = 1_000;
/** After a failed page load, wait this long before trying again. */
export const HISTORY_RETRY_MS = 2_000;

/**
 * The pre/post-market price line's colors: the pre-market orange measured from a TradingView
 * screenshot, the post-market blue provisional (docs/SPEC.md §11).
 */
export const EXTENDED_PRICE_COLORS = { pre: '#FB8C00', post: '#2962FF' } as const;

/**
 * One symbol and interval on the chart: loads history, follows the live feed, pages back on
 * demand, refills after reconnects, and keeps the legend in step with the cursor. The chart
 * itself outlives sessions: switching interval starts a new session on the same chart.
 */
export class ChartSession {
  private readonly options: ChartSessionOptions;
  private readonly abort = new AbortController();
  private readonly unsubscribes: (() => void)[] = [];
  private symbolId: string | null = null;
  private hasMore = true;
  /** The first page is on the chart; until then the chart may still show another interval. */
  private loaded = false;
  private loadingOlder = false;
  private retryAt = 0;
  private hoveredTime: number | null = null;
  private wasReconnecting = false;
  private disposed = false;
  /** The symbol's trading calendar; null for a market that never closes. */
  private schedule: MarketSchedule | null = null;
  /** The hours its intraday bars cover: extended only for a stock's intraday chart. */
  private hours: SessionHours = 'regular';
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ChartSessionOptions) {
    this.options = options;
  }

  private get settings(): ChartSettings {
    return this.options.settings ?? DEFAULT_CHART_SETTINGS;
  }

  async start(): Promise<void> {
    const { chart, api, legend, symbol } = this.options;
    const resolution = parseResolution(this.options.resolution);
    if (!resolution) {
      legend.setStatus('error', `"${this.options.resolution}" is not a valid interval`);
      return;
    }
    legend.setStatus('loading');
    try {
      const info = await api.resolveSymbol(symbol, this.abort.signal);
      if (this.disposed) return;
      this.symbolId = info.id;
      this.schedule = info.schedule ? new MarketSchedule(info.schedule) : null;
      // Extended hours are for intraday charts of markets that have them, as on TradingView.
      this.hours =
        this.schedule && isIntraday(resolution) && resolution.unit !== 'tick'
          ? this.settings.session
          : 'regular';
      legend.setInstrument(info, resolution);
      this.options.onInfo?.(info);
      this.followMarketStatus();
      // The best bid and ask don't wait for history: the exchange's stream opens meanwhile.
      if (info.hasBook) this.subscribeBook(info.id);

      const { bars, hasMore, fromListing } = await api.getBars(
        info.id,
        this.options.resolution,
        null,
        INITIAL_BARS,
        this.abort.signal,
        this.hours,
      );
      if (this.disposed) return;
      // Swap the chart over in one go: the previous interval stays up until this one is ready.
      chart.setInstrument({
        pricePrecision: info.pricePrecision,
        tickSize: info.tickSize,
        ...(info.format ? { format: info.format } : {}),
        resolution,
        timezone:
          this.settings.timezone === 'exchange' ? info.timezone : intlZone(this.settings.timezone),
        clock: this.schedule ? sessionClock(this.schedule, this.hours) : UTC_CLOCK,
        delayMs: info.delayMs,
        base: volumeUnit(info),
        hasVolume: hasRealVolume(info),
      });
      chart.setSessionShading(this.shading());
      chart.setExtendedPrice(null);
      chart.setBars(bars, fromListing);
      chart.showLatest();
      this.hasMore = hasMore;
      this.loaded = true;
      this.showLatest();
      // Subscribe only once history is in place; the feed starts with the current bar.
      this.subscribeBars(info.id);
      if (this.schedule && this.hours === 'regular') this.subscribeExtendedPrice(info.id);
    } catch (error) {
      if (this.disposed) return;
      legend.setStatus('error', messageOf(error));
      if (error instanceof ApiError) this.options.onError?.(error.code);
    }
  }

  /** Loads the page of history before the oldest bar on the chart, unless one is in flight. */
  async loadOlder(): Promise<void> {
    const { chart, api } = this.options;
    const first = chart.firstBarTime();
    if (this.disposed || !this.loaded || this.loadingOlder || !this.hasMore || first === null) {
      return;
    }
    const { symbolId } = this;
    if (!symbolId) return;
    if (Date.now() < this.retryAt) return;
    this.loadingOlder = true;
    try {
      const { bars, hasMore, fromListing } = await api.getBars(
        symbolId,
        this.options.resolution,
        first,
        PAGE_BARS,
        this.abort.signal,
        this.hours,
      );
      if (this.disposed) return;
      chart.prependBars(bars, fromListing);
      this.hasMore = hasMore;
    } catch {
      // Keep hasMore; the next scroll after the pause tries again.
      this.retryAt = Date.now() + HISTORY_RETRY_MS;
    } finally {
      this.loadingOlder = false;
    }
  }

  /** The legend follows the cursor; with nothing hovered it shows the live bar. */
  hover(info: HoverInfo | null): void {
    if (info) {
      this.hoveredTime = info.bar.time;
      this.options.legend.showBar(info.bar, info.previous, info.index);
    } else {
      this.hoveredTime = null;
      this.showLatest();
    }
  }

  /** New pre/post market background colors, without reloading the chart. */
  setBackgrounds(pre: Fill, post: Fill): void {
    this.options.settings = {
      ...this.settings,
      preMarketBackground: pre,
      postMarketBackground: post,
    };
    if (this.loaded && !this.disposed) this.options.chart.setSessionShading(this.shading());
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.statusTimer);
    this.abort.abort();
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** The legend's market status, kept current: it changes at each session boundary. */
  private followMarketStatus(): void {
    clearTimeout(this.statusTimer);
    if (this.disposed) return;
    const now = Date.now();
    const { status, until } = marketStatus(this.schedule, now);
    this.options.legend.setMarketStatus(status);
    if (until !== null) {
      this.statusTimer = setTimeout(() => this.followMarketStatus(), until - now + 50);
    }
  }

  /** TradingView's pre/post market hours background, for a chart showing extended hours. */
  private shading(): SessionShading | null {
    const { schedule } = this;
    if (!schedule || this.hours !== 'extended') return null;
    return {
      partOf: (time) => partOf(schedule, time),
      pre: fillColor(this.settings.preMarketBackground),
      post: fillColor(this.settings.postMarketBackground),
    };
  }

  /**
   * TradingView's pre/post-market price line, for a chart showing regular hours: the latest
   * minute of the extended session, when it's a pre- or post-market one. During regular hours
   * there's none.
   */
  private subscribeExtendedPrice(symbolId: string): void {
    const { feed, chart } = this.options;
    const { schedule } = this;
    if (!schedule) return;
    this.unsubscribes.push(
      feed.subscribeBars(
        symbolId,
        '1',
        {
          onBar: (bar, historical) => {
            if (historical) return;
            chart.setExtendedPrice(extendedPrice(schedule, bar));
          },
          onState: () => {},
          onError: () => {},
        },
        'extended',
      ),
    );
  }

  private subscribeBars(symbolId: string): void {
    const { feed, chart, legend } = this.options;
    this.unsubscribes.push(
      feed.subscribeBars(
        symbolId,
        this.options.resolution,
        {
          onBar: (bar, historical) => {
            chart.updateBar(bar, historical);
            const latest = chart.latest();
            if (this.hoveredTime === null || this.hoveredTime === latest?.bar.time)
              this.showLatest();
          },
          onState: (state) => {
            if (state === 'reconnecting') {
              this.wasReconnecting = true;
              legend.setStatus('reconnecting');
              return;
            }
            legend.setStatus('live');
            if (this.wasReconnecting) {
              this.wasReconnecting = false;
              void this.refill(symbolId);
            }
          },
          onError: (code, message) => {
            legend.setStatus('error', message);
            this.options.onError?.(code);
          },
        },
        this.hours,
      ),
    );
  }

  private subscribeBook(symbolId: string): void {
    const { feed, legend } = this.options;
    this.unsubscribes.push(
      feed.subscribeBook(symbolId, {
        onBook: (bid, ask) => legend.setBook(bid, ask),
        onState: () => {},
        onError: () => {},
      }),
    );
  }

  /** After an outage, reload recent bars so candles missed while offline appear. */
  private async refill(symbolId: string): Promise<void> {
    const { chart, api } = this.options;
    try {
      const { bars } = await api.getBars(
        symbolId,
        this.options.resolution,
        null,
        RESYNC_BARS,
        this.abort.signal,
        this.hours,
      );
      if (this.disposed) return;
      chart.mergeRecent(bars);
      if (this.hoveredTime === null) this.showLatest();
    } catch {
      // Best effort: the live feed carries on, and a later reconnect tries again.
    }
  }

  private showLatest(): void {
    const latest = this.options.chart.latest();
    if (latest) this.options.legend.showBar(latest.bar, latest.previous, latest.index);
  }
}

/** Whether the bar opening at `time` (UTC s) is pre- or post-market. */
function partOf(schedule: MarketSchedule, time: number): 'pre' | 'post' | null {
  const { status } = marketStatus(schedule, time * 1000);
  return status === 'pre' || status === 'post' ? status : null;
}

/** The line for the latest extended-hours minute, or none when it's in regular hours. */
function extendedPrice(schedule: MarketSchedule, bar: Bar): ExtendedPrice | null {
  const part = partOf(schedule, bar.time);
  if (!part) return null;
  return {
    price: bar.close,
    tag: part === 'pre' ? 'Pre' : 'Post',
    color: EXTENDED_PRICE_COLORS[part],
  };
}

/** A fill as a CSS color with its opacity. */
function fillColor({ color, opacity }: Fill): string {
  const value = Number.parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${opacity})`;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong';
}
