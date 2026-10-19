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
  CombinedFeed,
  type ExchangeOptions,
  InstrumentBook,
  IntervalTable,
  RequestPacer,
  symbolInfo,
} from '../shared.ts';
import {
  parseOkxBbo,
  parseOkxCandleUpdates,
  parseOkxInstruments,
  parseOkxPairs,
  parseOkxTrades,
} from './parse.ts';
import { OkxRest } from './rest.ts';
import { okxProtocol, okxTopic } from './stream.ts';

export const OKX_DEFAULTS = {
  restUrl: 'https://www.okx.com',
  /** Trades and the best bid and ask. */
  streamUrl: 'wss://ws.okx.com:8443/ws/v5/public',
  /** Candles. */
  businessStreamUrl: 'wss://ws.okx.com:8443/ws/v5/business',
};

/**
 * OKX's bars. From 6 hours up, the "utc" kinds: OKX's plain daily bar starts at midnight in
 * Hong Kong. Weeks start Monday and months on the 1st, as TradingView's.
 */
export const OKX_INTERVALS = new IntervalTable('OKX', [
  ['1S', '1s'],
  ['1', '1m'],
  ['3', '3m'],
  ['5', '5m'],
  ['15', '15m'],
  ['30', '30m'],
  ['60', '1H'],
  ['120', '2H'],
  ['240', '4H'],
  ['360', '6Hutc'],
  ['720', '12Hutc'],
  ['1D', '1Dutc'],
  ['1W', '1Wutc'],
  ['1M', '1Mutc'],
]);

/** OKX allows 20 history requests every 2 s; one every 110 ms stays inside every limit. */
const REQUEST_GAP_MS = 110;
/** History requests a bar fetch may add once the recent endpoint runs out. */
const HISTORY_TOP_UPS = 4;
const HISTORY_PAGE = 100;
/** How far back OKX's recent-candles endpoint reaches, in bars (measured 2026-10-19). */
const RECENT_BARS = 1_440;

export interface OkxOptions extends ExchangeOptions {
  /** Candle stream endpoint (OKX's "business" one). */
  businessStreamUrl?: string | undefined;
}

/**
 * OKX spot: candles on its business stream, trades and the best bid and ask on its public
 * one; history from REST, 300 recent bars a request and older ones 100 at a time.
 */
export class OkxExchange implements ExchangeAdapter, CatalogSource {
  readonly id = 'OKX';
  readonly name = 'OKX';
  readonly maxBarsPerRequest = 300;
  readonly nativeResolutions = OKX_INTERVALS.native;

  private readonly rest: OkxRest;
  private readonly publicStream: StreamClient;
  private readonly businessStream: StreamClient;
  private readonly feed: CombinedFeed;
  private readonly instruments: InstrumentBook;
  private readonly names: AssetNames;
  private readonly warn: (message: string) => void;

  constructor(options: OkxOptions = {}) {
    this.warn = options.onWarning ?? (() => {});
    this.names = options.names ?? new AssetNames();
    this.rest = new OkxRest({
      baseUrl: options.restUrl ?? OKX_DEFAULTS.restUrl,
      pacer: new RequestPacer(REQUEST_GAP_MS),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const streamOptions = { pingIntervalMs: 20_000, ...options.stream, onWarning: this.warn };
    this.publicStream = new StreamClient(okxProtocol(), {
      ...streamOptions,
      url: options.streamUrl ?? OKX_DEFAULTS.streamUrl,
    });
    this.businessStream = new StreamClient(okxProtocol(), {
      ...streamOptions,
      url: options.businessStreamUrl ?? OKX_DEFAULTS.businessStreamUrl,
    });
    this.feed = new CombinedFeed([this.publicStream, this.businessStream]);
    this.instruments = new InstrumentBook('OKX', () => this.rest.instruments());
  }

  prepare(): Promise<void> {
    return this.instruments.prepare();
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const instrument = await this.instruments.get(ticker);
    return symbolInfo(this, instrument, this.names, OKX_INTERVALS.resolutions);
  }

  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const bar = OKX_INTERVALS.require(resolution);
    const { restId } = await this.instruments.get(ticker);
    return this.collect(restId, bar, resolution, endTimeMs, null, limit);
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const bar = OKX_INTERVALS.require(resolution);
    const { restId } = await this.instruments.get(ticker);
    return this.collect(restId, bar, resolution, endMs, startMs, this.maxBarsPerRequest);
  }

  /**
   * Up to `limit` bars opening before `endMs` (and at or after `startMs`), ascending. The
   * recent endpoint reaches back about 1,440 bars; past that, the history endpoint tops up.
   */
  private async collect(
    instId: string,
    bar: string,
    resolution: Resolution,
    endMs: number | null,
    startMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const range = {
      ...(endMs === null ? {} : { after: endMs }),
      ...(startMs === null ? {} : { before: startMs - 1 }),
    };
    // A range wholly older than the recent window goes straight to the history endpoint.
    const barMs = resolutionDurationMs(resolution);
    const recentFrom = barMs === null ? Number.NEGATIVE_INFINITY : Date.now() - RECENT_BARS * barMs;
    const bars =
      endMs !== null && endMs <= recentFrom
        ? []
        : await this.rest.candles(instId, bar, {
            ...range,
            limit: Math.min(limit, this.maxBarsPerRequest),
          });
    for (let extra = 0; extra < HISTORY_TOP_UPS && bars.length < limit; extra++) {
      const oldest = bars[0] ? bars[0].time * 1000 : (endMs ?? Date.now());
      if (startMs !== null && oldest <= startMs) break;
      const older = await this.rest.historyCandles(instId, bar, {
        ...range,
        after: oldest,
        limit: Math.min(HISTORY_PAGE, limit - bars.length),
      });
      if (older.length === 0) break;
      bars.unshift(...older);
    }
    return bars;
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = okxTopic(`candle${OKX_INTERVALS.require(resolution)}`, instrument.streamId);
    return this.businessStream.subscribe(topic, (message) => {
      const updates = parseOkxCandleUpdates(message, Date.now());
      if (updates) for (const update of updates) onUpdate(update);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = okxTopic('trades', instrument.streamId);
    return this.publicStream.subscribe(topic, (message) => {
      const trades = parseOkxTrades(message);
      if (trades) for (const trade of trades) onTrade(trade);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const instrument = this.loaded(ticker);
    if (!instrument) return () => {};
    const topic = okxTopic('bbo-tbt', instrument.streamId);
    return this.publicStream.subscribe(topic, (message) => {
      const top = parseOkxBbo(message);
      if (top) onBook(top);
      else this.warn(`Ignored a malformed ${topic} message`);
    });
  }

  isFeedUp(): boolean {
    return this.feed.isUp();
  }

  onFeedState(listener: (state: FeedState) => void): Unsubscribe {
    return this.feed.onState(listener);
  }

  close(): Promise<void> {
    return this.feed.close();
  }

  /** Every live spot pair with its 24 h figures, for search. */
  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [instruments, tickers] = await Promise.all([
      this.rest.instrumentsBody(),
      this.rest.tickersBody(),
    ]);
    this.instruments.remember(parseOkxInstruments(instruments));
    return { pairs: parseOkxPairs(instruments, tickers), names: {} };
  }

  /** Feeds resolve their symbol before subscribing, so the instrument is known by now. */
  private loaded(ticker: string) {
    const instrument = this.instruments.loaded(ticker);
    if (!instrument) this.warn(`OKX: ${ticker} was not looked up before streaming`);
    return instrument;
  }
}
