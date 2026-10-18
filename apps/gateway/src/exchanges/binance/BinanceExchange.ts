import { type Bar, precisionOf, type Resolution, type SymbolInfo } from '@tradingnerd/core';
import {
  type BookTop,
  type CandleUpdate,
  type ExchangeAdapter,
  type FeedState,
  MarketError,
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

  supportsResolution(resolution: Resolution): boolean {
    return binanceInterval(resolution) !== null;
  }

  fetchBars(
    ticker: string,
    resolution: Resolution,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    return this.rest.klines(ticker, this.interval(resolution), endTimeMs, limit);
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
