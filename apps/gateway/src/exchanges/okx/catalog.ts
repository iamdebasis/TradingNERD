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

export const OKX_REST_URL = 'https://www.okx.com';

/** OKX's spot pairs, for the symbol search (live data arrives in M5). */
export class OkxCatalog implements CatalogSource {
  readonly id = 'OKX';
  readonly name = 'OKX';
  private readonly baseUrl: string;
  private readonly http: FetchOptions;

  constructor(options: CatalogSourceOptions = {}) {
    this.baseUrl = (options.restUrl ?? OKX_REST_URL).replace(/\/$/, '');
    this.http = options.fetch ? { fetch: options.fetch } : {};
  }

  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [instruments, tickers] = await Promise.all([
      getJson(`${this.baseUrl}/api/v5/public/instruments?instType=SPOT`, this.name, this.http),
      getJson(`${this.baseUrl}/api/v5/market/tickers?instType=SPOT`, this.name, this.http),
    ]);
    return { pairs: parseOkxPairs(instruments, tickers), names: {} };
  }
}

function dataList(body: unknown, what: string): unknown[] {
  if (!isObject(body) || body.code !== '0' || !Array.isArray(body.data)) {
    throw unexpected('OKX', what);
  }
  return body.data;
}

/**
 * Live pairs from GET /api/v5/public/instruments, with 24 h figures from /market/tickers. OKX
 * writes "XRP-USDT"; TradingView's ticker is "XRPUSDT". For spot, `volCcy24h` is in the quote
 * asset.
 */
export function parseOkxPairs(instruments: unknown, tickers: unknown): CatalogPair[] {
  const stats = new Map<string, { last: number; quoteVolume: number }>();
  for (const item of dataList(tickers, 'tickers')) {
    if (isObject(item) && typeof item.instId === 'string') {
      stats.set(item.instId, { last: amount(item.last), quoteVolume: amount(item.volCcy24h) });
    }
  }
  const pairs: CatalogPair[] = [];
  for (const item of dataList(instruments, 'instruments')) {
    if (!isObject(item) || item.state !== 'live') continue;
    const { instId, baseCcy, quoteCcy } = item;
    if (typeof instId !== 'string' || !isAsset(baseCcy) || !isAsset(quoteCcy)) continue;
    const ticker = `${baseCcy}${quoteCcy}`;
    if (!isTicker(ticker)) continue;
    const stat = stats.get(instId);
    pairs.push({
      ticker,
      base: baseCcy,
      quote: quoteCcy,
      quoteVolume: stat?.quoteVolume ?? 0,
      last: stat?.last ?? 0,
    });
  }
  return pairs;
}
