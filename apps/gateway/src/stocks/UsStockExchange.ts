import {
  type Bar,
  type BarClock,
  dayOf,
  formatResolution,
  parseResolution,
  type Resolution,
  type SessionHours,
  type SymbolInfo,
} from '@tradingnerd/core';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type Trade,
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
/** Alpaca's first day of history: a stock whose bars begin later was listed then. */
const FIRST_HISTORY_DAY = Date.UTC(2016, 0, 4);
const DAY = 86_400_000;
const MINUTE = 60_000;

/**
 * One US exchange's listings (NASDAQ, NYSE, AMEX, CBOE, …), with Alpaca's whole-market data:
 * bars on the exchange's session clock (intraday ones in regular hours, or with pre- and
 * post-market when asked), delayed as the key's plan is; live bars from the shared minute
 * poller, moved between its polls by the stream's trades; and the stream's best bid and ask
 * for the legend's Sell and Buy. Stocks have no tick charts.
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

  clockFor(hours: SessionHours): BarClock {
    return this.market.clockFor(hours);
  }

  get delayMs(): number {
    return this.market.delayMs();
  }

  /** A stock's bars reach its listing unless they begin where Alpaca's history does (2016). */
  historyFromListing(_resolution: Resolution, firstBarMs: number): boolean {
    return firstBarMs >= FIRST_HISTORY_DAY + DAY;
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
      hasBook: true,
      schedule: this.market.calendar.schedule().data,
    };
  }

  /**
   * Up to `limit` bars opening before `endTimeMs`, newest last, intraday ones in `hours`.
   * Alpaca's bars include pre- and post-market ones, which regular hours leave out, so pages
   * continue until enough remain or history begins. A bar still forming is left to the live
   * feed.
   */
  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
    hours: SessionHours = 'regular',
  ): Promise<Bar[]> {
    const symbol = await this.dataSymbolOf(ticker);
    const timeframe = this.timeframeOf(resolution);
    const latest = this.latestMinute();
    let end = endTimeMs === null ? latest : Math.min(endTimeMs - 1, latest);
    const forming = this.formingBar(resolution, hours);
    // A regular day keeps 6.5 of the 16 hours Alpaca has bars for.
    const spread = timeframe === '1Day' ? 1 : hours === 'regular' ? 2.6 : 1.1;
    const newestFirst: Bar[] = [];
    while (newestFirst.length < limit) {
      const wanted = limit - newestFirst.length;
      const ask = Math.min(ALPACA_PAGE_LIMIT, Math.ceil(wanted * spread) + 10);
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
        const kept = this.inSession(bar, resolution, hours);
        if (kept && kept.time * 1000 !== forming) newestFirst.push(kept);
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
    hours: SessionHours = 'regular',
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
    const forming = this.formingBar(resolution, hours);
    return page.flatMap((bar) => {
      const kept = this.inSession(bar, resolution, hours);
      return kept && kept.time * 1000 !== forming ? [kept] : [];
    });
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
    hours: SessionHours = 'regular',
  ): Unsubscribe {
    const listing = this.market.listings.get(this.id, ticker);
    if (!listing?.dataSymbol) return () => {};
    return this.market.poller.subscribe(listing.dataSymbol, resolution, onUpdate, hours);
  }

  /** Trades from Alpaca's stream (as late as its bars), between the minute bars' polls. */
  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe {
    const listing = this.market.listings.get(this.id, ticker);
    if (!listing?.dataSymbol) return () => {};
    return this.market.stream.subscribeTrades(listing.dataSymbol, onTrade);
  }

  /** The best bid and ask across the market, from Alpaca's stream. */
  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const listing = this.market.listings.get(this.id, ticker);
    if (!listing?.dataSymbol) return () => {};
    return this.market.stream.subscribeQuotes(listing.dataSymbol, onBook);
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
   * A bar on the session clock: intraday ones only in `hours`, day bars timed at their
   * session's open (Alpaca times them at the date's midnight).
   */
  private inSession(bar: Bar, resolution: Resolution, hours: SessionHours): Bar | null {
    if (resolution.unit !== 'day') {
      return this.clockFor(hours).isOpen(bar.time * 1000) ? bar : null;
    }
    const date = new Date(bar.time * 1000).toISOString().slice(0, 10);
    const session = this.market.calendar.schedule().session(dayOf(date), 'regular');
    return session ? { ...bar, time: session.open / 1000 } : null;
  }

  /**
   * The open (ms) of the bar still forming where the plan's data ends, or null when the last
   * bar is complete. Alpaca hands such a bar back whole, with minutes the plan doesn't serve
   * yet (a 5-minute bar asked for at 10:47 holds 10:47–10:49 too), so it's the live feed's:
   * the feed builds it from the minutes there are, as it does a day still trading.
   */
  private formingBar(resolution: Resolution, hours: SessionHours): number | null {
    const clock = this.clockFor(hours);
    const horizon = Math.floor(this.market.client.latestAvailable() / MINUTE) * MINUTE;
    const open = clock.open(resolution, horizon - 1);
    return clock.close(resolution, open) > horizon ? open : null;
  }
}
