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

export const COINBASE_REST_URL = 'https://api.coinbase.com';

/** Coinbase's spot pairs, for the symbol search (live data arrives in M5). */
export class CoinbaseCatalog implements CatalogSource {
  readonly id = 'COINBASE';
  readonly name = 'Coinbase';
  private readonly baseUrl: string;
  private readonly http: FetchOptions;

  constructor(options: CatalogSourceOptions = {}) {
    this.baseUrl = (options.restUrl ?? COINBASE_REST_URL).replace(/\/$/, '');
    this.http = options.fetch ? { fetch: options.fetch } : {};
  }

  async fetchCatalog(): Promise<CatalogSnapshot> {
    const body = await getJson(
      `${this.baseUrl}/api/v3/brokerage/market/products?product_type=SPOT`,
      this.name,
      this.http,
    );
    return parseCoinbaseCatalog(body);
  }
}

/**
 * Tradable pairs from Coinbase Advanced Trade's public GET /market/products, which also names
 * assets ("US Dollar"). Coinbase writes "XRP-USD"; TradingView's ticker is "XRPUSD". Products
 * with an `alias` (XRP-USDC is XRP-USD's own book) are left out, so each book is listed once.
 */
export function parseCoinbaseCatalog(body: unknown): CatalogSnapshot {
  if (!isObject(body) || !Array.isArray(body.products)) throw unexpected('Coinbase', 'products');
  const pairs: CatalogPair[] = [];
  const names: Record<string, string> = {};
  for (const product of body.products) {
    if (!isObject(product) || product.product_type !== 'SPOT' || product.status !== 'online') {
      continue;
    }
    if (product.trading_disabled === true || product.is_disabled === true) continue;
    if (product.view_only === true || product.cancel_only === true) continue;
    if (typeof product.alias === 'string' && product.alias !== '') continue;
    if (typeof product.product_id !== 'string') continue;
    const [base, quote, extra] = product.product_id.split('-');
    if (extra !== undefined || !isAsset(base) || !isAsset(quote)) continue;
    const ticker = `${base}${quote}`;
    if (!isTicker(ticker)) continue;
    pairs.push({
      ticker,
      base,
      quote,
      quoteVolume: amount(product.approximate_quote_24h_volume),
      last: amount(product.price),
    });
    if (typeof product.base_name === 'string' && product.base_name.trim()) {
      names[base] = product.base_name.trim();
    }
    if (typeof product.quote_name === 'string' && product.quote_name.trim()) {
      names[quote] = product.quote_name.trim();
    }
  }
  return { pairs, names };
}
