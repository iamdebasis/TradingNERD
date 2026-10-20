import {
  type Bar,
  type BarClock,
  dayOf,
  formatResolution,
  parseResolution,
  type Resolution,
  type SymbolInfo,
} from '@tradingnerd/core';
import {
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type Unsubscribe,
} from '../market/types.ts';
import { ALPACA_PAGE_LIMIT, type AlpacaTimeframe } from './alpaca.ts';
import { US_TIMEZONE } from './MarketCalendar.ts';
import type { UsStocksMarket } from './UsStocksMarket.ts';

/** Intervals Alpaca serves that start with every session (each divides the 30-minute grid). */
const TIMEFRAMES: Readonly<Record<string, AlpacaTimeframe>> = {
  '1': '1Min',
  '5': '5Min',
  '15': '15Min',
  '30': '30Min',
  '1D': '1Day',
};
const NATIVE: readonly Resolution[] = Object.keys(TIMEFRAMES).map((text) => {
  const resolution = parseResolution(text);
  if (!resolution) throw new Error(text);
  return resolution;
});
/** Before Alpaca's history begins (2016): asking from here gets everything there is. */
const HISTORY_START = Date.UTC(2015, 0, 1);
const MINUTE = 60_000;
const DAY: Resolution = { count: 1, unit: 'day' };

/**
 * One US exchange's listings (NASDAQ, NYSE, AMEX, CBOE, …), with Alpaca's whole-market data:
 * bars in regular hours on the exchange's session clock, delayed as the key's plan is, and
 * live bars from the shared minute poller. Stocks have no order book here (the legend's Sell
 * and Buy) and no tick charts.
 */
export class UsStockExchange implements ExchangeAdapter {
  readonly id: string;
  readonly name: string;
  readonly maxBarsPerRequest = ALPACA_PAGE_LIMIT;
  readonly nativeResolutions = NATIVE;
  private readonly market: UsStocksMarket;

  constructor(market: UsStocksMarket, exchange: { id: string; name: string }) {
    this.market = market;
    this.id = exchange.id;
    this.name = exchange.name;
  }

  get clock(): BarClock {
    return this.market.clock;
  }

  get delayMs(): number {
    return this.market.delayMs();
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const listing = await this.listingOf(ticker);
    await this.market.requireData();
    const price = this.market.listings.price(listing.ticker);
    // US prices tick in cents, below a dollar in hundredths of a cent.
    const tickSize = price !== null && price < 1 ? 0.0001 : 0.01;
    return {
      id: `${this.id}:${listing.ticker}`,
      exchange: this.id,
      exchangeName: listing.venue,
      ticker: listing.ticker,
      base: listing.root,
      quote: 'USD',
      description: listing.name,
      type: listing.kind,
      tickSize,
      pricePrecision: tickSize < 0.01 ? 4 : 2,
      resolutions: Object.keys(TIMEFRAMES),
      timezone: US_TIMEZONE,
      delayMs: this.delayMs,
      hasBook: false,
      schedule: this.market.calendar.schedule().data,
    };
  }

  /**
   * Up to `limit` regular-hours bars opening before `endTimeMs`, newest last. Alpaca's bars
   * include pre- and post-market ones, which are left out, so pages continue until enough
   * remain or history begins. A day still trading is left to the live feed.
   */
  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const symbol = await this.dataSymbolOf(ticker);
    const timeframe = this.timeframeOf(resolution);
    const latest = this.latestMinute();
    let end = endTimeMs === null ? latest : Math.min(endTimeMs - 1, latest);
    const liveDay = this.liveDay(resolution);
    const newestFirst: Bar[] = [];
    while (newestFirst.length < limit) {
      const wanted = limit - newestFirst.length;
      const ask = Math.min(
        ALPACA_PAGE_LIMIT,
        timeframe === '1Day' ? wanted + 2 : Math.ceil(wanted * 2.6) + 10,
      );
      const page =
        (
          await this.market.client.bars([symbol], {
            timeframe,
            start: HISTORY_START,
            end,
            limit: ask,
            sort: 'desc',
          })
        ).get(symbol) ?? [];
      for (const bar of page) {
        const kept = this.inSession(bar, resolution);
        if (kept && kept.time * 1000 !== liveDay) newestFirst.push(kept);
      }
      const oldest = page.at(-1);
      if (page.length < ask || !oldest) break; // history begins here
      end = oldest.time * 1000 - 1;
    }
    return newestFirst.slice(0, limit).reverse();
  }

  /** Bars opening in [startMs, endMs), oldest first, at most a page of them. */
  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const symbol = await this.dataSymbolOf(ticker);
    const end = Math.min(endMs - 1, this.latestMinute());
    const page =
      (
        await this.market.client.bars([symbol], {
          timeframe: this.timeframeOf(resolution),
          start: startMs,
          end,
          limit: this.maxBarsPerRequest,
          sort: 'asc',
        })
      ).get(symbol) ?? [];
    const liveDay = this.liveDay(resolution);
    return page.flatMap((bar) => {
      const kept = this.inSession(bar, resolution);
      return kept && kept.time * 1000 !== liveDay ? [kept] : [];
    });
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    const listing = this.market.listings.get(this.id, ticker);
    if (!listing?.dataSymbol) return () => {};
    return this.market.poller.subscribe(listing.dataSymbol, resolution, onUpdate);
  }

  /** Stock prices come as minute bars; there's no trade stream to merge. */
  subscribeTrades(): Unsubscribe {
    return () => {};
  }

  subscribeBook(): Unsubscribe {
    return () => {};
  }

  isFeedUp(): boolean {
    return this.market.poller.isUp();
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    return this.market.poller.onState(listener);
  }

  async close(): Promise<void> {
    this.market.close();
  }

  async prepare(): Promise<void> {
    await this.market.ready();
  }

  private async listingOf(ticker: string) {
    await this.market.ready();
    const listing = this.market.listings.get(this.id, ticker);
    if (!listing) {
      throw new MarketError('unknown_symbol', `${this.name} doesn't list ${ticker}`);
    }
    if (!listing.dataSymbol || !this.market.listings.hasData(listing)) {
      throw new MarketError('unknown_symbol', `There's no market data for ${ticker} yet`);
    }
    return listing;
  }

  private async dataSymbolOf(ticker: string): Promise<string> {
    const listing = await this.listingOf(ticker);
    await this.market.requireData();
    return listing.dataSymbol as string;
  }

  private timeframeOf(resolution: Resolution): AlpacaTimeframe {
    const timeframe = TIMEFRAMES[formatResolution(resolution)];
    if (!timeframe) {
      throw new MarketError(
        'unsupported_resolution',
        `${this.name} serves ${Object.keys(TIMEFRAMES).join(', ')} natively`,
      );
    }
    return timeframe;
  }

  /** The last whole minute the plan serves, as an inclusive end. */
  private latestMinute(): number {
    return Math.floor(this.market.client.latestAvailable() / MINUTE) * MINUTE - 1;
  }

  /**
   * A bar on the session clock: intraday ones only in regular hours, day bars timed at their
   * session's open (Alpaca times them at the date's midnight).
   */
  private inSession(bar: Bar, resolution: Resolution): Bar | null {
    if (resolution.unit !== 'day') {
      return this.clock.isOpen(bar.time * 1000) ? bar : null;
    }
    const date = new Date(bar.time * 1000).toISOString().slice(0, 10);
    const session = this.market.calendar.schedule().session(dayOf(date), 'regular');
    return session ? { ...bar, time: session.open / 1000 } : null;
  }

  /**
   * For day bars, the open (ms) of a session still trading: its bar is the live feed's, built
   * the same way the feed builds it. Null when there's none (or for intraday bars).
   */
  private liveDay(resolution: Resolution): number | null {
    if (resolution.unit !== 'day') return null;
    const available = this.market.client.latestAvailable();
    const session = this.clock.open(DAY, available);
    return available < this.clock.close(DAY, session) ? session : null;
  }
}
