import {
  type AggTrade,
  type Bar,
  parseResolution,
  precisionOf,
  type Resolution,
  type SymbolInfo,
} from '@tradingnerd/core';
import type { CatalogSnapshot, CatalogSource } from '../../catalog/types.ts';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
  type TickSource,
  type Trade,
  type Unsubscribe,
} from '../../market/types.ts';
import { BinanceRest } from './BinanceRest.ts';
import { BinanceStream, type BinanceStreamOptions } from './BinanceStream.ts';
import { BINANCE_RESOLUTIONS, binanceInterval } from './intervals.ts';
import { type BinanceSymbol, parseAggTrade, parseBookTicker, parseKlineEvent } from './parse.ts';

export const BINANCE_DEFAULTS = {
  restUrl: 'https://api.binance.com',
  streamUrl: 'wss://stream.binance.com:9443/stream',
  assetsUrl: 'https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset',
};

export interface BinanceExchangeOptions {
  restUrl?: string;
  streamUrl?: string;
  assetsUrl?: string;
  fetch?: typeof fetch;
  /** Fine-tuning for the stream connection (tests use short timings). */
  stream?: Omit<BinanceStreamOptions, 'url' | 'onWarning'>;
  onWarning?: (message: string) => void;
}

const SYMBOL_TTL_MS = 60 * 60_000;
/** How long the full pair list (from the catalog) answers symbol lookups without a request. */
const LISTING_TTL_MS = 12 * 60 * 60_000;
const ASSET_NAMES_TTL_MS = 24 * 60 * 60_000;
const ASSET_NAMES_RETRY_MS = 5 * 60_000;
/** Longest a symbol lookup waits for display names before falling back to asset codes. */
const ASSET_NAMES_WAIT_MS = 3_000;

export class BinanceExchange implements ExchangeAdapter, CatalogSource {
  readonly id = 'BINANCE';
  readonly name = 'Binance';
  readonly maxBarsPerRequest = 1_000;
  readonly nativeResolutions: readonly Resolution[] = BINANCE_RESOLUTIONS.map((text) => {
    const resolution = parseResolution(text);
    if (!resolution) throw new Error(`Invalid Binance resolution ${text}`);
    return resolution;
  });

  readonly ticks: TickSource;

  private readonly rest: BinanceRest;
  private readonly stream: BinanceStream;
  private readonly warn: (message: string) => void;
  /** Each pair's listing; its description is made per lookup, so it has the latest names. */
  private readonly symbols = new Map<string, { symbol: Promise<BinanceSymbol>; expires: number }>();
  private assetNames: { names: Promise<Map<string, string>>; expires: number } | null = null;
  /** Every trading pair, from the last catalog fetch: lookups need no request of their own. */
  private listing: { symbols: Map<string, BinanceSymbol>; fetchedAt: number } | null = null;

  constructor(options: BinanceExchangeOptions = {}) {
    this.warn = options.onWarning ?? (() => {});
    this.rest = new BinanceRest({
      baseUrl: options.restUrl ?? BINANCE_DEFAULTS.restUrl,
      assetsUrl: options.assetsUrl ?? BINANCE_DEFAULTS.assetsUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.stream = new BinanceStream({
      ...options.stream,
      url: options.streamUrl ?? BINANCE_DEFAULTS.streamUrl,
      onWarning: this.warn,
    });
    const rest = this.rest;
    this.ticks = {
      maxPerRequest: 1_000,
      aggTrades: (ticker, fromId, limit) =>
        rest.aggTrades(ticker, fromId === null ? { limit } : { fromId, limit }),
      // Binance looks aggregates up by their own id, not by trade id: find the trade's time,
      // then the aggregate of that millisecond that holds it.
      async aggTradeContaining(ticker, tradeId): Promise<AggTrade | null> {
        const trade = await rest.tradeById(ticker, tradeId);
        if (!trade) return null;
        const candidates = await rest.aggTrades(ticker, {
          startTimeMs: trade.time,
          endTimeMs: trade.time,
          limit: 1_000,
        });
        return candidates.find((agg) => agg.firstId <= tradeId && tradeId <= agg.lastId) ?? null;
      },
    };
  }

  async resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const [symbol, names] = await Promise.all([this.listingOf(ticker), this.displayNames()]);
    const name = (code: string) => names.get(code) ?? code;
    return {
      id: `${this.id}:${symbol.symbol}`,
      exchange: this.id,
      exchangeName: this.name,
      ticker: symbol.symbol,
      base: symbol.baseAsset,
      quote: symbol.quoteAsset,
      description: `${name(symbol.baseAsset)} / ${name(symbol.quoteAsset)}`,
      type: 'spot',
      tickSize: symbol.tickSize,
      pricePrecision: precisionOf(symbol.tickSize),
      resolutions: [...BINANCE_RESOLUTIONS],
    };
  }

  /** The pair's listing, cached; failures aren't. */
  private listingOf(ticker: string): Promise<BinanceSymbol> {
    const cached = this.symbols.get(ticker);
    if (cached && cached.expires > Date.now()) return cached.symbol;
    // A pair from a recent full list needs no request: picking one goes live a round trip sooner.
    const listed =
      this.listing && Date.now() - this.listing.fetchedAt < LISTING_TTL_MS
        ? this.listing.symbols.get(ticker)
        : undefined;
    const symbol = listed ? Promise.resolve(listed) : this.rest.symbol(ticker);
    this.symbols.set(ticker, { symbol, expires: Date.now() + SYMBOL_TTL_MS });
    symbol.catch(() => {
      if (this.symbols.get(ticker)?.symbol === symbol) this.symbols.delete(ticker);
    });
    return symbol;
  }

  // Async, so an unsupported interval rejects rather than throwing at the call.
  async fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    return this.rest.klines(ticker, this.interval(resolution), endTimeMs, limit);
  }

  async fetchRange(
    ticker: string,
    resolution: Resolution,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    const interval = this.interval(resolution);
    return this.rest.klines(ticker, interval, endMs, this.maxBarsPerRequest, startMs);
  }

  subscribeCandles(
    ticker: string,
    resolution: Resolution,
    onUpdate: (update: CandleUpdate) => void,
  ): Unsubscribe {
    const stream = `${ticker.toLowerCase()}@kline_${this.interval(resolution)}`;
    return this.stream.subscribe(stream, (data) => {
      const update = parseKlineEvent(data);
      if (update) onUpdate(update);
      else this.warn(`Ignored a malformed ${stream} message`);
    });
  }

  subscribeTrades(ticker: string, onTrade: (trade: Trade) => void): Unsubscribe {
    const stream = `${ticker.toLowerCase()}@aggTrade`;
    return this.stream.subscribe(stream, (data) => {
      const trade = parseAggTrade(data);
      if (trade) onTrade(trade);
      else this.warn(`Ignored a malformed ${stream} message`);
    });
  }

  subscribeBook(ticker: string, onBook: (top: BookTop) => void): Unsubscribe {
    const stream = `${ticker.toLowerCase()}@bookTicker`;
    return this.stream.subscribe(stream, (data) => {
      const top = parseBookTicker(data);
      if (top) onBook(top);
      else this.warn(`Ignored a malformed ${stream} message`);
    });
  }

  /** Every trading spot pair with its 24 h figures, and Binance's asset names, for search. */
  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [listings, stats, names] = await Promise.all([
      this.rest.tradingSymbols(),
      this.rest.miniTickers(),
      this.loadAssetNames(),
    ]);
    this.listing = {
      symbols: new Map(listings.map((listing) => [listing.symbol, listing])),
      fetchedAt: Date.now(),
    };
    return {
      pairs: listings.map((listing) => {
        const stat = stats.get(listing.symbol);
        return {
          ticker: listing.symbol,
          base: listing.baseAsset,
          quote: listing.quoteAsset,
          quoteVolume: stat?.quoteVolume ?? 0,
          last: stat?.last ?? 0,
        };
      }),
      names: Object.fromEntries(names),
    };
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

  private interval(resolution: Resolution): string {
    const interval = binanceInterval(resolution);
    if (!interval) {
      throw new MarketError('unsupported_resolution', "Binance doesn't serve this interval");
    }
    return interval;
  }

  /**
   * Asset display names ("USDT" → "TetherUS") come from an unofficial Binance endpoint, so they
   * are best-effort: cached for a day, never waited on for long, and never a reason to fail.
   */
  private displayNames(): Promise<Map<string, string>> {
    return withTimeout(this.loadAssetNames(), ASSET_NAMES_WAIT_MS, new Map());
  }

  /** The asset names, cached; never rejects (an empty map when they couldn't be loaded). */
  private loadAssetNames(): Promise<Map<string, string>> {
    if (!this.assetNames || this.assetNames.expires <= Date.now()) {
      const names: Promise<Map<string, string>> = this.rest.assetNames().catch((error: unknown) => {
        this.warn(`Couldn't load Binance asset names; showing asset codes (${String(error)})`);
        if (this.assetNames?.names === names) {
          this.assetNames = { names, expires: Date.now() + ASSET_NAMES_RETRY_MS };
        }
        return new Map();
      });
      this.assetNames = { names, expires: Date.now() + ASSET_NAMES_TTL_MS };
    }
    return this.assetNames.names;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
