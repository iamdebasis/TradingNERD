import type { Bar } from '@tradingnerd/core';
import { getJson, isObject } from '../../catalog/http.ts';
import { MarketError } from '../../market/types.ts';
import type { Instrument, RequestPacer } from '../shared.ts';
import { parseOkxCandles, parseOkxInstruments } from './parse.ts';

export interface OkxRestOptions {
  baseUrl: string;
  pacer: RequestPacer;
  fetch?: typeof fetch;
}

/** Pagination by open time (ms), exclusive both ways: `after` older than, `before` newer than. */
export interface CandlePage {
  after?: number;
  before?: number;
  limit: number;
}

/** OKX's v5 public REST API, spot only. */
export class OkxRest {
  private readonly baseUrl: string;
  private readonly pacer: RequestPacer;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(options: OkxRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.pacer = options.pacer;
    this.fetchFn = options.fetch;
  }

  instrumentsBody(): Promise<unknown> {
    return this.get('/api/v5/public/instruments?instType=SPOT');
  }

  tickersBody(): Promise<unknown> {
    return this.get('/api/v5/market/tickers?instType=SPOT');
  }

  async instruments(): Promise<Instrument[]> {
    return parseOkxInstruments(await this.instrumentsBody());
  }

  /** Recent bars (about the latest 1,440), up to 300 a request; ascending. */
  candles(instId: string, bar: string, page: CandlePage): Promise<Bar[]> {
    return this.candlePage('/api/v5/market/candles', instId, bar, page);
  }

  /** Older bars, up to 100 a request; ascending. */
  historyCandles(instId: string, bar: string, page: CandlePage): Promise<Bar[]> {
    return this.candlePage('/api/v5/market/history-candles', instId, bar, page);
  }

  private async candlePage(path: string, instId: string, bar: string, page: CandlePage) {
    const params = new URLSearchParams({ instId, bar, limit: String(page.limit) });
    if (page.after !== undefined) params.set('after', String(page.after));
    if (page.before !== undefined) params.set('before', String(page.before));
    return parseOkxCandles(await this.get(`${path}?${params}`));
  }

  private async get(path: string): Promise<unknown> {
    await this.pacer.wait();
    const body = await getJson(
      `${this.baseUrl}${path}`,
      'OKX',
      this.fetchFn ? { fetch: this.fetchFn } : {},
    );
    if (isObject(body) && typeof body.code === 'string' && body.code !== '0') {
      throw errorFor(body.code, body.msg);
    }
    return body;
  }
}

function errorFor(code: string, message: unknown): MarketError {
  const detail = typeof message === 'string' && message ? message : `code ${code}`;
  if (code === '51001') return new MarketError('unknown_symbol', 'OKX does not list this symbol');
  if (code === '50011') {
    return new MarketError('rate_limited', 'OKX is rate-limiting requests; try again shortly');
  }
  return new MarketError('upstream_error', `OKX error: ${detail}`);
}
