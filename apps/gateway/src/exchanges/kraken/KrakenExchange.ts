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
  RequestPacer,
  symbolInfo,
} from '../shared.ts';
import {
  parseKrakenInstruments,
  parseKrakenOhlcUpdate,
  parseKrakenPairs,
  parseKrakenTicker,
  parseKrakenTrade,
} from './parse.ts';
import { KrakenRest } from './rest.ts';
import { krakenProtocol, krakenTopic } from './stream.ts';

export const KRAKEN_DEFAULTS = {
  restUrl: 'https://api.kraken.com',
  streamUrl: 'wss://ws.kraken.com/v2',
};

/**
 * Kraken's OHLC intervals in minutes. Its weekly bars start on Thursday, not Monday as
 * TradingView's do, so weeks (and months) are built from days instead.
 */
export const KRAKEN_INTERVALS = new IntervalTable('Kraken', [
  ['1', '1'],
  ['5', '5'],
  ['15', '15'],
  ['30', '30'],
  ['60', '60'],
  ['240', '240'],
  ['1D', '1440'],
]);

/** Measured 2026-10-19: bursts of a dozen public requests pass; five a second is safe. */
const REQUEST_GAP_MS = 200;
/** Kraken serves only the latest 720 bars of each interval (and the live one after them). */
const HISTORY_BARS = 720;

/**
 * Kraken spot: candles, trades and the best bid and ask from its WebSocket v2; history from
 * REST, which holds only the latest 720 bars of each interval.
 */
export class KrakenExchange implements ExchangeAdapter, CatalogSource {
  readonly id = 'KRAKEN';
  readonly name = 'Kraken';
  readonly maxBarsPerRequest = HISTORY_BARS;
  readonly nativeResolutions = KRAKEN_INTERVALS.native;

  private readonly rest: KrakenRest;
  private readonly stream: StreamClient;
  private readonly instruments: InstrumentBook;
  private readonly names: AssetNames;
  private readonly warn: (message: string) => void;

  constructor(options: ExchangeOptions = {}) {
    this.warn = options.onWarning ?? (() => {});
    this.names = options.names ?? new AssetNames();
    this.rest = new KrakenRest({
      baseUrl: options.restUrl ?? KRAKEN_DEFAULTS.restUrl,
      pacer: new RequestPacer(REQUEST_GAP_MS),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.stream = new StreamClient(krakenProtocol(), {
      pingIntervalMs: 20_000,
      ...options.stream,
      url: options.streamUrl ?? KRAKEN_DEFAULTS.streamUrl,
      onWarning: this.warn,
    });
    this.instruments = new InstrumentBook('Kraken', () => this.rest.instruments());
  }

  prepare(): Promise<void> {
    return this.instruments.prepare();
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const instrument = await this.instruments.get(ticker);
    return symbolInfo(this, instrument, this.names, KRAKEN_INTERVALS.resolutions);
  }

  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const interval = KRAKEN_INTERVALS.require(resolution);
    const { restId } = await this.instruments.get(ticker);
    if (endTimeMs !== null && !this.keepsBarsBefore(resolution, endTimeMs)) return [];
    const bars = await this.rest.ohlc(restId, interval);
    const before = endTimeMs === null ? bars : bars.filter((bar) => bar.time * 1000 < endTimeMs);
    return before.slice(-limit);
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const interval = KRAKEN_INTERVALS.require(resolution);
    const { restId } = await this.instruments.get(ticker);
    if (!this.keepsBarsBefore(resolution, endMs)) return [];
    const bars = await this.rest.ohlc(restId, interval, startMs / 1000 - 1);
    return bars.filter((bar) => bar.time * 1000 >= startMs && bar.time * 1000 < endMs);
  }

  /**
   * Kraken keeps only its latest 720 bars, so the oldest it has is the pair's listing only when
   * it's newer than the oldest bar a pair listed before that window would have.
   */
  historyFromListing(resolution: Resolution, firstBarMs: number): boolean {
    const barMs = resolutionDurationMs(resolution);
    if (barMs === null) return false;
    return firstBarMs > barOpenTime(resolution, Date.now()) - (HISTORY_BARS - 2) * barMs;
  }

  /**
   * Whether any bar Kraken still keeps opens before `endMs`, so asking can return something.
   * A bar's margin covers Kraken moving on to a new bar a moment before or after this clock.
   */
  private keepsBarsBefore(resolution: Resolution, endMs: number): boolean {
    const barMs = resolutionDurationMs(resolution);
    if (barMs === null) return true;
    return endMs > barOpenTime(resolution, Date.now()) - (HISTORY_BARS + 1) * barMs;
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = krakenTopic.ohlc(KRAKEN_INTERVALS.require(resolution), instrument.streamId);
    return this.stream.subscribe(topic, (data) => {
      const { item, timestamp } = data as { item: unknown; timestamp: unknown };
      const update = parseKrakenOhlcUpdate(item, timestamp);
      if (update) onUpdate(update);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = krakenTopic.trade(instrument.streamId);
    return this.stream.subscribe(topic, (item) => {
      const trade = parseKrakenTrade(item);
      if (trade) onTrade(trade);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = krakenTopic.ticker(instrument.streamId);
    return this.stream.subscribe(topic, (item) => {
      const top = parseKrakenTicker(item);
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

  /** Every online pair with its 24 h figures, for search. */
  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [assetPairs, ticker] = await Promise.all([
      this.rest.assetPairsBody(),
      this.rest.tickerBody(),
    ]);
    this.instruments.remember(parseKrakenInstruments(assetPairs));
    return { pairs: parseKrakenPairs(assetPairs, ticker), names: {} };
  }

  private loaded(ticker: string) {
    const instrument = this.instruments.loaded(ticker);
    if (!instrument) this.warn(`Kraken: ${ticker} was not looked up before streaming`);
    return instrument;
  }
}
