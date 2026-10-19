import type { Bar } from '@tradingnerd/core';
import { normalizeAsset } from '../../catalog/entries.ts';
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
import type { CatalogPair } from '../../catalog/types.ts';
import type { BookTop, CandleUpdate, Trade } from '../../market/types.ts';
import { MarketError } from '../../market/types.ts';
import type { Instrument } from '../shared.ts';

// Kraken's REST API sends decimals as strings and times as UNIX seconds; its WebSocket v2
// sends numbers and ISO times. Pairs have three names: "XXBTZUSD" (REST), "XBTUSD" (its
// short name, TradingView's ticker) and, on the v2 stream, "BTC/USD".

/** Kraken's REST answers: an `error` list that must be empty, and a `result`. */
function result(body: unknown, what: string): Json {
  if (!isObject(body) || !Array.isArray(body.error)) throw unexpected('Kraken', what);
  const [error] = body.error;
  if (typeof error === 'string') throw errorFor(error);
  if (!isObject(body.result)) throw unexpected('Kraken', what);
  return body.result;
}

function errorFor(error: string): MarketError {
  if (/Unknown asset pair/i.test(error)) {
    return new MarketError('unknown_symbol', 'Kraken does not list this symbol');
  }
  if (/rate limit|too many requests/i.test(error)) {
    return new MarketError('rate_limited', 'Kraken is rate-limiting requests; try again shortly');
  }
  return new MarketError('upstream_error', `Kraken error: ${error}`);
}

function onlinePairs(body: unknown): { key: string; pair: Json; base: string; quote: string }[] {
  const pairs: { key: string; pair: Json; base: string; quote: string }[] = [];
  for (const [key, pair] of Object.entries(result(body, 'asset pairs'))) {
    if (!isObject(pair) || pair.status !== 'online') continue;
    if (!isTicker(pair.altname) || typeof pair.wsname !== 'string') continue;
    const [base, quote, extra] = pair.wsname.split('/');
    if (extra !== undefined || !isAsset(base) || !isAsset(quote)) continue;
    pairs.push({ key, pair, base, quote });
  }
  return pairs;
}

/** Online pairs from GET /0/public/AssetPairs, with their tick sizes. */
export function parseKrakenInstruments(body: unknown): Instrument[] {
  return onlinePairs(body).flatMap(({ key, pair, base, quote }) => {
    const tickSize = decimal(pair.tick_size);
    if (!tickSize) return [];
    const [b, q] = [normalizeAsset(base), normalizeAsset(quote)];
    return [
      {
        ticker: String(pair.altname),
        restId: key,
        streamId: `${b}/${q}`,
        base: b,
        quote: q,
        tickSize,
      },
    ];
  });
}

/**
 * Online pairs with 24 h figures from /0/public/Ticker, for the search catalog. Kraken counts
 * volume in the base asset, so the quote volume is that times the last price.
 */
export function parseKrakenPairs(assetPairs: unknown, ticker: unknown): CatalogPair[] {
  const stats = result(ticker, 'tickers');
  return onlinePairs(assetPairs).map(({ key, pair, base, quote }) => {
    const stat = stats[key];
    const last = isObject(stat) && Array.isArray(stat.c) ? amount(stat.c[0]) : 0;
    const volume = isObject(stat) && Array.isArray(stat.v) ? amount(stat.v[1]) : 0;
    return { ticker: String(pair.altname), base, quote, quoteVolume: volume * last, last };
  });
}

/** Bars from GET /0/public/OHLC (oldest first; the last is still open). */
export function parseKrakenOhlc(body: unknown, pairKey: string): Bar[] {
  const rows = result(body, 'OHLC')[pairKey];
  if (!Array.isArray(rows)) throw unexpected('Kraken', 'OHLC');
  return rows.map((row) => {
    // [time, open, high, low, close, vwap, volume, count]
    const bar = Array.isArray(row)
      ? toBar(Number(row[0]) * 1000, row[1], row[2], row[3], row[4], row[6])
      : null;
    if (!bar) throw unexpected('Kraken', 'OHLC');
    return bar;
  });
}

/** Candle snapshots from an `ohlc` item, as of the message's own time. */
export function parseKrakenOhlcUpdate(item: unknown, sentAt: unknown): CandleUpdate | null {
  if (!isObject(item) || typeof item.interval_begin !== 'string') return null;
  const bar = toBar(
    Date.parse(item.interval_begin),
    item.open,
    item.high,
    item.low,
    item.close,
    item.volume,
  );
  const eventTime = typeof sentAt === 'string' ? Date.parse(sentAt) : Number.NaN;
  if (!bar) return null;
  return { bar, eventTime: Number.isFinite(eventTime) ? eventTime : Date.now() };
}

/** A trade from a `trade` item. */
export function parseKrakenTrade(item: unknown): Trade | null {
  if (!isObject(item) || typeof item.timestamp !== 'string') return null;
  const price = decimal(item.price);
  const quantity = decimal(item.qty);
  const time = Date.parse(item.timestamp);
  return price && quantity !== null && Number.isFinite(time) ? { price, quantity, time } : null;
}

/** The best bid and ask from a `ticker` item. */
export function parseKrakenTicker(item: unknown): BookTop | null {
  if (!isObject(item)) return null;
  const bid = decimal(item.bid);
  const ask = decimal(item.ask);
  return bid && ask ? { bid, ask } : null;
}
