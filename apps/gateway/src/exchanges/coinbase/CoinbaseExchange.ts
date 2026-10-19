import {
  type Bar,
  barOpenTime,
  type Resolution,
  resolutionDurationMs,
  type SymbolInfo,
} from '@tradingnerd/core';
import { AssetNames } from '../../catalog/names.ts';
import type { CatalogSnapshot, CatalogSource } from '../../catalog/types.ts';
import type {
  BookTop,
  CandleUpdate,
  ExchangeAdapter,
  FeedState,
  Trade,
  Unsubscribe,
} from '../../market/types.ts';
import { StreamClient } from '../../stream/StreamClient.ts';
import {
  type ExchangeOptions,
  InstrumentBook,
  IntervalTable,
  pollCandles,
  RequestPacer,
  symbolInfo,
} from '../shared.ts';
import {
  parseCoinbaseCatalog,
  parseCoinbaseInstruments,
  parseCoinbaseTicker,
  parseCoinbaseTrades,
} from './parse.ts';
import { CoinbaseRest } from './rest.ts';
import { coinbaseProtocol, coinbaseTopic } from './stream.ts';

export const COINBASE_DEFAULTS = {
  restUrl: 'https://api.coinbase.com',
  streamUrl: 'wss://advanced-trade-ws.coinbase.com',
};

/** Coinbase's candle granularities; weeks and months are built from days. */
export const COINBASE_INTERVALS = new IntervalTable('Coinbase', [
  ['1', 'ONE_MINUTE'],
  ['5', 'FIVE_MINUTE'],
  ['15', 'FIFTEEN_MINUTE'],
  ['30', 'THIRTY_MINUTE'],
  ['60', 'ONE_HOUR'],
  ['120', 'TWO_HOUR'],
  ['240', 'FOUR_HOUR'],
  ['360', 'SIX_HOUR'],
  ['1D', 'ONE_DAY'],
]);

/** Coinbase allows 10 public requests a second. */
const REQUEST_GAP_MS = 125;
const WINDOW_BARS = 350;
/** Windows looked back through for the last price before a quiet stretch. */
const LOOKBACK_WINDOWS = 2;
/** How long a window of past bars is kept for the windows and look-backs next to it. */
const PAST_WINDOW_TTL_MS = 30_000;

/**
 * Coinbase spot. Its stream has trades and the best bid and ask but only 5-minute candles, so
 * the live candle starts from REST, ticks with every trade and is checked against REST every
 * 30 s. Its REST candles leave out periods without trades; those are filled in as flat bars
 * at the last price, the way the other exchanges send them.
 */
export class CoinbaseExchange implements ExchangeAdapter, CatalogSource {
  readonly id = 'COINBASE';
  readonly name = 'Coinbase';
  readonly maxBarsPerRequest = WINDOW_BARS;
  /** Quiet periods are filled in, so windows can be fetched side by side. */
  readonly gapless = true;
  readonly nativeResolutions = COINBASE_INTERVALS.native;

  private readonly rest: CoinbaseRest;
  private readonly stream: StreamClient;
  private readonly instruments: InstrumentBook;
  private readonly names: AssetNames;
  private readonly warn: (message: string) => void;
  private readonly pastWindows = new Map<string, { expires: number; bars: Promise<Bar[]> }>();

  constructor(options: ExchangeOptions = {}) {
    this.warn = options.onWarning ?? (() => {});
    this.names = options.names ?? new AssetNames();
    this.rest = new CoinbaseRest({
      baseUrl: options.restUrl ?? COINBASE_DEFAULTS.restUrl,
      pacer: new RequestPacer(REQUEST_GAP_MS),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.stream = new StreamClient(coinbaseProtocol(), {
      ...options.stream,
      url: options.streamUrl ?? COINBASE_DEFAULTS.streamUrl,
      onWarning: this.warn,
    });
    this.instruments = new InstrumentBook('Coinbase', () => this.rest.instruments());
  }

  prepare(): Promise<void> {
    return this.instruments.prepare();
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const instrument = await this.instruments.get(ticker);
    return symbolInfo(this, instrument, this.names, COINBASE_INTERVALS.resolutions);
  }

  /** The `limit` periods before `endTimeMs` (up to and with the live one when null). */
  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const barMs = this.barMs(resolution);
    const end = endTimeMs ?? barOpenTime(resolution, Date.now()) + barMs;
    return this.window(ticker, resolution, end - limit * barMs, end);
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    return this.window(ticker, resolution, startMs, endMs);
  }

  /** Every period in [startMs, endMs): Coinbase's bars, quiet ones filled in. */
  private async window(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const granularity = COINBASE_INTERVALS.require(resolution);
    const barMs = this.barMs(resolution);
    const { restId } = await this.instruments.get(ticker);
    const traded = await this.candles(restId, granularity, barMs, startMs, endMs);
    const first = traded[0];
    const before =
      first && first.time * 1000 === startMs
        ? null
        : await this.lastCloseBefore(restId, granularity, barMs, startMs);
    return fillQuietPeriods(traded, startMs, endMs, barMs, before);
  }

  /** The last traded price before `ms`, looking a few windows back; null before history. */
  private async lastCloseBefore(
    productId: string,
    granularity: string,
    barMs: number,
    ms: number,
  ): Promise<number | null> {
    let end = ms;
    for (let i = 0; i < LOOKBACK_WINDOWS; i++) {
      const start = end - WINDOW_BARS * barMs;
      const bars = await this.candles(productId, granularity, barMs, start, end);
      const last = bars.at(-1);
      if (last) return last.close;
      end = start;
    }
    return null;
  }

  /**
   * Coinbase's traded bars in [startMs, endMs). A window of closed bars is shared for a while:
   * a chart's windows are fetched side by side, and the look back from one window for the last
   * price before it asks for exactly the window next to it.
   */
  private candles(
    productId: string,
    granularity: string,
    barMs: number,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const request = () =>
      this.rest.candles(productId, granularity, startMs / 1000, endMs / 1000 - 1);
    const now = Date.now();
    if (endMs + barMs > now) return request(); // the live bar, or one that has only just closed
    for (const [key, kept] of this.pastWindows) {
      if (kept.expires <= now) this.pastWindows.delete(key);
    }
    const key = `${productId} ${granularity} ${startMs} ${endMs}`;
    const kept = this.pastWindows.get(key);
    if (kept) return kept.bars;
    const bars = request();
    this.pastWindows.set(key, { expires: now + PAST_WINDOW_TTL_MS, bars });
    bars.catch(() => this.pastWindows.delete(key));
    return bars;
  }

  private barMs(resolution: Resolution): number {
    COINBASE_INTERVALS.require(resolution);
    const ms = resolutionDurationMs(resolution);
    if (ms === null) throw new Error('Coinbase intervals are fixed lengths');
    return ms;
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    COINBASE_INTERVALS.require(resolution);
    return pollCandles(
      () => this.fetchBars(ticker, resolution, null, 2),
      onUpdate,
      (message) => this.warn(`Coinbase ${ticker}: ${message}`),
    );
  }

  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = coinbaseTopic('market_trades', instrument.streamId);
    return this.stream.subscribe(topic, (event) => {
      const trades = parseCoinbaseTrades(event);
      if (trades) for (const trade of trades) onTrade(trade);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = coinbaseTopic('ticker', instrument.streamId);
    return this.stream.subscribe(topic, (ticker) => {
      const top = parseCoinbaseTicker(ticker);
      if (top) onBook(top);
    });
  }

  isFeedUp(): boolean {
    return this.stream.isUp();
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    return this.stream.onState(listener);
  }

  close(): Promise<void> {
    return this.stream.close();
  }

  /** Every tradable spot pair with its 24 h figures and Coinbase's asset names, for search. */
  async fetchCatalog(): Promise<CatalogSnapshot> {
    const body = await this.rest.productsBody();
    this.instruments.remember(parseCoinbaseInstruments(body));
    return parseCoinbaseCatalog(body);
  }

  private loaded(ticker: string) {
    const instrument = this.instruments.loaded(ticker);
    if (!instrument) this.warn(`Coinbase: ${ticker} was not looked up before streaming`);
    return instrument;
  }
}

/**
 * Every period of [startMs, endMs), `traded` where Coinbase has a bar and a flat one at the
 * last price where it doesn't. Before the first trade (`before` null) there are no bars.
 */
export function fillQuietPeriods(
  traded: readonly Bar[],
  startMs: number,
  endMs: number,
  barMs: number,
  before: number | null,
): Bar[] {
  const bars: Bar[] = [];
  let next = 0;
  let last = before;
  for (let t = startMs; t < endMs; t += barMs) {
    while ((traded[next]?.time ?? Number.POSITIVE_INFINITY) * 1000 < t) next++;
    const bar = traded[next];
    if (bar && bar.time * 1000 === t) {
      bars.push(bar);
      last = bar.close;
      next++;
    } else if (last !== null) {
      bars.push({ time: t / 1000, open: last, high: last, low: last, close: last, volume: 0 });
    }
  }
  return bars;
}
