import type { AggTrade, Bar } from '@tradingnerd/core';
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

/** `<symbol>@aggTrade` payload; carries the aggregate and trade ids when present. */
export function parseAggTrade(data: unknown): Trade | null {
  if (!isObject(data) || data.e !== 'aggTrade') return null;
  const price = decimal(data.p);
  const quantity = decimal(data.q);
  const time = epochMs(data.T);
  if (price === null || quantity === null || time === null) return null;
  const trade: Trade = { price, quantity, time };
  const ids = aggIds(data);
  if (ids) Object.assign(trade, ids);
  return trade;
}

/** One row of GET /api/v3/aggTrades: {a, p, q, f, l, T, …}. */
export function parseAggTradeRow(row: unknown): AggTrade | null {
  if (!isObject(row)) return null;
  const price = decimal(row.p);
  const quantity = decimal(row.q);
  const time = epochMs(row.T);
  const ids = aggIds(row);
  if (price === null || quantity === null || time === null || !ids) return null;
  return { ...ids, price, quantity, time };
}

/** One row of GET /api/v3/historicalTrades: {id, price, qty, time, …}; only id and time used. */
export function parseTradeRow(row: unknown): { id: number; time: number } | null {
  if (!isObject(row)) return null;
  const id = epochMs(row.id);
  const time = epochMs(row.time);
  return id !== null && time !== null ? { id, time } : null;
}

/** The aggregate id `a` and its first and last trade ids `f` … `l`. */
function aggIds(data: Json): { id: number; firstId: number; lastId: number } | null {
  const id = epochMs(data.a);
  const firstId = epochMs(data.f);
  const lastId = epochMs(data.l);
  if (id === null || firstId === null || lastId === null || lastId < firstId) return null;
  return { id, firstId, lastId };
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

const LISTED_CODE = /^[A-Z0-9]{1,30}$/;

/**
 * Every spot pair that is trading, from GET /api/v3/exchangeInfo, with its tick size (so a
 * symbol lookup can be answered without asking again); null on an odd shape.
 */
export function parseTradingSymbols(body: unknown): BinanceSymbol[] | null {
  if (!isObject(body) || !Array.isArray(body.symbols)) return null;
  const listings: BinanceSymbol[] = [];
  for (const entry of body.symbols) {
    if (!isObject(entry) || entry.status !== 'TRADING' || entry.isSpotTradingAllowed !== true) {
      continue;
    }
    const { symbol, baseAsset, quoteAsset } = entry;
    if (
      typeof symbol !== 'string' ||
      typeof baseAsset !== 'string' ||
      typeof quoteAsset !== 'string' ||
      !LISTED_CODE.test(symbol) ||
      !LISTED_CODE.test(baseAsset) ||
      !LISTED_CODE.test(quoteAsset) ||
      !Array.isArray(entry.filters)
    ) {
      continue;
    }
    const priceFilter = entry.filters.find(
      (filter): filter is Json => isObject(filter) && filter.filterType === 'PRICE_FILTER',
    );
    const tickSize = decimal(priceFilter?.tickSize);
    if (tickSize === null || tickSize === 0) continue;
    listings.push({ symbol, status: 'TRADING', baseAsset, quoteAsset, tickSize });
  }
  return listings;
}

/** Last price and 24 h quote volume per symbol, from GET /api/v3/ticker/24hr?type=MINI. */
export function parseMiniTickers(
  body: unknown,
): Map<string, { last: number; quoteVolume: number }> | null {
  if (!Array.isArray(body)) return null;
  const stats = new Map<string, { last: number; quoteVolume: number }>();
  for (const row of body) {
    if (!isObject(row) || typeof row.symbol !== 'string') continue;
    stats.set(row.symbol, {
      last: decimal(row.lastPrice) ?? 0,
      quoteVolume: decimal(row.quoteVolume) ?? 0,
    });
  }
  return stats;
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
