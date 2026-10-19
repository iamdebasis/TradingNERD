import type { Bar } from '@tradingnerd/core';
import { getJson } from '../../catalog/http.ts';
import type { Instrument, RequestPacer } from '../shared.ts';
import { parseCoinbaseCandles, parseCoinbaseInstruments } from './parse.ts';

export interface CoinbaseRestOptions {
  baseUrl: string;
  pacer: RequestPacer;
  fetch?: typeof fetch;
}

/** Coinbase Advanced Trade's public market data (no key). */
export class CoinbaseRest {
  private readonly baseUrl: string;
  private readonly pacer: RequestPacer;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(options: CoinbaseRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.pacer = options.pacer;
    this.fetchFn = options.fetch;
  }

  productsBody(): Promise<unknown> {
    return this.get('/api/v3/brokerage/market/products?product_type=SPOT');
  }

  async instruments(): Promise<Instrument[]> {
    return parseCoinbaseInstruments(await this.productsBody());
  }

  /**
   * Bars opening in [startSec, endSec] (inclusive, at most 350 bar lengths), ascending. Only
   * periods with trades come back.
   */
  async candles(productId: string, granularity: string, startSec: number, endSec: number) {
    const params = new URLSearchParams({
      start: String(startSec),
      end: String(endSec),
      granularity,
      limit: '350',
    });
    const path = `/api/v3/brokerage/market/products/${encodeURIComponent(productId)}/candles`;
    return parseCoinbaseCandles(await this.get(`${path}?${params}`)) as Bar[];
  }

  private async get(path: string): Promise<unknown> {
    await this.pacer.wait();
    return getJson(
      `${this.baseUrl}${path}`,
      'Coinbase',
      this.fetchFn ? { fetch: this.fetchFn } : {},
    );
  }
}
