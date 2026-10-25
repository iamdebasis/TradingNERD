import {
  type Bar,
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
  symbolInfo,
} from '../shared.ts';
import {
  type BitstampInstrument,
  parseBitstampBook,
  parseBitstampCatalog,
  parseBitstampInstruments,
  parseBitstampTrade,
} from './parse.ts';
import { BitstampRest, type BitstampRestOptions } from './rest.ts';
import { bitstampChannel, bitstampProtocol } from './stream.ts';

export const BITSTAMP_DEFAULTS = {
  restUrl: 'https://www.bitstamp.net',
  streamUrl: 'wss://ws.bitstamp.net',
};

/**
 * Bitstamp's bar lengths, in seconds. Its 3-day bars are left to the gateway, which builds them
 * from days on the same boundaries as every exchange's; weeks and months too.
 */
export const BITSTAMP_INTERVALS = new IntervalTable('Bitstamp', [
  ['1', '60'],
  ['3', '180'],
  ['5', '300'],
  ['15', '900'],
  ['30', '1800'],
  ['60', '3600'],
  ['120', '7200'],
  ['240', '14400'],
  ['360', '21600'],
  ['720', '43200'],
  ['1D', '86400'],
]);

/** The most bars Bitstamp sends a request. */
const MAX_BARS = 1_000;

export interface BitstampOptions extends ExchangeOptions {
  /** Its REST client's waits: after a turned-away request, and between requests (tests use none). */
  rest?: Pick<BitstampRestOptions, 'retryDelaysMs' | 'gapMs'>;
}

/**
 * Bitstamp spot. Its bars come with quiet periods already filled in, at the last price, back to
 * each pair's first trade (Bitcoin's on 18 August 2011). Its stream has trades and the order
 * book but no candles, so the live candle starts from REST, ticks with every trade and is
 * checked against REST every 30 s, as Coinbase's is.
 */
export class BitstampExchange implements ExchangeAdapter, CatalogSource {
  readonly id = 'BITSTAMP';
  readonly name = 'Bitstamp';
  readonly maxBarsPerRequest = MAX_BARS;
  /** Bitstamp fills quiet periods in itself, so windows can be fetched side by side. */
  readonly gapless = true;
  readonly nativeResolutions = BITSTAMP_INTERVALS.native;

  private readonly rest: BitstampRest;
  private readonly stream: StreamClient;
  private readonly instruments: InstrumentBook<BitstampInstrument>;
  private readonly names: AssetNames;
  private readonly warn: (message: string) => void;

  constructor(options: BitstampOptions = {}) {
    this.warn = options.onWarning ?? (() => {});
    this.names = options.names ?? new AssetNames();
    this.rest = new BitstampRest({
      baseUrl: options.restUrl ?? BITSTAMP_DEFAULTS.restUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.rest ?? {}),
    });
    this.stream = new StreamClient(bitstampProtocol(), {
      ...options.stream,
      url: options.streamUrl ?? BITSTAMP_DEFAULTS.streamUrl,
      onWarning: this.warn,
    });
    this.instruments = new InstrumentBook('Bitstamp', () => this.rest.instruments());
  }

  prepare(): Promise<void> {
    return this.instruments.prepare();
  }

  /** Described as Bitstamp describes it, as TradingView shows it: "XRP / U.S. dollar". */
  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const instrument = await this.instruments.get(ticker);
    return {
      ...symbolInfo(this, instrument, this.names, BITSTAMP_INTERVALS.resolutions),
      description: instrument.description,
    };
  }

  /** The `limit` periods before `endTimeMs` (up to and with the live one when null). */
  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const step = BITSTAMP_INTERVALS.require(resolution);
    const count = Math.min(limit, MAX_BARS);
    if (count <= 0) return [];
    const { restId } = await this.instruments.get(ticker);
    if (endTimeMs === null) return this.rest.barsBefore(restId, step, count, null);
    // Bitstamp's `end` takes the bar opening at it too: a second earlier leaves only those before.
    const bars = await this.rest.barsBefore(restId, step, count, Math.ceil(endTimeMs / 1000) - 1);
    return bars.filter((bar) => bar.time * 1000 < endTimeMs);
  }

  /** Bars opening in [startMs, endMs), from the first boundary on: at most 1,000. */
  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const step = BITSTAMP_INTERVALS.require(resolution);
    const barMs = this.barMs(resolution);
    const first = Math.ceil(startMs / barMs) * barMs;
    const count = Math.min(MAX_BARS, Math.ceil((endMs - first) / barMs));
    if (count <= 0) return [];
    const { restId } = await this.instruments.get(ticker);
    const bars = await this.rest.barsFrom(restId, step, count, first / 1000);
    return bars.filter((bar) => bar.time * 1000 >= startMs && bar.time * 1000 < endMs);
  }

  private barMs(resolution: Resolution): number {
    const ms = resolutionDurationMs(resolution);
    if (ms === null) throw new Error('Bitstamp intervals are fixed lengths');
    return ms;
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    BITSTAMP_INTERVALS.require(resolution);
    return pollCandles(
      () => this.fetchBars(ticker, resolution, null, 2),
      onUpdate,
      (message) => this.warn(`Bitstamp ${ticker}: ${message}`),
    );
  }

  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = bitstampChannel.trades(instrument.streamId);
    return this.stream.subscribe(topic, (data) => {
      const trade = parseBitstampTrade(data);
      if (trade) onTrade(trade);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    return this.stream.subscribe(bitstampChannel.book(instrument.streamId), (data) => {
      const top = parseBitstampBook(data);
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

  /** Every spot pair trading, with its 24 h figures and Bitstamp's asset names, for search. */
  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [markets, tickers] = await Promise.all([this.rest.markets(), this.rest.tickers()]);
    this.instruments.remember(parseBitstampInstruments(markets));
    return parseBitstampCatalog(markets, tickers);
  }

  private loaded(ticker: string) {
    const instrument = this.instruments.loaded(ticker);
    if (!instrument) this.warn(`Bitstamp: ${ticker} was not looked up before streaming`);
    return instrument;
  }
}
