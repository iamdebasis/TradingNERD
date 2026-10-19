import type { Bar } from '@tradingnerd/core';
import { getJson, isObject } from '../../catalog/http.ts';
import { MarketError } from '../../market/types.ts';
import type { Instrument, RequestPacer } from '../shared.ts';
import { parseBybitInstruments, parseBybitKlines } from './parse.ts';

export interface BybitRestOptions {
  baseUrl: string;
  pacer: RequestPacer;
  fetch?: typeof fetch;
}

/** Bybit's v5 public REST API, spot only. */
export class BybitRest {
  private readonly baseUrl: string;
  private readonly pacer: RequestPacer;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(options: BybitRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.pacer = options.pacer;
    this.fetchFn = options.fetch;
  }

  instrumentsBody(): Promise<unknown> {
    return this.get('/v5/market/instruments-info?category=spot');
  }

  tickersBody(): Promise<unknown> {
    return this.get('/v5/market/tickers?category=spot');
  }

  async instruments(): Promise<Instrument[]> {
    return parseBybitInstruments(await this.instrumentsBody());
  }

  /** Up to `limit` (1,000) bars opening in [start, end] (ms, inclusive), ascending. */
  async klines(
    symbol: string,
    interval: string,
    range: { start?: number; end?: number; limit: number },
  ): Promise<Bar[]> {
    const params = new URLSearchParams({
      category: 'spot',
      symbol,
      interval,
      limit: String(range.limit),
    });
    if (range.start !== undefined) params.set('start', String(range.start));
    if (range.end !== undefined) params.set('end', String(range.end));
    return parseBybitKlines(await this.get(`/v5/market/kline?${params}`));
  }

  private async get(path: string): Promise<unknown> {
    await this.pacer.wait();
    const body = await getJson(
      `${this.baseUrl}${path}`,
      'Bybit',
      this.fetchFn ? { fetch: this.fetchFn } : {},
    );
    if (isObject(body) && typeof body.retCode === 'number' && body.retCode !== 0) {
      throw errorFor(body.retCode, body.retMsg);
    }
    return body;
  }
}

function errorFor(code: number, message: unknown): MarketError {
  const detail = typeof message === 'string' ? message : `code ${code}`;
  // 10001: bad parameters, which for a kline request means a symbol Bybit doesn't list.
  if (code === 10001 && /symbol/i.test(detail)) {
    return new MarketError('unknown_symbol', 'Bybit does not list this symbol');
  }
  if (code === 10006 || code === 10018) {
    return new MarketError('rate_limited', 'Bybit is rate-limiting requests; try again shortly');
  }
  return new MarketError('upstream_error', `Bybit error: ${detail}`);
}
