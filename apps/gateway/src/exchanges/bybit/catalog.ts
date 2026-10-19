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

export const BYBIT_REST_URL = 'https://api.bybit.com';

/** Bybit's spot pairs, for the symbol search (live data arrives in M5). */
export class BybitCatalog implements CatalogSource {
  readonly id = 'BYBIT';
  readonly name = 'Bybit';
  private readonly baseUrl: string;
  private readonly http: FetchOptions;

  constructor(options: CatalogSourceOptions = {}) {
    this.baseUrl = (options.restUrl ?? BYBIT_REST_URL).replace(/\/$/, '');
    this.http = options.fetch ? { fetch: options.fetch } : {};
  }

  async fetchCatalog(): Promise<CatalogSnapshot> {
    const [instruments, tickers] = await Promise.all([
      getJson(`${this.baseUrl}/v5/market/instruments-info?category=spot`, this.name, this.http),
      getJson(`${this.baseUrl}/v5/market/tickers?category=spot`, this.name, this.http),
    ]);
    return { pairs: parseBybitPairs(instruments, tickers), names: {} };
  }
}

function resultList(body: unknown, what: string): unknown[] {
  if (!isObject(body) || body.retCode !== 0 || !isObject(body.result)) {
    throw unexpected('Bybit', what);
  }
  const { list } = body.result;
  if (!Array.isArray(list)) throw unexpected('Bybit', what);
  return list;
}

/** Trading pairs from GET /v5/market/instruments-info, with 24 h figures from /tickers. */
export function parseBybitPairs(instruments: unknown, tickers: unknown): CatalogPair[] {
  const stats = new Map<string, { last: number; quoteVolume: number }>();
  for (const item of resultList(tickers, 'tickers')) {
    if (isObject(item) && typeof item.symbol === 'string') {
      stats.set(item.symbol, {
        last: amount(item.lastPrice),
        quoteVolume: amount(item.turnover24h),
      });
    }
  }
  const pairs: CatalogPair[] = [];
  for (const item of resultList(instruments, 'instruments')) {
    if (!isObject(item) || item.status !== 'Trading') continue;
    const { symbol, baseCoin, quoteCoin } = item;
    if (!isTicker(symbol) || !isAsset(baseCoin) || !isAsset(quoteCoin)) continue;
    const stat = stats.get(symbol);
    pairs.push({
      ticker: symbol,
      base: baseCoin,
      quote: quoteCoin,
      quoteVolume: stat?.quoteVolume ?? 0,
      last: stat?.last ?? 0,
    });
  }
  return pairs;
}
