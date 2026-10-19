import type { ChartController, HoverInfo } from '@tradingnerd/chart';
import { type Bar, parseResolution, type Resolution, type SymbolInfo } from '@tradingnerd/core';
import { ApiError, type MarketApi } from '../data/api';
import type { LiveFeed } from '../data/GatewayConnection';

export type LegendStatus = 'loading' | 'live' | 'reconnecting' | 'error';

/** What the session tells the legend overlay. */
export interface LegendView {
  setInstrument(info: SymbolInfo, resolution: Resolution): void;
  showBar(bar: Bar, previous: Bar | null): void;
  setBook(bid: number, ask: number): void;
  setStatus(status: LegendStatus, message?: string): void;
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
>;

export interface ChartSessionOptions {
  chart: ChartSurface;
  api: MarketApi;
  feed: LiveFeed;
  legend: LegendView;
  symbol: string;
  /** TradingView notation, e.g. "1D" or "60". */
  resolution: string;
}

/** Bars fetched when the chart opens, per scroll-back page, and to refill after a reconnect. */
export const INITIAL_BARS = 1_000;
export const PAGE_BARS = 1_000;
export const RESYNC_BARS = 1_000;
/** After a failed page load, wait this long before trying again. */
export const HISTORY_RETRY_MS = 2_000;

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

  constructor(options: ChartSessionOptions) {
    this.options = options;
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
      legend.setInstrument(info, resolution);
      // The best bid and ask don't wait for history: the exchange's stream opens meanwhile.
      this.subscribeBook(info.id);

      const { bars, hasMore } = await api.getBars(
        info.id,
        this.options.resolution,
        null,
        INITIAL_BARS,
        this.abort.signal,
      );
      if (this.disposed) return;
      // Swap the chart over in one go: the previous interval stays up until this one is ready.
      chart.setInstrument({
        pricePrecision: info.pricePrecision,
        tickSize: info.tickSize,
        resolution,
      });
      chart.setBars(bars);
      chart.showLatest();
      this.hasMore = hasMore;
      this.loaded = true;
      this.showLatest();
      // Subscribe only once history is in place; the feed starts with the current bar.
      this.subscribeBars(info.id);
    } catch (error) {
      if (!this.disposed) legend.setStatus('error', messageOf(error));
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
      const { bars, hasMore } = await api.getBars(
        symbolId,
        this.options.resolution,
        first,
        PAGE_BARS,
        this.abort.signal,
      );
      if (this.disposed) return;
      chart.prependBars(bars);
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
      this.options.legend.showBar(info.bar, info.previous);
    } else {
      this.hoveredTime = null;
      this.showLatest();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private subscribeBars(symbolId: string): void {
    const { feed, chart, legend } = this.options;
    this.unsubscribes.push(
      feed.subscribeBars(symbolId, this.options.resolution, {
        onBar: (bar, historical) => {
          chart.updateBar(bar, historical);
          const latest = chart.latest();
          if (this.hoveredTime === null || this.hoveredTime === latest?.bar.time) this.showLatest();
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
        onError: (_code, message) => legend.setStatus('error', message),
      }),
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
    if (latest) this.options.legend.showBar(latest.bar, latest.previous);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong';
}
