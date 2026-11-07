import { instrumentSymbol } from '@tradingnerd/chart';
import {
  type Bar,
  type BarClock,
  parseResolution,
  type Resolution,
  resolutionDurationMs,
  type SessionHours,
  type SymbolInfo,
} from '@tradingnerd/core';
import {
  type ContextData,
  type CurrencyLeg,
  type RequestFeed,
  type RequestKey,
  requestKeyText,
} from '@tradingnerd/pine';
import { ApiError, type MarketApi } from '../data/api';
import type { LiveFeed } from '../data/GatewayConnection';
import { instrumentOf } from './ChartSession';

/**
 * The data scripts' requests ask for (docs/SPEC.md §6.18): each symbol and timeframe a script
 * requests, from the gateway as the chart's own (its history in pages, then its live bars).
 * Scripts wait, drawing nothing, until a context is in; the chart runs them again then.
 */

/** Bars per page: the gateway's most (MAX_COUNT_BACK). */
export const REQUEST_PAGE_BARS = 5_000;
/**
 * Bars of a timeframe at least the chart's loaded before the chart's first bar, so a value there
 * is settled (the engine checks it: values not settled aren't drawn).
 */
export const WARMUP_BARS = 300;
/** At most this many of a context's bars: TradingView's intrabars (Pine docs, Limitations). */
export const MAX_REQUEST_BARS = 100_000;
/** After a failed load, it's tried again on the chart's next update after this long. */
export const REQUEST_RETRY_MS = 5_000;

export interface RequestLoaderOptions {
  api: MarketApi;
  feed: LiveFeed;
  /** The chart's background, as scripts' chart.bg_color reads it. */
  background: string;
  /** A context's history changed (it loaded, or a page went on): the scripts run afresh. */
  onHistory: () => void;
  /** A context's live bar moved: the scripts' live bar runs again. */
  onLive: () => void;
  /** A ticker without its exchange ("AAPL"): the symbol TradingView would pick, or null. */
  find?: (ticker: string, signal: AbortSignal) => Promise<string | null>;
}

interface Entry {
  key: RequestKey;
  state: 'loading' | 'ready' | 'invalid' | 'failed';
  data: ContextData | null;
  info: SymbolInfo | null;
  hours: SessionHours;
  hasMore: boolean;
  loadingOlder: boolean;
  retryAt: number;
  stop: (() => void) | null;
  abort: AbortController;
}

/** The chart, as a context's depth depends on it: its first bar (UTC seconds) and timeframe. */
export interface ChartReach {
  firstBarTime: number | null;
  timeframe: string;
}

export class RequestLoader implements RequestFeed {
  private readonly options: RequestLoaderOptions;
  private readonly entries = new Map<string, Entry>();
  private reach: ChartReach = { firstBarTime: null, timeframe: '1D' };
  private disposed = false;

  constructor(options: RequestLoaderOptions) {
    this.options = options;
  }

  data(key: RequestKey): ContextData | 'invalid' | null {
    const entry = this.entries.get(requestKeyText(key));
    if (!entry) return null;
    if (entry.state === 'invalid') return 'invalid';
    return entry.state === 'ready' ? entry.data : null;
  }

  rates(from: string, to: string): readonly CurrencyLeg[] | null {
    return currencyPath(from, to);
  }

  /**
   * The contexts the chart's scripts ask for: those not loaded start loading, those loaded go back
   * far enough for the chart, and those no longer asked for are let go.
   */
  want(missing: readonly RequestKey[], used: readonly RequestKey[], reach: ChartReach): void {
    if (this.disposed) return;
    this.reach = reach;
    const wanted = new Map<string, RequestKey>();
    for (const key of [...used, ...missing]) wanted.set(requestKeyText(key), key);
    for (const [text, entry] of this.entries) {
      if (!wanted.has(text)) this.drop(text, entry);
    }
    for (const [text, key] of wanted) {
      const entry = this.entries.get(text);
      if (!entry) {
        void this.load(this.add(text, key));
        continue;
      }
      if (entry.state === 'failed' && Date.now() >= entry.retryAt) void this.load(entry);
      else if (entry.state === 'ready') void this.loadOlder(entry);
    }
  }

  /** Whether a context is still loading (its scripts wait). */
  loading(): boolean {
    for (const entry of this.entries.values()) if (entry.state === 'loading') return true;
    return false;
  }

  dispose(): void {
    this.disposed = true;
    for (const [text, entry] of this.entries) this.drop(text, entry);
  }

  private add(text: string, key: RequestKey): Entry {
    const entry: Entry = {
      key,
      state: 'loading',
      data: null,
      info: null,
      hours: 'regular',
      hasMore: true,
      loadingOlder: false,
      retryAt: 0,
      stop: null,
      abort: new AbortController(),
    };
    this.entries.set(text, entry);
    return entry;
  }

  private drop(text: string, entry: Entry): void {
    entry.abort.abort();
    entry.stop?.();
    this.entries.delete(text);
  }

  private async load(entry: Entry): Promise<void> {
    const { api } = this.options;
    const { key } = entry;
    const { signal } = entry.abort;
    entry.state = 'loading';
    try {
      const resolution = parseResolution(key.timeframe);
      const id = key.symbol.includes(':')
        ? key.symbol
        : ((await this.options.find?.(key.symbol, signal)) ?? null);
      if (!resolution || !id) {
        this.invalid(entry);
        return;
      }
      const info = await api.resolveSymbol(id, signal);
      // Extended hours are a market's that closes, on intraday bars (as the chart's own).
      const hours: SessionHours =
        key.session === 'extended' && info.schedule && isIntraday(resolution)
          ? 'extended'
          : 'regular';
      let page = await api.getBars(info.id, key.timeframe, null, REQUEST_PAGE_BARS, signal, hours);
      let bars = page.bars;
      while (page.hasMore && this.short(bars, key.timeframe)) {
        const first = bars[0]?.time;
        if (first === undefined) break;
        page = await api.getBars(info.id, key.timeframe, first, REQUEST_PAGE_BARS, signal, hours);
        if (page.bars.length === 0) break;
        bars = [...page.bars.filter((bar) => bar.time < first), ...bars];
      }
      if (this.disposed || signal.aborted) return;
      entry.info = info;
      entry.hours = hours;
      entry.hasMore = page.hasMore;
      entry.data = this.context(info, resolution, hours, bars.slice(-MAX_REQUEST_BARS), {
        fromListing: page.fromListing,
        version: 1,
        history: 1,
      });
      entry.state = 'ready';
      this.follow(entry, info);
      this.options.onHistory();
    } catch (error) {
      if (signal.aborted || this.disposed) return;
      const code = error instanceof ApiError ? error.code : null;
      if (
        code === 'unknown_symbol' ||
        code === 'unsupported_resolution' ||
        code === 'bad_request'
      ) {
        this.invalid(entry);
        return;
      }
      // The gateway or the exchange failed: tried again on a later update.
      entry.state = 'failed';
      entry.retryAt = Date.now() + REQUEST_RETRY_MS;
    }
  }

  private invalid(entry: Entry): void {
    entry.state = 'invalid';
    this.options.onHistory();
  }

  /** Older bars for a context that doesn't reach back far enough for the chart now. */
  private async loadOlder(entry: Entry): Promise<void> {
    const data = entry.data;
    const info = entry.info;
    if (!data || !info || entry.loadingOlder || !entry.hasMore) return;
    if (!this.short(data.bars, entry.key.timeframe)) return;
    const first = data.bars[0]?.time;
    if (first === undefined) return;
    entry.loadingOlder = true;
    const { signal } = entry.abort;
    try {
      const page = await this.options.api.getBars(
        info.id,
        entry.key.timeframe,
        first,
        REQUEST_PAGE_BARS,
        signal,
        entry.hours,
      );
      if (this.disposed || signal.aborted || entry.data !== data) return;
      const older = page.bars.filter((bar) => bar.time < first);
      entry.hasMore = page.hasMore && older.length > 0;
      const bars = [...older, ...data.bars].slice(-MAX_REQUEST_BARS);
      entry.data = {
        ...data,
        bars,
        fromListing: page.fromListing,
        version: data.version + 1,
        history: data.history + 1,
      };
      this.options.onHistory();
    } catch {
      // Tried again on a later update.
    } finally {
      entry.loadingOlder = false;
    }
  }

  /**
   * Whether a context's bars don't reach back far enough: to the chart's first bar for a lower
   * timeframe's intrabars, WARMUP_BARS before it otherwise; never past MAX_REQUEST_BARS.
   */
  private short(bars: readonly Bar[], timeframe: string): boolean {
    const chartFirst = this.reach.firstBarTime;
    const first = bars[0]?.time;
    if (chartFirst === null || first === undefined || bars.length >= MAX_REQUEST_BARS) return false;
    const own = parseResolution(timeframe);
    const chart = parseResolution(this.reach.timeframe);
    if (!own || !chart) return false;
    const lower = spanMs(own) < spanMs(chart);
    const reach = lower ? chartFirst : chartFirst - (WARMUP_BARS * spanMs(own)) / 1000;
    return first > reach;
  }

  /** The context's live bars, from the gateway's stream as the chart's own. */
  private follow(entry: Entry, info: SymbolInfo): void {
    entry.stop?.();
    entry.stop = this.options.feed.subscribeBars(
      info.id,
      entry.key.timeframe,
      {
        onBar: (bar, historical) => this.onBar(entry, bar, historical),
        onState: () => {},
        onError: () => {},
      },
      entry.hours,
    );
  }

  private onBar(entry: Entry, bar: Bar, historical: boolean): void {
    const data = entry.data;
    if (!data || this.disposed) return;
    // The bars are the context's own: changed in place, a new version each time (the engine
    // runs the live bar again, or the new ones); a correction of an older bar is new history.
    const bars = data.bars as Bar[];
    const last = bars.at(-1);
    let history = data.history;
    if (!last || bar.time > last.time) bars.push(bar);
    else if (bar.time === last.time) bars[bars.length - 1] = bar;
    else {
      const i = historical ? bars.findIndex((b) => b.time === bar.time) : -1;
      if (i < 0) return;
      bars[i] = bar;
      history += 1;
    }
    const resolution = parseResolution(entry.key.timeframe);
    const live = resolution ? forming(data.symbol.clock, resolution, bars.at(-1)) : data.live;
    entry.data = { ...data, live, version: data.version + 1, history };
    if (history !== data.history) this.options.onHistory();
    else this.options.onLive();
  }

  private context(
    info: SymbolInfo,
    resolution: Resolution,
    hours: SessionHours,
    bars: Bar[],
    state: Pick<ContextData, 'fromListing' | 'version' | 'history'>,
  ): ContextData {
    const instrument = instrumentOf(info, resolution, hours, info.timezone);
    const symbol = instrumentSymbol(instrument, this.options.background);
    return { symbol, bars, live: forming(symbol.clock, resolution, bars.at(-1)), ...state };
  }
}

/** Whether a bar is still forming: until its close, by the symbol's clock. */
function forming(clock: BarClock, resolution: Resolution, bar: Bar | undefined): boolean {
  return bar !== undefined && clock.close(resolution, bar.start ?? bar.time * 1000) > Date.now();
}

const isIntraday = (resolution: Resolution): boolean =>
  resolution.unit === 'second' || resolution.unit === 'minute' || resolution.unit === 'tick';

/** How long a timeframe's bars are, ms (a month as 30 days). */
function spanMs(resolution: Resolution): number {
  if (resolution.unit === 'month') return resolution.count * 30 * 86_400_000;
  return resolutionDurationMs(resolution) ?? 0;
}

/**
 * How a currency converts into the US dollar: a pair we have, read as its price or its inverse
 * (provisional, docs/SPEC.md §11: TradingView takes "the most popular exchange"'s pair; ours are
 * Kraken's, its fiat and stablecoin pairs against the dollar, until rates are compared).
 */
const IN_USD: Readonly<Record<string, CurrencyLeg>> = {
  USDT: { symbol: 'KRAKEN:USDTUSD', invert: false },
  USDC: { symbol: 'KRAKEN:USDCUSD', invert: false },
  DAI: { symbol: 'KRAKEN:DAIUSD', invert: false },
  EUR: { symbol: 'KRAKEN:EURUSD', invert: false },
  GBP: { symbol: 'KRAKEN:GBPUSD', invert: false },
  AUD: { symbol: 'KRAKEN:AUDUSD', invert: false },
  JPY: { symbol: 'KRAKEN:USDJPY', invert: true },
  CAD: { symbol: 'KRAKEN:USDCAD', invert: true },
  CHF: { symbol: 'KRAKEN:USDCHF', invert: true },
  BTC: { symbol: 'KRAKEN:XBTUSD', invert: false },
  ETH: { symbol: 'KRAKEN:ETHUSD', invert: false },
};

/** The pairs converting `from` into `to`: through the dollar when neither is it; null for none. */
export function currencyPath(from: string, to: string): CurrencyLeg[] | null {
  if (from === to) return [];
  const out: CurrencyLeg[] = [];
  if (from !== 'USD') {
    const leg = IN_USD[from];
    if (!leg) return null;
    out.push(leg);
  }
  if (to !== 'USD') {
    const leg = IN_USD[to];
    if (!leg) return null;
    out.push({ symbol: leg.symbol, invert: !leg.invert });
  }
  return out;
}
