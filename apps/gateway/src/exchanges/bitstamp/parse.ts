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

// Bitstamp's public API v2: decimals as strings, times as UNIX seconds (microseconds for
// trades); a pair is "xrpusd" in URLs and channels, "XRP/USD" by name.

/** A Bitstamp pair, with Bitstamp's own description of it ("XRP / U.S. dollar"). */
export interface BitstampInstrument extends Instrument {
  description: string;
}

interface SpotMarket {
  market: Json;
  /** "xrpusd" */
  symbol: string;
  base: string;
  quote: string;
}

/**
 * Spot pairs open for trading, from GET /api/v2/markets/. Perpetuals ("btcusd-perp") and pairs
 * whose trading is disabled are left out.
 */
function spotMarkets(body: unknown): SpotMarket[] {
  if (!Array.isArray(body)) throw unexpected('Bitstamp', 'markets');
  const markets: SpotMarket[] = [];
  for (const market of body) {
    if (!isObject(market) || market.market_type !== 'SPOT' || market.trading !== 'Enabled') {
      continue;
    }
    const { market_symbol: symbol, base_currency: base, counter_currency: quote } = market;
    if (typeof symbol !== 'string' || !isAsset(base) || !isAsset(quote)) continue;
    if (symbol !== `${base}${quote}`.toLowerCase() || !isTicker(`${base}${quote}`)) continue;
    markets.push({ market, symbol, base, quote });
  }
  return markets;
}

/** "XRP / U.S. dollar" → its two names; null for anything else. */
function namesOf(description: unknown): [string, string] | null {
  if (typeof description !== 'string') return null;
  const [base, quote, extra] = description.split(' / ').map((part) => part.trim());
  return base && quote && extra === undefined ? [base, quote] : null;
}

/** Instruments, with their price increments (Bitstamp's decimals) and descriptions. */
export function parseBitstampInstruments(body: unknown): BitstampInstrument[] {
  return spotMarkets(body).flatMap(({ market, symbol, base, quote }) => {
    const decimals = market.counter_decimals;
    if (typeof decimals !== 'number' || !Number.isInteger(decimals)) return [];
    if (decimals < 0 || decimals > 12) return [];
    const names = namesOf(market.description);
    return [
      {
        ticker: `${base}${quote}`,
        restId: symbol,
        streamId: symbol,
        base,
        quote,
        tickSize: Number(`1e-${decimals}`),
        description: names ? `${names[0]} / ${names[1]}` : `${base} / ${quote}`,
      },
    ];
  });
}

/**
 * Pairs with their 24 h figures from GET /api/v2/ticker/, and the asset names Bitstamp's
 * descriptions give ("U.S. dollar"). Its volume is in the base asset, so the quote volume is
 * that times the last price.
 */
export function parseBitstampCatalog(markets: unknown, tickers: unknown): CatalogSnapshot {
  if (!Array.isArray(tickers)) throw unexpected('Bitstamp', 'tickers');
  const byName = new Map<string, Json>();
  for (const ticker of tickers) {
    if (isObject(ticker) && typeof ticker.pair === 'string') byName.set(ticker.pair, ticker);
  }
  const pairs: CatalogPair[] = [];
  const names: Record<string, string> = {};
  for (const { market, base, quote } of spotMarkets(markets)) {
    const ticker = typeof market.name === 'string' ? byName.get(market.name) : undefined;
    const last = amount(ticker?.last);
    pairs.push({
      ticker: `${base}${quote}`,
      base,
      quote,
      quoteVolume: amount(ticker?.volume) * last,
      last,
    });
    const assetNames = namesOf(market.description);
    if (assetNames) {
      names[base] = assetNames[0];
      names[quote] = assetNames[1];
    }
  }
  return { pairs, names };
}

/** Bars from GET /api/v2/ohlc/{pair}/, ascending. */
export function parseBitstampOhlc(body: unknown): Bar[] {
  const ohlc = isObject(body) && isObject(body.data) ? body.data.ohlc : undefined;
  if (!Array.isArray(ohlc)) throw unexpected('Bitstamp', 'bars');
  const bars: Bar[] = [];
  for (const entry of ohlc) {
    if (!isObject(entry)) throw unexpected('Bitstamp', 'bars');
    const bar = toBar(
      Number(entry.timestamp) * 1000,
      entry.open,
      entry.high,
      entry.low,
      entry.close,
      entry.volume,
    );
    if (!bar) throw unexpected('Bitstamp', 'bars');
    bars.push(bar);
  }
  return bars.sort((a, b) => a.time - b.time);
}

/** A trade from a `live_trades` event: its price, amount and time to the microsecond. */
export function parseBitstampTrade(data: unknown): Trade | null {
  if (!isObject(data)) return null;
  const price = decimal(data.price_str ?? data.price);
  const quantity = decimal(data.amount_str ?? data.amount);
  const micro = Number(data.microtimestamp);
  const time = micro > 0 ? Math.floor(micro / 1000) : Number(data.timestamp) * 1000;
  if (!price || quantity === null || !Number.isFinite(time) || time <= 0) return null;
  return { price, quantity, time };
}

/** The best bid and ask from an `order_book` snapshot (its top 100 levels). */
export function parseBitstampBook(data: unknown): BookTop | null {
  if (!isObject(data) || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return null;
  const [bestBid] = data.bids;
  const [bestAsk] = data.asks;
  const bid = Array.isArray(bestBid) ? decimal(bestBid[0]) : null;
  const ask = Array.isArray(bestAsk) ? decimal(bestAsk[0]) : null;
  return bid && ask ? { bid, ask } : null;
}
