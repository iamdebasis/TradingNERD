import {
  type Bar,
  type BarClock,
  CRYPTOCAP,
  evaluateFormula,
  type Formula,
  formatResolution,
  parseResolution,
  parseSymbolId,
  type Resolution,
  replaceSymbols,
  resampleBars,
  resolutionDurationMs,
  type SessionHours,
  type SymbolInfo,
  UTC_CLOCK,
  UTC_ZONE,
} from '@tradingnerd/core';
import type { MarketService } from '../market/MarketService.ts';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type Trade,
  toMarketError,
  type Unsubscribe,
} from '../market/types.ts';

/**
 * The intervals a formula is served in: every one of the chart's menu. Up to a day they're built
 * from its symbols' own bars; longer ones from the formula's own days (`nativeResolutions`).
 * Seconds and ticks aren't (TradingView's spreads start at minutes).
 */
export const FORMULA_RESOLUTIONS = [
  '1',
  '2',
  '3',
  '5',
  '10',
  '15',
  '30',
  '45',
  '60',
  '120',
  '180',
  '240',
  '360',
  '480',
  '720',
  '1D',
  '2D',
  '3D',
  '1W',
  '1M',
  '3M',
  '6M',
  '12M',
] as const;
const ONE_MINUTE = parseResolution('1') as Resolution;
/** The most bars the market service hands over in one go (MAX_COUNT_BACK). */
const MAX_SYMBOL_BARS = 5_000;

export interface FormulaExchangeOptions {
  market: MarketService;
  formula: Formula;
  /**
   * The exchange whose market clock all the formula's symbols share (US stocks' sessions), or
   * none: then its bars follow UTC, as crypto's do.
   */
  clockSource?: ExchangeAdapter | undefined;
  now?: () => number;
}

/** A symbol's bar standing still at its last price: for a period it has no bar of its own. */
const still = (time: number, price: number): Bar => ({
  time,
  open: price,
  high: price,
  low: price,
  close: price,
  volume: 0,
});

/**
 * Where bars of the same period meet, whatever each symbol's clock: day bars by their UTC date
 * (a stock's day opens at 13:30 UTC, a coin's at midnight), shorter ones by time.
 */
function periodKey(time: number, resolution: Resolution): number {
  return resolution.unit === 'day' ? Math.floor(time / 86_400 / resolution.count) : time;
}

/** Longer than a day: built by the market service from the formula's own days. */
const fromDays = (resolution: Resolution) =>
  resolution.unit === 'week' ||
  resolution.unit === 'month' ||
  (resolution.unit === 'day' && resolution.count > 1);

/**
 * The bars intraday formulas of up to 5 minutes are built from: 1-minute ones, as TradingView
 * builds every intraday spread; longer intervals use their own (60× the bars otherwise).
 */
function baseOf(resolution: Resolution): Resolution {
  return resolution.unit === 'minute' && resolution.count <= 5 ? ONE_MINUTE : resolution;
}

const sameResolution = (a: Resolution, b: Resolution) => a.unit === b.unit && a.count === b.count;

/**
 * A formula of other symbols, TradingView's spread (docs/SPEC.md §6.15): each period's bar is
 * the formula applied to its symbols' opens, highs, lows and closes, the high and low then the
 * largest and smallest of the four. A symbol without a bar in a period keeps its last price;
 * there are no bars before every symbol has one. Everything comes through the market service,
 * so any symbol works in a formula: an exchange's pair, CRYPTOCAP's, a US stock. One instance a
 * formula, so its feed state is its own symbols'.
 */
export class FormulaExchange implements ExchangeAdapter {
  readonly id = 'FORMULA';
  readonly name = 'Formula';
  readonly maxBarsPerRequest = 1_000;
  /**
   * Up to a day. The market service builds longer bars from the formula's own days, as
   * TradingView builds a spread's: a symbol's dip on one day shows in its week, where each
   * symbol's weekly bar would hide it (docs/SPEC.md §6.15).
   */
  readonly nativeResolutions: readonly Resolution[] = FORMULA_RESOLUTIONS.map(
    (text) => parseResolution(text) as Resolution,
  ).filter((resolution) => !fromDays(resolution));
  readonly gapless: boolean;

  private readonly market: MarketService;
  private readonly formula: Formula;
  /** Each symbol's place in the formula's list. */
  private readonly index: ReadonlyMap<string, number>;
  private readonly clockSource: ExchangeAdapter | undefined;
  private readonly now: () => number;
  /** Each held subscription's symbols' states: up while every one is live. */
  private readonly states = new Map<object, ('live' | 'reconnecting')[]>();
  private readonly stateListeners = new Set<(state: FeedState) => void>();
  private lastState: FeedState | null = null;

  constructor(options: FormulaExchangeOptions) {
    this.market = options.market;
    this.formula = options.formula;
    this.index = new Map(options.formula.symbols.map((symbol, i) => [symbol, i] as const));
    this.clockSource = options.clockSource;
    this.now = options.now ?? Date.now;
    // Around-the-clock bars can be fetched as time slices; a session market's page back.
    this.gapless = (this.clockSource?.clock ?? UTC_CLOCK).continuous;
  }

  get clock(): BarClock | undefined {
    return this.clockSource?.clock;
  }

  get delayMs(): number {
    return this.clockSource?.delayMs ?? 0;
  }

  clockFor(hours: SessionHours): BarClock {
    return this.clockSource?.clockFor?.(hours) ?? this.clockSource?.clock ?? UTC_CLOCK;
  }

  async resolveSymbol(): Promise<SymbolInfo> {
    const results = await Promise.allSettled(
      this.formula.symbols.map((symbol) => this.market.resolveSymbol(symbol)),
    );
    const failed = results.flatMap((result, i) =>
      result.status === 'rejected'
        ? [{ symbol: this.formula.symbols[i] as string, error: toMarketError(result.reason) }]
        : [],
    );
    if (failed.length > 0) throw await this.failure(failed);
    const infos = results.map((result) => (result as PromiseFulfilledResult<SymbolInfo>).value);
    const first = infos[0] as SymbolInfo;
    const sessions = this.clockSource?.clock !== undefined;
    const info: SymbolInfo = {
      id: this.formula.text,
      exchange: first.exchange,
      exchangeName: first.exchangeName,
      ticker: this.formula.name,
      base: '',
      quote: first.quote,
      description: this.formula.name,
      type: 'spread',
      tickSize: first.tickSize,
      pricePrecision: first.pricePrecision,
      resolutions: [...FORMULA_RESOLUTIONS],
      timezone: sessions ? first.timezone : UTC_ZONE,
      delayMs: Math.max(...infos.map((item) => item.delayMs)),
      hasBook: true,
    };
    if (first.format) info.format = first.format;
    if (sessions && first.schedule) info.schedule = first.schedule;
    return info;
  }

  /**
   * Why the formula can't be shown: a lookup that merely failed is passed on (it's tried again),
   * a symbol we don't have is named. When it's a coin's next to market caps (EURONEXT:USDC in
   * CRYPTOCAP:TOTAL3-CRYPTOCAP:USDT-EURONEXT:USDC), CRYPTOCAP's is suggested in its place.
   */
  private async failure(failed: { symbol: string; error: MarketError }[]): Promise<MarketError> {
    const passing = failed.find(({ error }) => error.code !== 'unknown_symbol');
    if (passing) return passing.error;
    const [{ symbol }] = failed as [{ symbol: string; error: MarketError }];
    const ticker = parseSymbolId(symbol)?.ticker ?? symbol;
    const usesCaps = this.formula.symbols.some(
      (other) => other !== symbol && other.startsWith(`${CRYPTOCAP}:`),
    );
    let suggestion: string | undefined;
    if (usesCaps && !symbol.startsWith(`${CRYPTOCAP}:`)) {
      const instead = `${CRYPTOCAP}:${ticker}`;
      const exists = await this.market.resolveSymbol(instead).then(
        () => true,
        () => false,
      );
      if (exists) {
        suggestion = replaceSymbols(this.formula, (part) =>
          part === symbol ? instead : part,
        ).text;
      }
    }
    const message = suggestion
      ? `${symbol} isn't available here; for ${ticker}'s market cap, use ${CRYPTOCAP}:${ticker}`
      : `${symbol} isn't available here`;
    return new MarketError('unknown_symbol', message, suggestion);
  }

  async fetchBars(
    _ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
    hours?: SessionHours,
  ): Promise<Bar[]> {
    const base = baseOf(resolution);
    const perBar = this.perBar(base, resolution);
    const count = Math.min(MAX_SYMBOL_BARS, (limit + 1) * perBar);
    const toSec = endTimeMs === null ? null : Math.ceil(endTimeMs / 1000);
    const bars = await this.bars(resolution, base, toSec, count, hours);
    const before = endTimeMs === null ? bars : bars.filter((bar) => bar.time * 1000 < endTimeMs);
    return before.slice(-limit);
  }

  async fetchRange(
    _ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
    hours?: SessionHours,
  ): Promise<Bar[]> {
    const base = baseOf(resolution);
    const step = resolutionDurationMs(base) ?? 86_400_000;
    // One more than the range holds, so each symbol has its price from before the range.
    const count = Math.min(MAX_SYMBOL_BARS, Math.ceil((endMs - startMs) / step) + 1);
    const bars = await this.bars(resolution, base, Math.ceil(endMs / 1000), count, hours);
    return bars
      .filter((bar) => bar.time * 1000 >= startMs && bar.time * 1000 < endMs)
      .slice(0, this.maxBarsPerRequest);
  }

  /** The formula's bars from its symbols' bars at `base`, folded into `resolution` if need be. */
  private async bars(
    resolution: Resolution,
    base: Resolution,
    toSec: number | null,
    count: number,
    hours: SessionHours | undefined,
  ): Promise<Bar[]> {
    const interval = formatResolution(base);
    const histories = await Promise.all(
      this.formula.symbols.map((symbol) =>
        this.market.getBars(symbol, interval, toSec, Math.max(1, count), hours ?? 'regular'),
      ),
    );
    const bars = this.combine(
      histories.map((history) => history.bars),
      base,
    );
    if (sameResolution(base, resolution)) return bars;
    const clock = this.clockFor(hours ?? 'regular');
    const folded = resampleBars(bars, resolution, clock);
    // The oldest period may have begun before the minutes fetched: it'd be half a bar.
    const first = bars[0];
    const oldest = folded[0];
    if (first && oldest && first.time > oldest.time) return folded.slice(1);
    return folded;
  }

  /** Each period's bar from the symbols' bars of that period, or their last prices. */
  private combine(series: readonly (readonly Bar[])[], resolution: Resolution): Bar[] {
    const byPeriod = series.map(
      (bars) => new Map(bars.map((bar) => [periodKey(bar.time, resolution), bar] as const)),
    );
    const periods = [...new Set(byPeriod.flatMap((bars) => [...bars.keys()]))].sort(
      (a, b) => a - b,
    );
    const latest: (Bar | null)[] = series.map(() => null);
    const out: Bar[] = [];
    for (const period of periods) {
      const own = byPeriod.map((bars) => bars.get(period));
      for (const [i, bar] of own.entries()) if (bar) latest[i] = bar;
      if (latest.some((bar) => bar === null)) continue; // not every symbol has begun
      const times = own.flatMap((bar) => (bar ? [bar.time] : []));
      const time = Math.min(...times);
      const parts = latest.map((bar, i) => own[i] ?? still(time, (bar as Bar).close));
      const bar = this.barOf(time, parts);
      if (bar) out.push(bar);
    }
    return out;
  }

  /** The formula over one period's parts; null where it has no value (a division by zero). */
  private barOf(time: number, parts: readonly Bar[]): Bar | null {
    const value = (pick: (bar: Bar) => number) =>
      evaluateFormula(this.formula.root, (symbol) => {
        const part = parts[this.index.get(symbol) ?? -1];
        return part ? pick(part) : Number.NaN;
      });
    const open = value((bar) => bar.open);
    const high = value((bar) => bar.high);
    const low = value((bar) => bar.low);
    const close = value((bar) => bar.close);
    if (![open, high, low, close].every(Number.isFinite)) return null;
    return {
      time,
      open,
      high: Math.max(open, high, low, close),
      low: Math.min(open, high, low, close),
      close,
      // Not shown yet; never 0, so a folded interval keeps every bar (resampleBars).
      volume: Math.max(1, parts[0]?.volume ?? 0),
    };
  }

  private perBar(base: Resolution, resolution: Resolution): number {
    if (sameResolution(base, resolution)) return 1;
    const baseMs = resolutionDurationMs(base) ?? 1;
    return Math.max(1, Math.ceil((resolutionDurationMs(resolution) ?? baseMs) / baseMs));
  }

  /**
   * The formula's live bar: each symbol's live bar of the interval, the formula worked out at
   * each move; the open from their opens, the high and low the extremes it reaches.
   */
  subscribeCandles(
    _ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
    hours?: SessionHours,
  ): Unsubscribe {
    const latest: (Bar | null)[] = this.formula.symbols.map(() => null);
    let current: { period: number; bar: Bar } | null = null;
    const move = () => {
      if (latest.some((bar) => bar === null)) return;
      const bars = latest as Bar[];
      const period = Math.max(...bars.map((bar) => periodKey(bar.time, resolution)));
      const own = bars.map((bar) => (periodKey(bar.time, resolution) === period ? bar : null));
      const time = Math.min(...own.flatMap((bar) => (bar ? [bar.time] : [])));
      const parts = bars.map((bar, i) => own[i] ?? still(time, bar.close));
      const bar = this.barOf(time, parts);
      if (!bar) return;
      if (!current || current.period !== period) {
        current = { period, bar };
      } else {
        current.bar = {
          ...current.bar,
          high: Math.max(current.bar.high, bar.high, bar.close),
          low: Math.min(current.bar.low, bar.low, bar.close),
          close: bar.close,
          volume: bar.volume,
        };
      }
      onUpdate({ bar: { ...current.bar }, eventTime: this.now() });
    };
    return this.follow(formatResolution(resolution), hours, (i, bar) => {
      latest[i] = bar;
      move();
    });
  }

  /** A formula has no trades of its own: its bars move with its symbols'. */
  subscribeTrades(_ticker: string, _onTrade: (trade: Trade) => void): Unsubscribe {
    return () => {};
  }

  /** The value as both Sell and Buy, as TradingView shows a spread's. */
  subscribeBook(_ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const closes: (number | null)[] = this.formula.symbols.map(() => null);
    return this.follow('1D', undefined, (i, bar) => {
      closes[i] = bar.close;
      if (closes.some((close) => close === null)) return;
      const value = evaluateFormula(
        this.formula.root,
        (symbol) => closes[this.index.get(symbol) ?? -1] ?? Number.NaN,
      );
      if (Number.isFinite(value)) onBook({ bid: value, ask: value });
    });
  }

  /** Each symbol's live bars of `interval`; the formula's feed is up while all of them are. */
  private follow(
    interval: string,
    hours: SessionHours | undefined,
    onBar: (index: number, bar: Bar) => void,
  ): Unsubscribe {
    const key = {};
    const states = this.formula.symbols.map(() => 'reconnecting' as const) as (
      | 'live'
      | 'reconnecting'
    )[];
    this.states.set(key, states);
    this.checkState();
    const stops = this.formula.symbols.map((symbol, i) =>
      this.market.subscribeBars(
        symbol,
        interval,
        {
          onBar: (bar, historical) => {
            if (!historical) onBar(i, bar);
          },
          onState: (state) => {
            states[i] = state;
            this.checkState();
          },
          onError: () => {
            states[i] = 'reconnecting';
            this.checkState();
          },
        },
        hours ?? 'regular',
      ),
    );
    return () => {
      for (const stop of stops) stop();
      this.states.delete(key);
      this.checkState();
    };
  }

  isFeedUp(): boolean {
    return [...this.states.values()].every((states) => states.every((state) => state === 'live'));
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private checkState(): void {
    const state: FeedState = this.isFeedUp() ? 'up' : 'down';
    if (state === this.lastState) return;
    this.lastState = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  async close(): Promise<void> {
    this.states.clear();
    this.stateListeners.clear();
  }
}
