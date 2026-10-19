import type { Bar } from '@tradingnerd/core';
import { getJson } from '../../catalog/http.ts';
import type { Instrument, RequestPacer } from '../shared.ts';
import { parseKrakenInstruments, parseKrakenOhlc } from './parse.ts';

export interface KrakenRestOptions {
  baseUrl: string;
  pacer: RequestPacer;
  fetch?: typeof fetch;
}

/** Kraken's public REST API. */
export class KrakenRest {
  private readonly baseUrl: string;
  private readonly pacer: RequestPacer;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(options: KrakenRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.pacer = options.pacer;
    this.fetchFn = options.fetch;
  }

  assetPairsBody(): Promise<unknown> {
    return this.get('/0/public/AssetPairs');
  }

  tickerBody(): Promise<unknown> {
    return this.get('/0/public/Ticker');
  }

  async instruments(): Promise<Instrument[]> {
    return parseKrakenInstruments(await this.assetPairsBody());
  }

  /** The latest 720 bars (or those after `sinceSec`), ascending; the last is still open. */
  async ohlc(pairKey: string, interval: string, sinceSec?: number): Promise<Bar[]> {
    const params = new URLSearchParams({ pair: pairKey, interval });
    if (sinceSec !== undefined) params.set('since', String(sinceSec));
    return parseKrakenOhlc(await this.get(`/0/public/OHLC?${params}`), pairKey);
  }

  private async get(path: string): Promise<unknown> {
    await this.pacer.wait();
    return getJson(`${this.baseUrl}${path}`, 'Kraken', this.fetchFn ? { fetch: this.fetchFn } : {});
  }
}
