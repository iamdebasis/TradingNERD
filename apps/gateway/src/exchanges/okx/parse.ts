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
import type { BookTop, CandleUpdate, Trade } from '../../market/types.ts';
import type { Instrument } from '../shared.ts';

// OKX v5 sends every number as a string; instruments are "XRP-USDT".

function dataList(body: unknown, what: string): unknown[] {
  if (!isObject(body) || body.code !== '0' || !Array.isArray(body.data)) {
    throw unexpected('OKX', what);
  }
  return body.data;
}

const liveInstruments = (body: unknown): Json[] =>
  dataList(body, 'instruments').filter(
    (item): item is Json => isObject(item) && item.state === 'live',
  );

/** Live spot pairs from GET /api/v5/public/instruments, with their tick sizes. */
export function parseOkxInstruments(body: unknown): Instrument[] {
  const instruments: Instrument[] = [];
  for (const item of liveInstruments(body)) {
    const { instId, baseCcy, quoteCcy } = item;
    const tickSize = decimal(item.tickSz);
    const ticker = `${String(baseCcy)}${String(quoteCcy)}`;
    if (typeof instId !== 'string' || !isAsset(baseCcy) || !isAsset(quoteCcy) || !tickSize) {
      continue;
    }
    if (!isTicker(ticker)) continue;
    instruments.push({
      ticker,
      restId: instId,
      streamId: instId,
      base: baseCcy,
      quote: quoteCcy,
      tickSize,
    });
  }
  return instruments;
}

/**
 * Live pairs with 24 h figures from /api/v5/market/tickers, for the search catalog. OKX
 * writes "XRP-USDT"; TradingView's ticker is "XRPUSDT". For spot, `volCcy24h` is in the
 * quote asset.
 */
export function parseOkxPairs(instruments: unknown, tickers: unknown): CatalogPair[] {
  const stats = new Map<string, { last: number; quoteVolume: number }>();
  for (const item of dataList(tickers, 'tickers')) {
    if (isObject(item) && typeof item.instId === 'string') {
      stats.set(item.instId, { last: amount(item.last), quoteVolume: amount(item.volCcy24h) });
    }
  }
  const pairs: CatalogPair[] = [];
  for (const item of liveInstruments(instruments)) {
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

/** One candle row: [ts, open, high, low, close, volume (base), …, confirm]. */
function candle(row: unknown): Bar | null {
  if (!Array.isArray(row)) return null;
  return toBar(Number(row[0]), row[1], row[2], row[3], row[4], row[5]);
}

/** Bars from /market/candles or /market/history-candles, newest first; returned ascending. */
export function parseOkxCandles(body: unknown): Bar[] {
  const bars: Bar[] = [];
  for (const row of dataList(body, 'candles')) {
    const bar = candle(row);
    if (!bar) throw unexpected('OKX', 'candles');
    bars.push(bar);
  }
  return bars.reverse();
}

/**
 * Candle snapshots from a `candle{bar}` push. OKX doesn't say when they were taken, so the
 * time they arrived stands in.
 */
export function parseOkxCandleUpdates(message: unknown, receivedAt: number): CandleUpdate[] | null {
  if (!isObject(message) || !Array.isArray(message.data)) return null;
  const updates: CandleUpdate[] = [];
  for (const row of message.data) {
    const bar = candle(row);
    if (!bar) return null;
    updates.push({ bar, eventTime: receivedAt });
  }
  return updates;
}

/** Trades from a `trades` push, oldest first. */
export function parseOkxTrades(message: unknown): Trade[] | null {
  if (!isObject(message) || !Array.isArray(message.data)) return null;
  const trades: Trade[] = [];
  for (const entry of message.data) {
    if (!isObject(entry)) return null;
    const price = decimal(entry.px);
    const quantity = decimal(entry.sz);
    const time = Number(entry.ts);
    if (!price || quantity === null || !Number.isSafeInteger(time)) return null;
    trades.push({ price, quantity, time });
  }
  return trades.sort((a, b) => a.time - b.time);
}

/** The best bid and ask from a `bbo-tbt` push: [price, size, …] at the top of each side. */
export function parseOkxBbo(message: unknown): BookTop | null {
  if (!isObject(message) || !Array.isArray(message.data) || !isObject(message.data[0])) {
    return null;
  }
  const { bids, asks } = message.data[0];
  const best = (levels: unknown) =>
    Array.isArray(levels) && Array.isArray(levels[0]) ? decimal(levels[0][0]) : null;
  const bid = best(bids);
  const ask = best(asks);
  return bid && ask ? { bid, ask } : null;
}
