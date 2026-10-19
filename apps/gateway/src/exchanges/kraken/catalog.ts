import {
  amount,
  type FetchOptions,
  getJson,
  isAsset,
  isObject,
  isTicker,
  unexpected,
} from '../../catalog/http.ts';
import type {
  CatalogPair,
  CatalogSnapshot,
  CatalogSource,
  CatalogSourceOptions,
} from '../../catalog/types.ts';

export const KRAKEN_REST_URL = 'https://api.kraken.com';

/** Kraken's spot pairs, for the symbol search (live data arrives in M5). */
export class KrakenCatalog implements CatalogSource {
  readonly id = 'KRAKEN';
  readonly name = 'Kraken';
  private readonly baseUrl: string;
  private readonly http: FetchOptions;

  constructor(options: CatalogSourceOptions = {}) {
    this.baseUrl = (options.restUrl ?? KRAKEN_REST_URL).replace(/\/$/, '');
    this.http = options.fetch ? { fetch: options.fetch } : {};
  }

  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [assetPairs, ticker] = await Promise.all([
      getJson(`${this.baseUrl}/0/public/AssetPairs`, this.name, this.http),
      getJson(`${this.baseUrl}/0/public/Ticker`, this.name, this.http),
    ]);
    return { pairs: parseKrakenPairs(assetPairs, ticker), names: {} };
  }
}

function resultMap(body: unknown, what: string): Record<string, unknown> {
  if (!isObject(body) || !Array.isArray(body.error) || body.error.length > 0) {
    throw unexpected('Kraken', what);
  }
  if (!isObject(body.result)) throw unexpected('Kraken', what);
  return body.result;
}

/**
 * Online pairs from GET /0/public/AssetPairs, with 24 h figures from /Ticker. The ticker is
 * Kraken's own short name ("XBTUSD", as TradingView writes it); the assets come from its
 * WebSocket name ("XBT/USD"). Kraken counts volume in the base asset, so the quote volume is
 * that times the last price.
 */
export function parseKrakenPairs(assetPairs: unknown, ticker: unknown): CatalogPair[] {
  const stats = resultMap(ticker, 'tickers');
  const pairs: CatalogPair[] = [];
  for (const [key, pair] of Object.entries(resultMap(assetPairs, 'asset pairs'))) {
    if (!isObject(pair) || pair.status !== 'online') continue;
    const { altname, wsname } = pair;
    if (!isTicker(altname) || typeof wsname !== 'string') continue;
    const [base, quote, extra] = wsname.split('/');
    if (extra !== undefined || !isAsset(base) || !isAsset(quote)) continue;
    const stat = stats[key];
    const last = isObject(stat) && Array.isArray(stat.c) ? amount(stat.c[0]) : 0;
    const volume = isObject(stat) && Array.isArray(stat.v) ? amount(stat.v[1]) : 0;
    pairs.push({ ticker: altname, base, quote, quoteVolume: volume * last, last });
  }
  return pairs;
}
