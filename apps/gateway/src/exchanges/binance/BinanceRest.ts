import type { Bar } from '@tradingnerd/core';
import { MarketError } from '../../market/types.ts';
import { type BinanceSymbol, parseAssetNames, parseExchangeInfo, parseKlineRow } from './parse.ts';

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

  /** Up to `limit` klines opening strictly before `endTimeMs` (or the latest when null). */
  async klines(
    symbol: string,
    interval: string,
    endTimeMs: number | null,
    limit: number,
  ): Promise<Bar[]> {
    const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
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

  async symbol(symbol: string): Promise<BinanceSymbol> {
    const body = await this.get(
      `${this.baseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`,
    );
    const info = parseExchangeInfo(body);
    if (!info) throw upstream('Binance returned unexpected symbol information');
    return info;
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
