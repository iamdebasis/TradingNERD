import { test as base, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import {
  type Bar,
  barOpenTime,
  type CatalogEntry,
  CRYPTOCAP,
  DEFAULT_FLAG_STATE,
  DEFAULT_WATCHLIST,
  type ExchangeSummary,
  evaluateFormula,
  type FlagState,
  isComplete,
  type LogoStatus,
  MarketSchedule,
  type OlderCapsStatus,
  PROTOCOL_VERSION,
  parseFlagState,
  parseFormula,
  parseResolution,
  parseSymbolId,
  parseWatchlist,
  parseWatchlistName,
  replaceSymbols,
  SEARCH_PAGE_SIZE,
  type SearchCategory,
  type SessionHours,
  type StockKeyStatus,
  type SymbolInfo,
  type SymbolKind,
  searchCatalog,
  sessionClock,
  uniqueListName,
  type Watchlist,
  type WatchlistSection,
} from '@tradingnerd/core';
import { NYSE_2026 } from '@tradingnerd/core/testing';

export { expect };

/**
 * Browser tests run against a mock gateway (REST routes plus a routed WebSocket), so they're
 * deterministic and never touch the network. The clock is pinned to 16:09:54 UTC, 7 h 50 min
 * 06 s before the daily close, which is the countdown in docs/reference/01-chart-layout.png.
 */
export const NOW = Date.parse('2026-10-18T16:09:54Z');
export const DAY = 86_400;
/** Open time (UTC seconds) of today's daily bar. */
export const LAST_DAY = Date.UTC(2026, 9, 18) / 1000;

/** The CoinGecko key the mock gateway accepts. */
export const MOCK_KEY = 'CG-demo-key-3f9a';
/** The Live Coin Watch key the mock gateway accepts. */
export const MOCK_LCW_KEY = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
/** A 1×1 PNG, standing in for a coin logo. */
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const XRP_INFO: SymbolInfo = {
  id: 'BINANCE:XRPUSDT',
  exchange: 'BINANCE',
  exchangeName: 'Binance',
  ticker: 'XRPUSDT',
  base: 'XRP',
  quote: 'USDT',
  description: 'XRP / TetherUS',
  type: 'spot',
  tickSize: 0.0001,
  pricePrecision: 4,
  resolutions: ['1', '60', '1D'],
  timezone: 'Etc/UTC',
  delayMs: 0,
  hasBook: true,
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Price decimals of the default watchlist's coins on Binance (others: 4). */
const PRECISION: Record<string, number> = {
  LINK: 3,
  ZAMA: 5,
  DASH: 2,
  POL: 5,
  STRK: 5,
  VET: 6,
  SHIB: 8,
  RUNE: 3,
  PEPE: 8,
  KSM: 2,
};

/** Coins Binance doesn't list: XCH is the reference's unavailable row. */
const UNLISTED = new Set(['XCH']);

/** The exchanges the mock's symbol catalog covers, all with live data as in the gateway. */
export const MOCK_EXCHANGES: ExchangeSummary[] = [
  { id: 'BINANCE', name: 'Binance', live: true },
  { id: 'BYBIT', name: 'Bybit', live: true },
  { id: 'OKX', name: 'OKX', live: true },
  { id: 'COINBASE', name: 'Coinbase', live: true },
  { id: 'KRAKEN', name: 'Kraken', live: true },
  { id: 'BITSTAMP', name: 'Bitstamp', live: true },
];
const EXCHANGE_NAMES = new Map(MOCK_EXCHANGES.map((exchange) => [exchange.id, exchange.name]));

const listing = (
  exchange: string,
  ticker: string,
  base: string,
  quote: string,
  description: string,
  volumeUsd: number,
): CatalogEntry => ({
  exchange,
  ticker,
  base,
  quote,
  description,
  volumeUsd,
  live: true,
  kind: 'spot',
});

/**
 * What the mock's symbol search searches (with the gateway's own ranking): XRP across the five
 * exchanges as on 2026-10-19, the default watchlist's coins on Binance, and 60 quiet pairs so
 * an empty search has a second page.
 */
export const MOCK_CATALOG: CatalogEntry[] = [
  listing('BINANCE', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 150e6),
  listing('OKX', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 22e6),
  listing('BYBIT', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 20e6),
  listing('KRAKEN', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 1e6),
  listing('COINBASE', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 0.2e6),
  listing('COINBASE', 'XRPUSD', 'XRP', 'USD', 'XRP / US Dollar', 66e6),
  listing('KRAKEN', 'XRPUSD', 'XRP', 'USD', 'XRP / US Dollar', 22e6),
  listing('BINANCE', 'XRPUSDC', 'XRP', 'USDC', 'XRP / USDC', 30e6),
  listing('BYBIT', 'XRPUSDC', 'XRP', 'USDC', 'XRP / USDC', 2e6),
  listing('BINANCE', 'XRPEUR', 'XRP', 'EUR', 'XRP / Euro', 5e6),
  listing('COINBASE', 'XRPEUR', 'XRP', 'EUR', 'XRP / Euro', 0.8e6),
  listing('BINANCE', 'XRPTRY', 'XRP', 'TRY', 'XRP / Turkish Lira', 3.2e6),
  listing('BINANCE', 'XRPBTC', 'XRP', 'BTC', 'XRP / Bitcoin', 3e6),
  listing('BINANCE', 'XRPU', 'XRP', 'U', 'XRP / United Stables', 0.5e6),
  listing('BINANCE', 'BTCUSDT', 'BTC', 'USDT', 'Bitcoin / TetherUS', 900e6),
  listing('KRAKEN', 'XBTUSD', 'BTC', 'USD', 'Bitcoin / US Dollar', 117e6),
  // Bitstamp, with its volumes of 2026-10-25: its XRPBTC trades only about $30,000 a day.
  listing('BITSTAMP', 'XRPUSD', 'XRP', 'USD', 'XRP / US Dollar', 12e6),
  listing('BITSTAMP', 'XRPBTC', 'XRP', 'BTC', 'XRP / Bitcoin', 0.03e6),
  listing('BITSTAMP', 'BTCUSD', 'BTC', 'USD', 'Bitcoin / US Dollar', 110e6),
  listing('OKX', 'XCHUSDT', 'XCH', 'USDT', 'Chia / TetherUS', 1e6),
  ...(DEFAULT_WATCHLIST.sections[0]?.symbols ?? [])
    .filter((symbol) => symbol !== XRP_INFO.id)
    .map((symbol, i) => {
      const base = symbol.slice('BINANCE:'.length, -'USDT'.length);
      return listing('BINANCE', `${base}USDT`, base, 'USDT', `${base} / TetherUS`, 50e6 - i * 1e6);
    }),
  ...Array.from({ length: 60 }, (_, i) =>
    listing('BINANCE', `QQ${i}USDT`, `QQ${i}`, 'USDT', `Quiet ${i} / TetherUS`, 1_000 - i),
  ),
];

/**
 * CRYPTOCAP's symbols in the mock, with the values of the user's screenshots 20–22: TOTAL
 * 2.65T (−36.71B), TOTAL2 1,041,724,313,303 (−18.03B, −1.70%), BTC.D 60.73 (0.13, 0.21%).
 */
export const CAP_QUOTES: Record<string, { last: number; prevClose: number }> = {
  'CRYPTOCAP:TOTAL': { last: 2.6529e12, prevClose: 2.6529e12 + 36.71e9 },
  'CRYPTOCAP:TOTAL2': { last: 1_041_724_313_303, prevClose: 1_041_724_313_303 + 18.03e9 },
  'CRYPTOCAP:BTC.D': { last: 60.734, prevClose: 60.604 },
};

const capEntry = (ticker: string, base: string, description: string): CatalogEntry => ({
  exchange: 'CRYPTOCAP',
  ticker,
  base,
  quote: ticker.endsWith('.D') ? '%' : 'USD',
  description,
  volumeUsd: 0,
  live: true,
  kind: 'index',
});

/** CRYPTOCAP in the mock's symbol search. */
export const MOCK_CRYPTOCAP: CatalogEntry[] = [
  capEntry('TOTAL', 'CRYPTOCAP', 'Crypto Total Market Cap, $'),
  capEntry('TOTAL2', 'CRYPTOCAP', 'Crypto Total Market Cap Excluding BTC, $'),
  capEntry('TOTAL3', 'CRYPTOCAP', 'Crypto Total Market Cap Excluding BTC and ETH, $'),
  capEntry('OTHERS', 'CRYPTOCAP', 'Crypto Total Market Cap Excluding Top 10, $'),
  capEntry('BTC.D', 'BTC', 'Market Cap BTC Dominance, %'),
  capEntry('USDT', 'USDT', 'Market Cap USDT, $'),
  capEntry('USDC', 'USDC', 'Market Cap USDC, $'),
];

/** SymbolInfo for a CRYPTOCAP symbol the mock knows. */
export function capInfoFor(symbol: string): SymbolInfo | null {
  const listed = MOCK_CRYPTOCAP.find((entry) => `CRYPTOCAP:${entry.ticker}` === symbol);
  if (!listed) return null;
  const cap = listed.quote === 'USD';
  return {
    id: symbol,
    exchange: 'CRYPTOCAP',
    exchangeName: 'CRYPTOCAP',
    ticker: listed.ticker,
    base: listed.base,
    quote: listed.quote,
    description: listed.description,
    type: 'index',
    tickSize: cap ? 1 : 0.01,
    pricePrecision: cap ? 0 : 2,
    format: cap ? 'volume' : 'price',
    resolutions: ['1', '5', '15', '30', '60', '240', '1D'],
    timezone: 'Etc/UTC',
    delayMs: 0,
    hasBook: true,
  };
}

/**
 * How much a CRYPTOCAP symbol's bars are the mock's usual ones scaled up: so the latest daily
 * close is its value (1.2955 becomes TOTAL2's 1.04T). 1 for everything else.
 */
export function capScale(symbol: string): number {
  const quote = CAP_QUOTES[symbol];
  return quote ? quote.last / 1.2955 : 1;
}

const scaled = (bar: Bar, factor: number): Bar =>
  factor === 1
    ? bar
    : {
        ...bar,
        open: bar.open * factor,
        high: bar.high * factor,
        low: bar.low * factor,
        close: bar.close * factor,
      };

/**
 * A formula of the mock's symbols, described as the gateway's FormulaExchange describes one: its
 * tickers for a name, its first symbol's exchange and decimals. Null if it isn't a formula or
 * the mock lacks one of its symbols.
 */
export function formulaInfoFor(symbol: string): SymbolInfo | null {
  const formula = parseFormula(symbol);
  if (!formula || !isComplete(formula)) return null;
  const parts = formula.symbols.map((part) => infoFor(part));
  const first = parts[0];
  if (!first || parts.some((part) => part === null)) return null;
  return {
    ...first,
    id: formula.text,
    ticker: formula.name,
    base: '',
    description: formula.name,
    type: 'spread',
    hasBook: true,
  };
}

/**
 * Why the mock can't show a formula, as the gateway words it: the symbol it lacks and, next to
 * market caps, CRYPTOCAP's coin in its place. Null for a formula it can show, or none.
 */
export function formulaFailure(symbol: string): { message: string; suggestion?: string } | null {
  const formula = parseFormula(symbol);
  const missing = formula?.symbols.find((part) => infoFor(part) === null);
  if (!formula || !isComplete(formula) || !missing) return null;
  const ticker = parseSymbolId(missing)?.ticker ?? missing;
  const instead = `${CRYPTOCAP}:${ticker}`;
  const caps = formula.symbols.some((part) => part !== missing && part.startsWith(`${CRYPTOCAP}:`));
  if (!caps || missing.startsWith(`${CRYPTOCAP}:`) || !capInfoFor(instead)) {
    return { message: `${missing} isn't available here` };
  }
  return {
    message: `${missing} isn't available here; for ${ticker}'s market cap, use ${instead}`,
    suggestion: replaceSymbols(formula, (part) => (part === missing ? instead : part)).text,
  };
}

/**
 * A formula's bars from its symbols': in the mock they all move as the one series, each scaled
 * as its own is (capScale), so the formula's bar is worked out bar by bar. Null for no formula.
 */
export function formulaBars(symbol: string, bars: readonly Bar[]): Bar[] | null {
  const formula = parseFormula(symbol);
  if (!formula) return null;
  return bars.map((bar) => {
    const at = (field: 'open' | 'high' | 'low' | 'close') =>
      evaluateFormula(formula.root, (part) => bar[field] * capScale(part));
    const values = [at('open'), at('high'), at('low'), at('close')];
    return {
      ...bar,
      open: values[0] as number,
      high: Math.max(...values),
      low: Math.min(...values),
      close: values[3] as number,
    };
  });
}

/**
 * Bitstamp's pairs as its symbol lookups describe them, with its own decimals; its search rows
 * use the names every exchange shares.
 */
const BITSTAMP_INFO: Record<string, { description: string; pricePrecision: number }> = {
  'BITSTAMP:XRPUSD': { description: 'XRP / U.S. dollar', pricePrecision: 5 },
  'BITSTAMP:XRPBTC': { description: 'XRP / Bitcoin', pricePrecision: 8 },
  'BITSTAMP:BTCUSD': { description: 'Bitcoin / U.S. dollar', pricePrecision: 2 },
};

/** SymbolInfo for any pair in the mock catalog, or any BINANCE:…USDT but the unlisted. */
export function infoFor(symbol: string): SymbolInfo | null {
  if (symbol === XRP_INFO.id) return XRP_INFO;
  const cap = capInfoFor(symbol);
  if (cap) return cap;
  if (parseFormula(symbol)) return formulaInfoFor(symbol);
  const listed = MOCK_CATALOG.find((entry) => `${entry.exchange}:${entry.ticker}` === symbol);
  const match = /^BINANCE:([A-Z0-9]+)USDT$/.exec(symbol);
  const base = listed?.base ?? match?.[1];
  const quote = listed?.quote ?? 'USDT';
  if (!base || UNLISTED.has(base)) return null;
  const exchange = listed?.exchange ?? 'BINANCE';
  const own = BITSTAMP_INFO[symbol];
  const pricePrecision = own?.pricePrecision ?? PRECISION[base] ?? 4;
  return {
    ...XRP_INFO,
    id: symbol,
    exchange,
    exchangeName: EXCHANGE_NAMES.get(exchange) ?? exchange,
    ticker: listed?.ticker ?? `${base}${quote}`,
    base,
    quote,
    description: own?.description ?? listed?.description ?? `${base} / TetherUS`,
    tickSize: 10 ** -pricePrecision,
    pricePrecision,
  };
}

/**
 * A watchlist quote for any symbol: LINK matches the reference's row (11.947, −0.403, −3.26%);
 * the rest are made up from the symbol's name.
 */
export function quoteFor(symbol: string): { last: number; prevClose: number } {
  const cap = CAP_QUOTES[symbol];
  if (cap) return cap;
  // A formula's, from its symbols' quotes.
  const formula = parseFormula(symbol);
  if (formula) {
    return {
      last: evaluateFormula(formula.root, (part) => quoteFor(part).last),
      prevClose: evaluateFormula(formula.root, (part) => quoteFor(part).prevClose),
    };
  }
  if (symbol === 'BINANCE:LINKUSDT') return { last: 11.947, prevClose: 12.35 };
  if (symbol === 'BINANCE:VETUSDT') return { last: 0.006731, prevClose: 0.006979 };
  // Bitstamp's, as its quotes read on 2026-10-25.
  if (symbol === 'BITSTAMP:XRPUSD') return { last: 1.29475, prevClose: 1.29786 };
  if (symbol === 'BITSTAMP:BTCUSD') return { last: 80344.53, prevClose: 80771.95 };
  if (symbol === XRP_INFO.id) return { last: 1.2955, prevClose: 1.3115 };
  const seed = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const last = 0.5 + (seed % 97) / 10;
  return { last, prevClose: last * (1 + ((seed % 7) - 3) / 100) };
}

/** Seeded PRNG, so every run draws the same chart. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * `count` daily bars ending today: a random walk around 1.0–1.6 whose final bar matches the
 * reference screenshot's last candle (O 1.3115 H 1.3126 L 1.2902 C 1.2955, a red bar).
 */
export function makeBars(count = 2_500): Bar[] {
  const random = mulberry32(42);
  const bars: Bar[] = [];
  let close = 1.25;
  for (let i = 0; i < count - 1; i++) {
    const open = close;
    close = Math.min(1.6, Math.max(0.95, open * (1 + (random() - 0.5) * 0.06)));
    const high = Math.max(open, close) * (1 + random() * 0.02);
    const low = Math.min(open, close) * (1 - random() * 0.02);
    bars.push({
      time: LAST_DAY - (count - 1 - i) * DAY,
      open: round4(open),
      high: round4(high),
      low: round4(low),
      close: round4(close),
      volume: Math.round(1e7 + random() * 1e7),
    });
  }
  const previous = bars.at(-1);
  if (previous) previous.close = 1.3115;
  bars.push({
    time: LAST_DAY,
    open: 1.3115,
    high: 1.3126,
    low: 1.2902,
    close: 1.2955,
    volume: 2e7,
  });
  return bars;
}

/**
 * `count` bars of any time-based interval ending with the bar that is live at NOW, on the
 * interval's real boundaries: a random walk around 1.3.
 */
export function makeIntervalBars(resolution: string, count = 1_500): Bar[] {
  const parsed = parseResolution(resolution);
  if (!parsed || parsed.unit === 'tick') throw new Error(`No mock bars for ${resolution}`);
  const times: number[] = [];
  for (let t = barOpenTime(parsed, NOW); times.length < count; t = barOpenTime(parsed, t - 1)) {
    times.unshift(t / 1000);
  }
  const random = mulberry32(7);
  let close = 1.3;
  return times.map((time) => {
    const open = close;
    close = round4(Math.min(1.6, Math.max(1, open * (1 + (random() - 0.5) * 0.01))));
    return {
      time,
      open,
      high: round4(Math.max(open, close) * (1 + random() * 0.003)),
      low: round4(Math.min(open, close) * (1 - random() * 0.003)),
      close,
      volume: 1_000,
    };
  });
}

// ---- US stocks (M7): a few real listings, bars on the NYSE's sessions, Alpaca's key ----

/** A weekday in the session for stock tests: Monday 2026-10-19, 11:00:05 New York. */
export const STOCK_NOW = Date.parse('2026-10-19T15:00:05Z');
/** The free plan's delay. */
export const STOCK_DELAY_MS = 15 * 60_000;
export const NYSE = new MarketSchedule(NYSE_2026);
export const STOCK_CLOCK = sessionClock(NYSE);
export const STOCK_EXTENDED_CLOCK = sessionClock(NYSE, 'extended');
/** 08:30:05 New York on Monday 2026-10-19: pre-market. */
export const PRE_MARKET_NOW = Date.parse('2026-10-19T12:30:05Z');

export const MOCK_STOCK_EXCHANGES: ExchangeSummary[] = [
  { id: 'NASDAQ', name: 'NASDAQ', live: true, market: 'stocks' },
  { id: 'NYSE', name: 'NYSE', live: true, market: 'stocks' },
  { id: 'AMEX', name: 'NYSE Arca & NYSE American', live: true, market: 'stocks' },
  { id: 'CBOE', name: 'Cboe BZX', live: true, market: 'stocks' },
];

const stock = (
  exchange: string,
  ticker: string,
  description: string,
  kind: SymbolKind,
  volumeUsd: number,
  exchangeName: string,
  live = true,
): CatalogEntry => ({
  exchange,
  ticker,
  base: ticker.split(/[./]/)[0] ?? ticker,
  quote: 'USD',
  description,
  volumeUsd,
  live,
  kind,
  exchangeName,
});

/** US listings as the gateway's directory would give them (19 October 2026). */
export const MOCK_STOCKS: CatalogEntry[] = [
  stock('NASDAQ', 'AAPL', 'Apple Inc.', 'stock', 12e9, 'NASDAQ'),
  stock('AMEX', 'SPY', 'State Street SPDR S&P 500 ETF Trust', 'etf', 30e9, 'NYSE Arca'),
  stock('AMEX', 'GBTC', 'Grayscale Bitcoin Trust (BTC)', 'etf', 400e6, 'NYSE Arca'),
  stock('AMEX', 'XXRP', 'Teucrium 2x Long Daily XRP ETF', 'etf', 30e6, 'NYSE Arca'),
  stock('CBOE', 'FBTC', 'Fidelity Wise Origin Bitcoin Fund', 'etf', 900e6, 'Cboe BZX'),
  stock('NYSE', 'BRK.B', 'Berkshire Hathaway Inc.', 'stock', 1.5e9, 'NYSE'),
  stock(
    'NYSE',
    'JPM/PD',
    'J P Morgan Chase & Co Depositary Shares, Series DD',
    'preferred',
    5e6,
    'NYSE',
    false,
  ),
];

/** SymbolInfo for a mock US listing with data, or null. */
export function stockInfoFor(symbol: string): SymbolInfo | null {
  const entry = MOCK_STOCKS.find((item) => `${item.exchange}:${item.ticker}` === symbol);
  if (!entry?.live) return null;
  return {
    id: symbol,
    exchange: entry.exchange,
    exchangeName: entry.exchangeName ?? entry.exchange,
    ticker: entry.ticker,
    base: entry.base,
    quote: 'USD',
    description: entry.description,
    type: entry.kind,
    tickSize: 0.01,
    pricePrecision: 2,
    resolutions: ['1', '5', '15', '30', '1D'],
    timezone: 'America/New_York',
    delayMs: STOCK_DELAY_MS,
    hasBook: true,
    schedule: NYSE_2026,
  };
}

/**
 * `count` bars of a stock on the NYSE's sessions (intraday ones with pre- and post-market for
 * the extended session), ending with the bar 15 minutes before `now`: a walk around 230.
 */
export function makeStockBars(
  resolution: string,
  count = 1_500,
  session: SessionHours = 'regular',
  now = STOCK_NOW,
): Bar[] {
  const parsed = parseResolution(resolution);
  if (!parsed || parsed.unit === 'tick' || parsed.unit === 'second') {
    throw new Error(`No mock stock bars for ${resolution}`);
  }
  const clock = session === 'extended' ? STOCK_EXTENDED_CLOCK : STOCK_CLOCK;
  const times: number[] = [];
  let open = clock.open(parsed, now - STOCK_DELAY_MS);
  while (times.length < count && open > Date.UTC(2026, 0, 2)) {
    times.unshift(open / 1000);
    open = clock.open(parsed, open - 1);
  }
  const random = mulberry32(11);
  // Extended hours a little higher, so a pre/post-market price differs from the close.
  let close = session === 'extended' ? 230.5 : 230;
  return times.map((time) => {
    const start = close;
    close = Math.round(start * (1 + (random() - 0.5) * 0.004) * 100) / 100;
    return {
      time,
      open: start,
      high: Math.round(Math.max(start, close) * (1 + random() * 0.002) * 100) / 100,
      low: Math.round(Math.min(start, close) * (1 - random() * 0.002) * 100) / 100,
      close,
      volume: 100_000,
    };
  });
}

/** The number of the first mock tick bar (tick bars are numbered by trade, see Bar.time). */
export const FIRST_TICK_BAR = 17_369_000;

/** `count` tick bars, numbered from FIRST_TICK_BAR, their first trades 0.6 s apart up to NOW. */
export function makeTickBars(count = 1_500): Bar[] {
  const random = mulberry32(11);
  let close = 1.3;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    close = round4(Math.min(1.6, Math.max(1, open * (1 + (random() - 0.5) * 0.002))));
    return {
      time: FIRST_TICK_BAR + i,
      open,
      high: round4(Math.max(open, close) * 1.0005),
      low: round4(Math.min(open, close) * 0.9995),
      close,
      volume: 100,
      start: NOW - (count - 1 - i) * 600,
    };
  });
}

export interface MockMarket {
  /** Daily history served by GET /api/bars (other intervals get makeIntervalBars). */
  bars: Bar[];
  /** The open list's sections (the one list, unless a test adds more). */
  watchlist: Watchlist;
  /** Every list the page saved, in order. */
  readonly watchlistSaves: Watchlist[];
  /** Every list, the first "Watchlist"; `activeId` is the open one. */
  lists: MockList[];
  activeId: string;
  /** The flags GET /api/flags serves; PUTs replace them. */
  flags: FlagState;
  /** Every flag state the page saved, in order. */
  readonly flagSaves: FlagState[];
  /** While true, watchlist loads fail as if the gateway were unreachable. */
  failWatchlistLoads(failing: boolean): void;
  /** How many watchlist loads were refused. */
  refusedWatchlistLoads(): number;
  /** Sends a quote for a symbol the page has subscribed to. */
  sendQuote(symbol: string, last: number, prevClose: number | null): Promise<void>;
  /** Quote subscription ids by symbol, for streaming quotes in bulk. */
  quoteIds(): Map<string, string>;
  /** Sends a quote on a known subscription id, without waiting. */
  sendQuoteNow(id: string, last: number, prevClose: number | null): void;
  /** What GET /api/logos/status answers; by default the first-launch prompt was skipped. */
  logoStatus: LogoStatus;
  /** Every body the page sent to PUT /api/logos/key. */
  readonly savedKeys: string[];
  /** Query of every symbol search, in order. */
  readonly searchRequests: URLSearchParams[];
  /** Exchanges the mock says have live data (all five, unless a test takes one away). */
  readonly liveExchanges: Set<string>;
  /** What GET /api/stocks/key answers; by default a free-plan key is set. */
  stockKey: StockKeyStatus;
  /** When the stocks' history ends, 15 minutes before it (STOCK_NOW unless a test moves it). */
  stockNow: number;
  /** Every key the page sent to PUT /api/stocks/key. */
  readonly savedStockKeys: { keyId: string; secret: string }[];
  /** What GET /api/older-caps answers; by default no key and nothing downloaded. */
  olderCaps: OlderCapsStatus;
  /** Every key the page sent to PUT /api/older-caps/key. */
  readonly savedLcwKeys: string[];
  /** Every bars subscription the page has made: [id, resolution], in order. */
  readonly barSubscriptions: [string, string][];
  /** Ids of subscriptions the page still holds. */
  activeSubscriptions(): string[];
  /** Query of every /api/bars request, in order. */
  readonly barRequests: URLSearchParams[];
  /** How many WebSocket connections the page has opened. */
  connections(): number;
  /** Resolves with the id once the page has subscribed to a channel. */
  subscribed(channel: 'bars' | 'book'): Promise<string>;
  sendBar(bar: Bar, historical?: boolean): Promise<void>;
  sendBook(bid: number, ask: number): Promise<void>;
  /** Reports the chart's bars subscription as reconnecting or live, as during an exchange outage. */
  sendBarsState(state: 'live' | 'reconnecting'): Promise<void>;
  /** Drops the page's WebSocket, like a gateway restart. */
  drop(): Promise<void>;
}

export interface MockList {
  id: string;
  name: string;
  favorite: boolean;
  sections: WatchlistSection[];
}

const summaryOf = (list: MockList) => ({
  id: list.id,
  name: list.name,
  favorite: list.favorite,
  count: list.sections.reduce((sum, section) => sum + section.symbols.length, 0),
});

class MockGateway implements MockMarket {
  bars: Bar[] = makeBars();
  lists: MockList[] = [
    {
      id: 'watchlist',
      name: 'Watchlist',
      favorite: false,
      sections: structuredClone(DEFAULT_WATCHLIST.sections),
    },
  ];
  activeId = 'watchlist';
  private nextList = 1;

  get watchlist(): Watchlist {
    return { sections: this.openList().sections };
  }

  set watchlist(value: Watchlist) {
    this.openList().sections = structuredClone(value.sections);
  }

  private openList(): MockList {
    const list = this.lists.find((item) => item.id === this.activeId) ?? this.lists[0];
    if (!list) throw new Error('The mock has no lists');
    return list;
  }

  private index() {
    return { activeId: this.activeId, lists: this.lists.map(summaryOf) };
  }
  logoStatus: LogoStatus = {
    key: null,
    promptDismissed: true,
    syncedAt: null,
    syncing: false,
    syncError: null,
  };
  readonly savedKeys: string[] = [];
  stockKey: StockKeyStatus = {
    configured: true,
    source: 'file',
    keyId: '••••6789',
    sip: 'delayed',
  };
  readonly savedStockKeys: { keyId: string; secret: string }[] = [];
  olderCaps: OlderCapsStatus = {
    key: null,
    state: 'none',
    progress: 0,
    from: null,
    until: null,
    message: null,
    coins: { state: 'none', progress: 0, message: null },
  };
  readonly savedLcwKeys: string[] = [];
  stockNow = STOCK_NOW;
  readonly searchRequests: URLSearchParams[] = [];
  readonly liveExchanges = new Set(MOCK_EXCHANGES.map((exchange) => exchange.id));
  readonly watchlistSaves: Watchlist[] = [];
  flags: FlagState = structuredClone(DEFAULT_FLAG_STATE);
  readonly flagSaves: FlagState[] = [];
  readonly barRequests: URLSearchParams[] = [];
  readonly barSubscriptions: [string, string][] = [];
  private readonly page: Page;
  private socket: WebSocketRoute | null = null;
  private openCount = 0;
  private failingLoads = false;
  private refusedLoads = 0;
  private readonly subscriptions = new Map<string, { channel: string; symbol: string }>();
  private readonly series = new Map<string, Bar[]>();
  private readonly stockSeries = new Map<string, Bar[]>();

  constructor(page: Page) {
    this.page = page;
  }

  async install(pinClock: boolean): Promise<void> {
    if (pinClock) await this.page.clock.setFixedTime(NOW);
    await this.page.route(/\/api\/symbols\/resolve\?/, (route) => {
      const symbol = new URL(route.request().url()).searchParams.get('symbol') ?? '';
      if (stockInfoFor(symbol) && !this.stockKey.configured) {
        return route.fulfill({
          status: 424,
          json: { error: 'needs_key', message: 'US stock data needs your Alpaca key' },
        });
      }
      const info = infoFor(symbol) ?? stockInfoFor(symbol);
      const failure = formulaFailure(symbol);
      if (failure) {
        return route.fulfill({ status: 404, json: { error: 'unknown_symbol', ...failure } });
      }
      return info
        ? route.fulfill({ json: info })
        : route.fulfill({
            status: 404,
            json: { error: 'unknown_symbol', message: 'Binance does not list this symbol' },
          });
    });
    await this.page.route(/\/api\/logos\//, (route) => this.logos(route));
    await this.page.route(/\/api\/symbols\/search\?/, (route) => {
      const params = new URL(route.request().url()).searchParams;
      this.searchRequests.push(params);
      return route.fulfill({
        json: searchCatalog(
          [
            ...MOCK_CATALOG.map((entry) => ({
              ...entry,
              live: this.liveExchanges.has(entry.exchange),
            })),
            ...MOCK_STOCKS,
            ...MOCK_CRYPTOCAP,
          ],
          {
            query: params.get('query') ?? '',
            exchange: params.get('exchange'),
            category: params.get('category') as SearchCategory | null,
            offset: Number(params.get('offset') ?? 0),
            limit: Number(params.get('limit') ?? SEARCH_PAGE_SIZE),
          },
        ),
      });
    });
    await this.page.route(/\/api\/exchanges$/, (route) =>
      route.fulfill({
        json: {
          exchanges: [
            ...MOCK_EXCHANGES.map((exchange) => ({
              ...exchange,
              live: this.liveExchanges.has(exchange.id),
              market: 'crypto' as const,
            })),
            ...MOCK_STOCK_EXCHANGES,
            { id: 'CRYPTOCAP', name: 'CRYPTOCAP', live: true, market: 'crypto' as const },
          ],
        },
      }),
    );
    await this.page.route(/\/api\/flags$/, (route) => {
      if (route.request().method() === 'PUT') {
        const saved = parseFlagState(route.request().postDataJSON());
        if (!saved)
          return route.fulfill({ status: 400, json: { error: 'bad_request', message: 'x' } });
        this.flags = saved;
        this.flagSaves.push(saved);
        return route.fulfill({ json: saved });
      }
      return route.fulfill({ json: this.flags });
    });
    // The user's lists, as the gateway keeps them (apps/gateway/src/routes/watchlist.ts).
    await this.page.route(/\/api\/watchlists(\/[^?]*)?$/, (route) => {
      const request = route.request();
      const method = request.method();
      const [, id, action] = new URL(request.url()).pathname.split('/').slice(2);
      const bad = (message = 'x') =>
        route.fulfill({ status: 400, json: { error: 'bad_request', message } });
      const missing = () =>
        route.fulfill({ status: 404, json: { error: 'not_found', message: 'no such list' } });
      if (method === 'GET' && this.failingLoads) {
        this.refusedLoads++;
        return route.abort('connectionrefused');
      }
      if (!id) {
        if (method === 'GET') return route.fulfill({ json: this.index() });
        // POST: a new list, a copy, or an upload's
        const body = request.postDataJSON() as Record<string, unknown>;
        const name = parseWatchlistName(body.name);
        if (!name) return bad('A watchlist needs a name');
        const source =
          typeof body.copyOf === 'string' ? this.lists.find((l) => l.id === body.copyOf) : null;
        if (body.copyOf !== undefined && !source) return missing();
        const sections =
          body.sections === undefined ? [] : parseWatchlist({ sections: body.sections })?.sections;
        if (!sections) return bad();
        const list: MockList = {
          id: `l-${this.nextList++}`,
          name: uniqueListName(
            name,
            this.lists.map((l) => l.name),
          ),
          favorite: false,
          sections: source ? structuredClone(source.sections) : sections,
        };
        this.lists.push(list);
        if (body.activate !== false) this.activeId = list.id;
        return route.fulfill({ json: summaryOf(list) });
      }
      const list = this.lists.find((item) => item.id === id);
      if (!list) return missing();
      if (action === 'activate') {
        this.activeId = list.id;
        return route.fulfill({ json: this.index() });
      }
      if (method === 'GET') return route.fulfill({ json: list });
      if (method === 'PUT') {
        const saved = parseWatchlist(request.postDataJSON());
        if (!saved) return bad();
        list.sections = saved.sections;
        this.watchlistSaves.push(saved);
        return route.fulfill({ json: list });
      }
      if (method === 'PATCH') {
        const body = request.postDataJSON() as { name?: unknown; favorite?: unknown };
        if (body.name !== undefined) {
          const name = parseWatchlistName(body.name);
          if (!name) return bad();
          list.name = name;
        }
        if (typeof body.favorite === 'boolean') list.favorite = body.favorite;
        return route.fulfill({ json: summaryOf(list) });
      }
      if (method === 'DELETE') {
        if (this.lists.length === 1) return bad("The last watchlist can't be deleted");
        this.lists = this.lists.filter((item) => item !== list);
        // As the gateway: the open list hands over to the first one left.
        if (this.activeId === list.id) this.activeId = this.lists[0]?.id ?? '';
        return route.fulfill({ json: this.index() });
      }
      return bad();
    });
    await this.page.route(/\/api\/bars\?/, (route) => {
      const params = new URL(route.request().url()).searchParams;
      this.barRequests.push(params);
      const to = params.get('to');
      const countBack = Number(params.get('countBack') ?? 300);
      const symbol = params.get('symbol') ?? '';
      const resolution = params.get('resolution') ?? '1D';
      const session = params.get('session') === 'extended' ? 'extended' : 'regular';
      const factor = capScale(symbol);
      const bars = stockInfoFor(symbol)
        ? this.stockBarsFor(resolution, session)
        : (formulaBars(symbol, this.barsFor(resolution)) ??
          this.barsFor(resolution).map((bar) => scaled(bar, factor)));
      const eligible = bars.filter((bar) => to === null || bar.time < Number(to));
      const hasMore = eligible.length > countBack;
      // The fake's bars are each pair's whole history, as Binance's are: it vouches for them.
      return route.fulfill({
        json: { bars: eligible.slice(-countBack), hasMore, fromListing: !hasMore },
      });
    });
    await this.page.route(/\/api\/stocks\/key$/, (route) => {
      const request = route.request();
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { keyId?: unknown; secret?: unknown };
        const key = { keyId: String(body.keyId ?? ''), secret: String(body.secret ?? '') };
        this.savedStockKeys.push(key);
        if (!key.keyId.startsWith('PK') || key.secret.length < 8) {
          return route.fulfill({
            status: 424,
            json: {
              error: 'needs_key',
              message: "Alpaca didn't accept the key; check it and enter it again",
            },
          });
        }
        this.stockKey = {
          configured: true,
          source: 'file',
          keyId: `••••${key.keyId.slice(-4)}`,
          sip: 'delayed',
        };
      } else if (request.method() === 'DELETE') {
        this.stockKey = { configured: false, source: null, keyId: null, sip: null };
      }
      return route.fulfill({ json: this.stockKey });
    });
    await this.page.route(/\/api\/older-caps(\/key)?$/, (route) => {
      const request = route.request();
      const isKey = new URL(request.url()).pathname.endsWith('/key');
      if (isKey && request.method() === 'PUT') {
        const key = String((request.postDataJSON() as { key?: unknown }).key ?? '');
        this.savedLcwKeys.push(key);
        if (key.trim() !== MOCK_LCW_KEY) {
          return route.fulfill({
            status: 400,
            json: { error: 'bad_request', message: 'Live Coin Watch rejected this key' },
          });
        }
        this.olderCaps = {
          ...this.olderCaps,
          key: { masked: `••••${MOCK_LCW_KEY.slice(-4)}`, source: 'file' },
          state: this.olderCaps.state === 'done' ? 'done' : 'loading',
          message: null,
        };
      } else if (isKey && request.method() === 'DELETE') {
        this.olderCaps = {
          ...this.olderCaps,
          key: null,
          state: this.olderCaps.state === 'done' ? 'done' : 'none',
        };
      }
      return route.fulfill({ json: this.olderCaps });
    });
    await this.page.routeWebSocket(/\/ws$/, (socket) => this.accept(socket));
  }

  /** The history this mock serves a stock for an interval and session. */
  stockBarsFor(resolution: string, session: SessionHours = 'regular'): Bar[] {
    const key = `${resolution}|${session}|${this.stockNow}`;
    let bars = this.stockSeries.get(key);
    if (!bars) {
      bars = makeStockBars(resolution, 1_500, session, this.stockNow);
      this.stockSeries.set(key, bars);
    }
    return bars;
  }

  /** The history this mock serves for an interval. */
  barsFor(resolution: string): Bar[] {
    if (resolution === '1D') return this.bars;
    let bars = this.series.get(resolution);
    if (!bars) {
      bars = resolution.endsWith('T') ? makeTickBars() : makeIntervalBars(resolution);
      this.series.set(resolution, bars);
    }
    return bars;
  }

  activeSubscriptions(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** The gateway's logo routes: MOCK_KEY works; XRP and LINK have logos once synced. */
  private logos(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/logos/exchange/')) {
      return this.logoStatus.syncedAt
        ? route.fulfill({ body: LOGO_PNG, contentType: 'image/png' })
        : route.fulfill({ status: 204 });
    }
    if (path.startsWith('/api/logos/coin/')) {
      const base = path.split('/').at(-1);
      return this.logoStatus.syncedAt && (base === 'XRP' || base === 'LINK')
        ? route.fulfill({ body: LOGO_PNG, contentType: 'image/png' })
        : route.fulfill({ status: 204 });
    }
    if (path === '/api/logos/key' && request.method() === 'PUT') {
      const key = String((request.postDataJSON() as { key?: unknown }).key ?? '');
      this.savedKeys.push(key);
      if (key.trim() !== MOCK_KEY) {
        return route.fulfill({
          status: 400,
          json: { error: 'bad_request', message: 'CoinGecko rejected this key' },
        });
      }
      this.logoStatus = {
        ...this.logoStatus,
        key: { masked: '••••3f9a', plan: 'demo', source: 'file' },
        syncedAt: NOW,
      };
    } else if (path === '/api/logos/key' && request.method() === 'DELETE') {
      this.logoStatus = { ...this.logoStatus, key: null };
    } else if (path === '/api/logos/prompt-dismissed') {
      this.logoStatus = { ...this.logoStatus, promptDismissed: true };
    }
    return route.fulfill({ json: this.logoStatus });
  }

  quoteIds(): Map<string, string> {
    const ids = new Map<string, string>();
    for (const [id, sub] of this.subscriptions)
      if (sub.channel === 'quotes') ids.set(sub.symbol, id);
    return ids;
  }

  sendQuoteNow(id: string, last: number, prevClose: number | null): void {
    this.socket?.send(JSON.stringify({ type: 'quote', id, last, prevClose }));
  }

  failWatchlistLoads(failing: boolean): void {
    this.failingLoads = failing;
  }

  refusedWatchlistLoads(): number {
    return this.refusedLoads;
  }

  async sendQuote(symbol: string, last: number, prevClose: number | null): Promise<void> {
    let id: string | undefined;
    await expect
      .poll(() => {
        id = [...this.subscriptions].find(
          ([, sub]) => sub.channel === 'quotes' && sub.symbol === symbol,
        )?.[0];
        return id;
      })
      .toBeTruthy();
    this.socket?.send(JSON.stringify({ type: 'quote', id, last, prevClose }));
  }

  connections(): number {
    return this.openCount;
  }

  async subscribed(channel: 'bars' | 'book'): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(() => {
        id = [...this.subscriptions].find(([, sub]) => sub.channel === channel)?.[0];
        return id;
      })
      .toBeTruthy();
    return id as string;
  }

  async sendBar(bar: Bar, historical = false): Promise<void> {
    const id = await this.subscribed('bars');
    this.socket?.send(JSON.stringify({ type: 'bar', id, bar, historical }));
  }

  async sendBook(bid: number, ask: number): Promise<void> {
    const id = await this.subscribed('book');
    this.socket?.send(JSON.stringify({ type: 'book', id, bid, ask }));
  }

  async sendBarsState(state: 'live' | 'reconnecting'): Promise<void> {
    const id = await this.subscribed('bars');
    this.socket?.send(JSON.stringify({ type: 'status', id, state }));
  }

  async drop(): Promise<void> {
    this.subscriptions.clear();
    await this.socket?.close();
  }

  private accept(socket: WebSocketRoute): void {
    this.socket = socket;
    this.openCount++;
    socket.send(
      JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, serverTime: NOW }),
    );
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        id: string;
        channel: string;
        symbol: string;
        resolution?: string;
        session?: SessionHours;
      };
      if (message.type === 'subscribe') {
        this.subscriptions.set(message.id, { channel: message.channel, symbol: message.symbol });
        const isStock = stockInfoFor(message.symbol) !== null;
        if (isStock && !this.stockKey.configured) {
          socket.send(
            JSON.stringify({
              type: 'error',
              id: message.id,
              code: 'needs_key',
              message: 'US stock data needs your Alpaca key',
            }),
          );
          return;
        }
        if (message.channel === 'quotes' && !infoFor(message.symbol) && !isStock) {
          socket.send(
            JSON.stringify({
              type: 'error',
              id: message.id,
              code: 'unknown_symbol',
              message: 'Binance does not list this symbol',
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ type: 'status', id: message.id, state: 'live' }));
        if (message.channel === 'quotes') {
          const { last, prevClose } = quoteFor(message.symbol);
          socket.send(JSON.stringify({ type: 'quote', id: message.id, last, prevClose }));
          return;
        }
        const resolution = message.resolution ?? '1D';
        if (message.channel === 'bars') this.barSubscriptions.push([message.id, resolution]);
        const last = (
          isStock ? this.stockBarsFor(resolution, message.session) : this.barsFor(resolution)
        ).at(-1);
        if (message.channel === 'bars' && last) {
          const bar =
            formulaBars(message.symbol, [last])?.[0] ?? scaled(last, capScale(message.symbol));
          socket.send(JSON.stringify({ type: 'bar', id: message.id, bar, historical: false }));
        }
      } else if (message.type === 'unsubscribe') {
        this.subscriptions.delete(message.id);
      }
    });
  }
}

export interface ConsoleGuard {
  /** Console errors and warnings seen so far. */
  readonly problems: string[];
  /** Lets this test log messages matching `pattern` (e.g. an expected 404). */
  allow(pattern: RegExp): void;
}

export const test = base.extend<{
  market: MockMarket;
  consoleGuard: ConsoleGuard;
  /**
   * Leaves the page's clock alone. The pinned clock stands in for requestAnimationFrame and
   * performance.now with timer-driven, whole-millisecond versions, so frame timing needs this.
   */
  realClock: boolean;
}>({
  realClock: [false, { option: true }],
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning')
          problems.push(message.text());
      });
      page.on('pageerror', (error) => problems.push(error.message));
      await use({ problems, allow: (pattern) => allowed.push(pattern) });
      // Every test fails on an unexpected console error or warning.
      expect(problems.filter((text) => !allowed.some((pattern) => pattern.test(text)))).toEqual([]);
    },
    { auto: true },
  ],
  market: [
    async ({ page, realClock }, use) => {
      const gateway = new MockGateway(page);
      await gateway.install(!realClock);
      await use(gateway);
    },
    { auto: true },
  ],
});

// ---- reading the chart (window.__tradingNerd is installed in dev builds) ----

export interface ChartState {
  logicalRange: { from: number; to: number } | null;
  scrollPosition: number;
  width: number;
  priceRange: { from: number; to: number } | null;
  autoScale: boolean;
  barCount: number;
  firstBarTime: number | null;
  lastBar: Bar | null;
  paneWidth: number;
  paneHeight: number;
  lastPriceLabel: { text: string; countdown: string | null; color: string } | null;
  extendedPriceLabel: { text: string; tag: string; color: string } | null;
  sessionBands: { left: number; right: number; color: string }[];
  priceAxisWidth: number;
  indicators: {
    id: string;
    kind: string;
    hidden: boolean;
    pane: number;
    plots: { id: string; start: number; points: number; ghost: boolean }[];
    levels: number;
    fills: { id: string; gradient: boolean }[];
    valueLabels: string[];
  }[];
  panes: { height: number; stretch: number; autoScale: boolean }[];
}

/** The chart's gesture constants (packages/chart/src/tuning.ts). */
export interface GestureTuning {
  zoomStep: number;
  pinchStep: number;
  panFactor: number;
  priceStep: number;
  priceAnchor: 'center' | 'pointer' | 'lastPrice';
  priceReversed: boolean;
}

interface DebugChart {
  debugState(): ChartState;
  debugBars(): Bar[];
  barX(index: number): number | null;
  priceToY(price: number): number | null;
  yToPrice(y: number): number | null;
  scrollBars(bars: number): void;
  gestureTuning(): GestureTuning;
  timeLabel(time: number): string;
  priceLabel(price: number): string;
}

type DebugWindow = { __tradingNerd?: { chart: DebugChart | null } };

export async function chartState(page: Page): Promise<ChartState> {
  const state = await page.evaluate(
    () => (window as unknown as DebugWindow).__tradingNerd?.chart?.debugState() ?? null,
  );
  if (!state) throw new Error('The chart is not mounted');
  return state;
}

/** The bars the chart holds, oldest first. */
export async function chartBars(page: Page): Promise<Bar[]> {
  const bars = await page.evaluate(
    () => (window as unknown as DebugWindow).__tradingNerd?.chart?.debugBars() ?? null,
  );
  if (!bars) throw new Error('The chart is not mounted');
  return bars;
}

/** The gesture constants the chart is using right now. */
export async function chartTuning(page: Page): Promise<GestureTuning> {
  const tuning = await page.evaluate(
    () => (window as unknown as DebugWindow).__tradingNerd?.chart?.gestureTuning() ?? null,
  );
  if (!tuning) throw new Error('The chart is not mounted');
  return tuning;
}

/** The crosshair's time label for a bar time, as the chart draws it. */
export async function chartTimeLabel(page: Page, time: number): Promise<string> {
  return page.evaluate((value) => {
    const chart = (window as unknown as DebugWindow).__tradingNerd?.chart;
    if (!chart) throw new Error('The chart is not mounted');
    return chart.timeLabel(value);
  }, time);
}

/** A price as the chart's price scale labels it. */
export async function chartPriceLabel(page: Page, price: number): Promise<string> {
  return page.evaluate((value) => {
    const chart = (window as unknown as DebugWindow).__tradingNerd?.chart;
    if (!chart) throw new Error('The chart is not mounted');
    return chart.priceLabel(value);
  }, price);
}

/** Waits until the chart shows data, then returns its state. */
export async function openChart(page: Page, url = '/'): Promise<ChartState> {
  await page.goto(url);
  await expect
    .poll(async () => {
      const state = await page.evaluate(
        () => (window as unknown as DebugWindow).__tradingNerd?.chart?.debugState() ?? null,
      );
      return state?.barCount ?? 0;
    })
    .toBeGreaterThan(0);
  return chartState(page);
}

export async function chartCall<T>(
  page: Page,
  method: 'barX' | 'priceToY' | 'yToPrice' | 'scrollBars',
  arg: number,
): Promise<T> {
  return page.evaluate(
    ([name, value]) => {
      const chart = (window as unknown as DebugWindow).__tradingNerd?.chart;
      if (!chart) throw new Error('The chart is not mounted');
      return (chart[name as 'barX'] as (v: number) => unknown)(value as number);
    },
    [method, arg] as const,
  ) as Promise<T>;
}

/** Bar spacing of a visible logical range, as Lightweight Charts defines it. */
export const spacingOf = (range: { from: number; to: number }, width: number) =>
  width / (range.to - range.from + 1);

/** Fractional bar index under pane x, as Lightweight Charts maps it. */
export const indexAtX = (range: { from: number; to: number }, width: number, x: number) =>
  range.to + 0.5 - (width - 1 - x) / spacingOf(range, width);

/** Page coordinates of the chart pane's top-left corner. */
export async function paneOrigin(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByRole('main', { name: 'Chart' }).boundingBox();
  if (!box) throw new Error('Chart panel not visible');
  return { x: box.x, y: box.y };
}

/**
 * Waits for the chart to apply pending view changes. Lightweight Charts applies range and
 * scroll changes on its next animation frame; two frames make sure that has happened.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

export interface WheelInit {
  deltaX?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Fires wheel events at a chart position (pane px; past the pane's right edge is the price
 * axis), all within one frame, with exact deltas, at whatever element is there, as real input
 * would be. (Playwright's mouse.wheel goes through Chromium, which halves synthetic deltas at
 * 2× device scale.)
 */
export async function dispatchWheel(
  page: Page,
  x: number,
  y: number,
  events: readonly WheelInit[],
): Promise<void> {
  await page.evaluate(
    ([px, py, list]) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('Chart panel not found');
      const box = main.getBoundingClientRect();
      const clientX = box.left + (px as number);
      const clientY = box.top + (py as number);
      const target = document.elementFromPoint(clientX, clientY);
      if (!(target instanceof HTMLCanvasElement)) throw new Error(`No chart canvas at ${px},${py}`);
      for (const init of list as WheelInit[]) {
        target.dispatchEvent(
          new WheelEvent('wheel', {
            ...init,
            clientX,
            clientY,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    [x, y, events] as const,
  );
}
