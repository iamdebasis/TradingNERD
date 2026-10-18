import type { Bar } from '@tradingnerd/core';
import type { BookTop, CandleUpdate, Trade } from '../../market/types.ts';

// Binance sends prices and quantities as decimal strings and times as epoch-ms numbers.
// Everything is validated here, so malformed upstream data never reaches the chart.

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function decimal(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function epochMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function toBar(openMs: number | null, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown) {
  const [open, high, low, close, volume] = [
    decimal(o),
    decimal(h),
    decimal(l),
    decimal(c),
    decimal(v),
  ];
  if (openMs === null || open === null || high === null || low === null || close === null)
    return null;
  if (volume === null) return null;
  const bar: Bar = { time: openMs / 1000, open, high, low, close, volume };
  return bar;
}

/** One row of GET /api/v3/klines: [openTime, open, high, low, close, volume, closeTime, …]. */
export function parseKlineRow(row: unknown): Bar | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return toBar(epochMs(row[0]), row[1], row[2], row[3], row[4], row[5]);
}

/** `<symbol>@kline_<interval>` payload. */
export function parseKlineEvent(data: unknown): CandleUpdate | null {
  if (!isObject(data) || data.e !== 'kline' || !isObject(data.k)) return null;
  const eventTime = epochMs(data.E);
  const { t, o, h, l, c, v } = data.k;
  const bar = toBar(epochMs(t), o, h, l, c, v);
  return bar && eventTime !== null ? { bar, eventTime } : null;
}

/** `<symbol>@aggTrade` payload. */
export function parseAggTrade(data: unknown): Trade | null {
  if (!isObject(data) || data.e !== 'aggTrade') return null;
  const price = decimal(data.p);
  const quantity = decimal(data.q);
  const time = epochMs(data.T);
  return price !== null && quantity !== null && time !== null ? { price, quantity, time } : null;
}

/** `<symbol>@bookTicker` payload: best bid `b` and best ask `a`. */
export function parseBookTicker(data: unknown): BookTop | null {
  if (!isObject(data)) return null;
  const bid = decimal(data.b);
  const ask = decimal(data.a);
  return bid !== null && ask !== null ? { bid, ask } : null;
}

export interface BinanceSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
}

/** First entry of GET /api/v3/exchangeInfo?symbol=…; null when the shape is unexpected. */
export function parseExchangeInfo(body: unknown): BinanceSymbol | null {
  if (!isObject(body) || !Array.isArray(body.symbols)) return null;
  const entry: unknown = body.symbols[0];
  if (!isObject(entry) || !Array.isArray(entry.filters)) return null;
  const { symbol, status, baseAsset, quoteAsset } = entry;
  if (
    typeof symbol !== 'string' ||
    typeof status !== 'string' ||
    typeof baseAsset !== 'string' ||
    typeof quoteAsset !== 'string'
  ) {
    return null;
  }
  const priceFilter = entry.filters.find(
    (filter): filter is Json => isObject(filter) && filter.filterType === 'PRICE_FILTER',
  );
  const tickSize = decimal(priceFilter?.tickSize);
  if (tickSize === null || tickSize === 0) return null;
  return { symbol, status, baseAsset, quoteAsset, tickSize };
}

/** Binance's public asset list: asset code → display name ("USDT" → "TetherUS"). */
export function parseAssetNames(body: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!isObject(body) || !Array.isArray(body.data)) return names;
  for (const asset of body.data) {
    if (
      isObject(asset) &&
      typeof asset.assetCode === 'string' &&
      typeof asset.assetName === 'string'
    ) {
      const name = asset.assetName.trim();
      if (name) names.set(asset.assetCode, name);
    }
  }
  return names;
}
