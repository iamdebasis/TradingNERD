import type { Bar, Resolution, SymbolInfo } from '@tradingnerd/core';
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
  parseBybitBook,
  parseBybitInstruments,
  parseBybitKlineUpdates,
  parseBybitPairs,
  parseBybitTrades,
} from './parse.ts';
import { BybitRest } from './rest.ts';
import { bybitProtocol } from './stream.ts';

export const BYBIT_DEFAULTS = {
  restUrl: 'https://api.bybit.com',
  streamUrl: 'wss://stream.bybit.com/v5/public/spot',
};

/** Bybit's kline intervals; its weeks start Monday and months on the 1st, as TradingView's. */
export const BYBIT_INTERVALS = new IntervalTable('Bybit', [
  ['1', '1'],
  ['3', '3'],
  ['5', '5'],
  ['15', '15'],
  ['30', '30'],
  ['60', '60'],
  ['120', '120'],
  ['240', '240'],
  ['360', '360'],
  ['720', '720'],
  ['1D', 'D'],
  ['1W', 'W'],
  ['1M', 'M'],
]);

/** Bybit's REST limit is generous (600 requests in 5 s); 20 a second stays well inside it. */
const REQUEST_GAP_MS = 50;

/**
 * Bybit spot: candles (pushed when they change), trades as they happen and the best bid and ask
 * from its v5 public stream; history from its REST API, 1,000 bars a request.
 */
export class BybitExchange implements ExchangeAdapter, CatalogSource {
  readonly id = 'BYBIT';
  readonly name = 'Bybit';
  readonly maxBarsPerRequest = 1_000;
  readonly nativeResolutions = BYBIT_INTERVALS.native;

  private readonly rest: BybitRest;
  private readonly stream: StreamClient;
  private readonly instruments: InstrumentBook;
  private readonly names: AssetNames;
  private readonly warn: (message: string) => void;

  constructor(options: ExchangeOptions = {}) {
    this.warn = options.onWarning ?? (() => {});
    this.names = options.names ?? new AssetNames();
    this.rest = new BybitRest({
      baseUrl: options.restUrl ?? BYBIT_DEFAULTS.restUrl,
      pacer: new RequestPacer(REQUEST_GAP_MS),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.stream = new StreamClient(bybitProtocol(), {
      pingIntervalMs: 20_000,
      ...options.stream,
      url: options.streamUrl ?? BYBIT_DEFAULTS.streamUrl,
      onWarning: this.warn,
    });
    this.instruments = new InstrumentBook('Bybit', () => this.rest.instruments());
  }

  prepare(): Promise<void> {
    return this.instruments.prepare();
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const instrument = await this.instruments.get(ticker);
    return symbolInfo(this, instrument, this.names, BYBIT_INTERVALS.resolutions);
  }

  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const interval = BYBIT_INTERVALS.require(resolution);
    const { restId } = await this.instruments.get(ticker);
    return this.rest.klines(restId, interval, {
      ...(endTimeMs === null ? {} : { end: endTimeMs - 1 }),
      limit,
    });
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const interval = BYBIT_INTERVALS.require(resolution);
    const { restId } = await this.instruments.get(ticker);
    return this.rest.klines(restId, interval, {
      start: startMs,
      end: endMs - 1,
      limit: this.maxBarsPerRequest,
    });
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    const topic = `kline.${BYBIT_INTERVALS.require(resolution)}.${ticker}`;
    return this.stream.subscribe(topic, (message) => {
      const updates = parseBybitKlineUpdates(message);
      if (updates) for (const update of updates) onUpdate(update);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe {
    const topic = `publicTrade.${ticker}`;
    return this.stream.subscribe(topic, (message) => {
      const trades = parseBybitTrades(message);
      if (trades) for (const trade of trades) onTrade(trade);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const topic = `orderbook.1.${ticker}`;
    let bid: number | null = null;
    let ask: number | null = null;
    return this.stream.subscribe(topic, (message) => {
      const top = parseBybitBook(message);
      if (!top) {
        this.warn(`Ignored a malformed ${topic} message`);
        return;
      }
      if (top.snapshot || top.bid !== undefined) bid = top.bid ?? null;
      if (top.snapshot || top.ask !== undefined) ask = top.ask ?? null;
      if (bid && ask) onBook({ bid, ask });
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

  /** Every trading spot pair with its 24 h figures, for search. */
  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [instruments, tickers] = await Promise.all([
      this.rest.instrumentsBody(),
      this.rest.tickersBody(),
    ]);
    this.instruments.remember(parseBybitInstruments(instruments));
    return { pairs: parseBybitPairs(instruments, tickers), names: {} };
  }
}
