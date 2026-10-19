import type { AggTrade, Bar } from '@tradingnerd/core';
import { MarketError } from '../../market/types.ts';
import {
  type BinanceSymbol,
  parseAggTradeRow,
  parseAssetNames,
  parseExchangeInfo,
  parseKlineRow,
  parseMiniTickers,
  parseTradeRow,
  parseTradingSymbols,
} from './parse.ts';

export interface BinanceRestOptions {
  /** Market data API, e.g. https://api.binance.com */
  baseUrl: string;
  /** Binance's public asset list (unofficial); used only for display names. */
  assetsUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Binance error code for "Invalid symbol." */
const INVALID_SYMBOL = -1121;

export class BinanceRest {
  private readonly baseUrl: string;
  private readonly assetsUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BinanceRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.assetsUrl = options.assetsUrl;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Up to `limit` klines opening strictly before `endTimeMs` (or the latest when null). With
   * `startTimeMs`, the earliest `limit` klines opening at or after it instead.
   */
  async klines(
    symbol: string,
    interval: string,
    endTimeMs: number | null,
    limit: number,
    startTimeMs?: number,
  ): Promise<Bar[]> {
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (startTimeMs !== undefined) params.set('startTime', String(startTimeMs));
    // Binance's endTime is inclusive of the bar open time; ours is exclusive.
    if (endTimeMs !== null) params.set('endTime', String(endTimeMs - 1));
    const rows = await this.get(`${this.baseUrl}/api/v3/klines?${params}`);
    if (!Array.isArray(rows)) throw upstream('Binance returned an unexpected klines response');
    const bars: Bar[] = [];
    for (const row of rows) {
      const bar = parseKlineRow(row);
      if (!bar) throw upstream('Binance returned a malformed kline');
      bars.push(bar);
    }
    return bars;
  }

  /**
   * Aggregate trades, ascending: up to `limit` from aggregate id `fromId` up, those at or
   * after `startTimeMs` (with `endTimeMs`), or the latest.
   */
  async aggTrades(
    symbol: string,
    query: { fromId?: number; startTimeMs?: number; endTimeMs?: number; limit: number },
  ): Promise<AggTrade[]> {
    const params = new URLSearchParams({ symbol, limit: String(query.limit) });
    if (query.fromId !== undefined) params.set('fromId', String(query.fromId));
    if (query.startTimeMs !== undefined) params.set('startTime', String(query.startTimeMs));
    if (query.endTimeMs !== undefined) params.set('endTime', String(query.endTimeMs));
    const rows = await this.get(`${this.baseUrl}/api/v3/aggTrades?${params}`);
    if (!Array.isArray(rows)) throw upstream('Binance returned an unexpected aggTrades response');
    return rows.map((row) => {
      const trade = parseAggTradeRow(row);
      if (!trade) throw upstream('Binance returned a malformed aggregate trade');
      return trade;
    });
  }

  /** The trade with id `fromId`, if Binance still has it (only its id and time). */
  async tradeById(symbol: string, id: number): Promise<{ id: number; time: number } | null> {
    const params = new URLSearchParams({ symbol, fromId: String(id), limit: '1' });
    const rows = await this.get(`${this.baseUrl}/api/v3/historicalTrades?${params}`);
    if (!Array.isArray(rows)) throw upstream('Binance returned an unexpected trades response');
    const trade = rows[0] === undefined ? null : parseTradeRow(rows[0]);
    return trade && trade.id === id ? trade : null;
  }

  async symbol(symbol: string): Promise<BinanceSymbol> {
    const body = await this.get(
      `${this.baseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`,
    );
    const info = parseExchangeInfo(body);
    if (!info) throw upstream('Binance returned unexpected symbol information');
    return info;
  }

  /** Every spot pair that is trading (about 1,400; weight 20). */
  async tradingSymbols(): Promise<BinanceSymbol[]> {
    const body = await this.get(
      `${this.baseUrl}/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING&showPermissionSets=false`,
    );
    const listings = parseTradingSymbols(body);
    if (!listings) throw upstream('Binance returned an unexpected symbol list');
    return listings;
  }

  /** Last price and 24 h quote volume of every symbol (weight 80). */
  async miniTickers(): Promise<Map<string, { last: number; quoteVolume: number }>> {
    const stats = parseMiniTickers(await this.get(`${this.baseUrl}/api/v3/ticker/24hr?type=MINI`));
    if (!stats) throw upstream('Binance returned unexpected 24 h tickers');
    return stats;
  }

  async assetNames(): Promise<Map<string, string>> {
    return parseAssetNames(await this.get(this.assetsUrl));
  }

  private async get(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw upstream(`Binance is unreachable (${detail})`);
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep body null; handled below
    }
    if (response.ok) {
      if (body === null) throw upstream('Binance returned a response that is not JSON');
      return body;
    }
    throw errorFor(response.status, body);
  }
}

function upstream(message: string) {
  return new MarketError('upstream_error', message);
}

function errorFor(status: number, body: unknown): MarketError {
  const code =
    typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  const msg =
    typeof body === 'object' && body !== null ? (body as { msg?: unknown }).msg : undefined;
  if (status === 400 && code === INVALID_SYMBOL) {
    return new MarketError('unknown_symbol', 'Binance does not list this symbol');
  }
  if (status === 429 || status === 418) {
    return new MarketError('rate_limited', 'Binance is rate-limiting requests; try again shortly');
  }
  if (status === 451) {
    return upstream('Binance is not available from this location (HTTP 451)');
  }
  return upstream(`Binance error HTTP ${status}${typeof msg === 'string' ? `: ${msg}` : ''}`);
}
