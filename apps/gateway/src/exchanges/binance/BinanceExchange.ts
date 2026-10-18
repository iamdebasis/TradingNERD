import {
  type AggTrade,
  type Bar,
  parseResolution,
  precisionOf,
  type Resolution,
  type SymbolInfo,
} from '@tradingnerd/core';
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
import { parseAggTrade, parseBookTicker, parseKlineEvent } from './parse.ts';

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
const ASSET_NAMES_TTL_MS = 24 * 60 * 60_000;
const ASSET_NAMES_RETRY_MS = 5 * 60_000;
/** Longest a symbol lookup waits for display names before falling back to asset codes. */
const ASSET_NAMES_WAIT_MS = 3_000;

export class BinanceExchange implements ExchangeAdapter {
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
  private readonly symbols = new Map<string, { info: Promise<SymbolInfo>; expires: number }>();
  private assetNames: { names: Promise<Map<string, string>>; expires: number } | null = null;

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

  resolveSymbol(ticker: string): Promise<SymbolInfo> {
    const cached = this.symbols.get(ticker);
    if (cached && cached.expires > Date.now()) return cached.info;
    const info = this.loadSymbol(ticker);
    this.symbols.set(ticker, { info, expires: Date.now() + SYMBOL_TTL_MS });
    info.catch(() => {
      if (this.symbols.get(ticker)?.info === info) this.symbols.delete(ticker);
    });
    return info;
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

  private async loadSymbol(ticker: string): Promise<SymbolInfo> {
    const [symbol, names] = await Promise.all([this.rest.symbol(ticker), this.displayNames()]);
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

  /**
   * Asset display names ("USDT" → "TetherUS") come from an unofficial Binance endpoint, so they
   * are best-effort: cached for a day, never waited on for long, and never a reason to fail.
   */
  private displayNames(): Promise<Map<string, string>> {
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
    return withTimeout(this.assetNames.names, ASSET_NAMES_WAIT_MS, new Map());
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
