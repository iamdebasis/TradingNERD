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
import type { CatalogPair } from '../../catalog/types.ts';
import type { CandleUpdate, Trade } from '../../market/types.ts';
import type { Instrument } from '../shared.ts';

// Bybit v5 sends decimals as strings and times as epoch-ms numbers or strings.

function resultList(body: unknown, what: string): unknown[] {
  if (!isObject(body) || body.retCode !== 0 || !isObject(body.result)) {
    throw unexpected('Bybit', what);
  }
  const { list } = body.result;
  if (!Array.isArray(list)) throw unexpected('Bybit', what);
  return list;
}

const tradingInstruments = (body: unknown): Json[] =>
  resultList(body, 'instruments').filter(
    (item): item is Json => isObject(item) && item.status === 'Trading',
  );

/** Trading spot pairs from GET /v5/market/instruments-info, with their tick sizes. */
export function parseBybitInstruments(body: unknown): Instrument[] {
  const instruments: Instrument[] = [];
  for (const item of tradingInstruments(body)) {
    const { symbol, baseCoin, quoteCoin, priceFilter } = item;
    const tickSize = isObject(priceFilter) ? decimal(priceFilter.tickSize) : null;
    if (!isTicker(symbol) || !isAsset(baseCoin) || !isAsset(quoteCoin) || !tickSize) continue;
    instruments.push({
      ticker: symbol,
      restId: symbol,
      streamId: symbol,
      base: baseCoin,
      quote: quoteCoin,
      tickSize,
    });
  }
  return instruments;
}

/** Trading pairs with 24 h figures from /v5/market/tickers, for the search catalog. */
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
  for (const item of tradingInstruments(instruments)) {
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

/** Bars from GET /v5/market/kline, which lists them newest first; returned ascending. */
export function parseBybitKlines(body: unknown): Bar[] {
  const bars: Bar[] = [];
  for (const row of resultList(body, 'klines')) {
    if (!Array.isArray(row)) throw unexpected('Bybit', 'klines');
    const bar = toBar(Number(row[0]), row[1], row[2], row[3], row[4], row[5]);
    if (!bar) throw unexpected('Bybit', 'klines');
    bars.push(bar);
  }
  return bars.reverse();
}

/** Candle snapshots from a `kline.{interval}.{symbol}` message. */
export function parseBybitKlineUpdates(message: unknown): CandleUpdate[] | null {
  if (!isObject(message) || !Array.isArray(message.data)) return null;
  const updates: CandleUpdate[] = [];
  for (const entry of message.data) {
    if (!isObject(entry)) return null;
    const bar = toBar(
      Number(entry.start),
      entry.open,
      entry.high,
      entry.low,
      entry.close,
      entry.volume,
    );
    const eventTime = Number(entry.timestamp ?? message.ts);
    if (!bar || !Number.isSafeInteger(eventTime)) return null;
    updates.push({ bar, eventTime });
  }
  return updates;
}

/** Trades from a `publicTrade.{symbol}` message, oldest first. */
export function parseBybitTrades(message: unknown): Trade[] | null {
  if (!isObject(message) || !Array.isArray(message.data)) return null;
  const trades: Trade[] = [];
  for (const entry of message.data) {
    if (!isObject(entry)) return null;
    const price = decimal(entry.p);
    const quantity = decimal(entry.v);
    const time = Number(entry.T);
    if (!price || quantity === null || !Number.isSafeInteger(time)) return null;
    trades.push({ price, quantity, time });
  }
  return trades.sort((a, b) => a.time - b.time);
}

/**
 * The best bid and ask from an `orderbook.1.{symbol}` message. A snapshot carries both sides;
 * a delta only what changed, and a zero size means the level went away.
 */
export function parseBybitBook(
  message: unknown,
): { snapshot: boolean; bid: number | null | undefined; ask: number | null | undefined } | null {
  if (!isObject(message) || !isObject(message.data)) return null;
  const side = (levels: unknown): number | null | undefined => {
    if (!Array.isArray(levels) || levels.length === 0) return undefined;
    const [best] = levels;
    if (!Array.isArray(best)) return undefined;
    const price = decimal(best[0]);
    const size = decimal(best[1]);
    return price && size ? price : null;
  };
  return {
    snapshot: message.type === 'snapshot',
    bid: side(message.data.b),
    ask: side(message.data.a),
  };
}
