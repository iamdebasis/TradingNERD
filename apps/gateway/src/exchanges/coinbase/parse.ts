import type { Bar } from '@tradingnerd/core';
import {
  amount,
  decimal,
  isAsset,
  isObject,
  isTicker,
  type Json,
  toBar,
  unexpected,
} from '../../catalog/http.ts';
import type { CatalogPair, CatalogSnapshot } from '../../catalog/types.ts';
import type { BookTop, Trade } from '../../market/types.ts';
import type { Instrument } from '../shared.ts';

// Coinbase Advanced Trade's public endpoints: decimals as strings, times as ISO text or
// UNIX seconds; products are "XRP-USD".

/**
 * Tradable products from GET /market/products. Products with an `alias` (XRP-USDC is
 * XRP-USD's own book) are left out, so each book is listed once.
 */
function tradable(body: unknown): { product: Json; base: string; quote: string }[] {
  if (!isObject(body) || !Array.isArray(body.products)) throw unexpected('Coinbase', 'products');
  const products: { product: Json; base: string; quote: string }[] = [];
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
    if (!isTicker(`${base}${quote}`)) continue;
    products.push({ product, base, quote });
  }
  return products;
}

/** Instruments, with their price increments. */
export function parseCoinbaseInstruments(body: unknown): Instrument[] {
  return tradable(body).flatMap(({ product, base, quote }) => {
    const tickSize = decimal(product.price_increment) || decimal(product.quote_increment);
    if (!tickSize) return [];
    const id = String(product.product_id);
    return [{ ticker: `${base}${quote}`, restId: id, streamId: id, base, quote, tickSize }];
  });
}

/** Pairs with 24 h figures, and the asset names Coinbase publishes ("US Dollar"). */
export function parseCoinbaseCatalog(body: unknown): CatalogSnapshot {
  const pairs: CatalogPair[] = [];
  const names: Record<string, string> = {};
  for (const { product, base, quote } of tradable(body)) {
    pairs.push({
      ticker: `${base}${quote}`,
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

/** Bars from GET /market/products/{id}/candles, newest first; returned ascending. */
export function parseCoinbaseCandles(body: unknown): Bar[] {
  if (!isObject(body) || !Array.isArray(body.candles)) throw unexpected('Coinbase', 'candles');
  const bars: Bar[] = [];
  for (const candle of body.candles) {
    if (!isObject(candle)) throw unexpected('Coinbase', 'candles');
    const bar = toBar(
      Number(candle.start) * 1000,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    );
    if (!bar) throw unexpected('Coinbase', 'candles');
    bars.push(bar);
  }
  return bars.sort((a, b) => a.time - b.time);
}

/**
 * Trades from a `market_trades` event, oldest first. The snapshot sent on subscribing repeats
 * trades the REST history already counted, so only updates are taken.
 */
export function parseCoinbaseTrades(event: unknown): Trade[] | null {
  if (!isObject(event) || !Array.isArray(event.trades)) return null;
  if (event.type !== 'update') return [];
  const trades: Trade[] = [];
  for (const entry of event.trades) {
    if (!isObject(entry)) return null;
    const price = decimal(entry.price);
    const quantity = decimal(entry.size);
    const time = typeof entry.time === 'string' ? Date.parse(entry.time) : Number.NaN;
    if (!price || quantity === null || !Number.isFinite(time)) return null;
    trades.push({ price, quantity, time });
  }
  return trades.sort((a, b) => a.time - b.time);
}

/** The best bid and ask from a `ticker` entry. */
export function parseCoinbaseTicker(ticker: unknown): BookTop | null {
  if (!isObject(ticker)) return null;
  const bid = decimal(ticker.best_bid);
  const ask = decimal(ticker.best_ask);
  return bid && ask ? { bid, ask } : null;
}
