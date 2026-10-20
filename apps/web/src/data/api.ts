import {
  API_PREFIX,
  type BarsResponse,
  type ErrorCode,
  type ExchangeSummary,
  type FlagState,
  type LogoStatus,
  parseApiError,
  parseBarsResponse,
  parseExchangeList,
  parseFlagState,
  parseLogoStatus,
  parseStockKeyStatus,
  parseSymbolInfo,
  parseSymbolSearchResponse,
  parseWatchlist,
  type SearchCategory,
  type StockKeyStatus,
  type SymbolInfo,
  type SymbolSearchResponse,
  type Watchlist,
} from '@tradingnerd/core';

/** A failed gateway call, with the gateway's error code or `network` if it couldn't be reached. */
export class ApiError extends Error {
  readonly code: ErrorCode | 'network';

  constructor(code: ErrorCode | 'network', message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** The REST half of the gateway, as the chart session needs it. */
export interface MarketApi {
  resolveSymbol(symbol: string, signal?: AbortSignal): Promise<SymbolInfo>;
  getBars(
    symbol: string,
    resolution: string,
    to: number | null,
    countBack: number,
    signal?: AbortSignal,
  ): Promise<BarsResponse>;
}

async function getJson(
  path: string,
  signal?: AbortSignal,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, signal ? { ...init, signal } : init);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('network', 'The local gateway is not reachable');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = parseApiError(body);
    throw new ApiError(
      failure?.error ?? 'internal_error',
      failure?.message ?? `Gateway error (HTTP ${response.status})`,
    );
  }
  return body;
}

export const marketApi: MarketApi = {
  async resolveSymbol(symbol, signal) {
    const body = await getJson(
      `${API_PREFIX}/symbols/resolve?symbol=${encodeURIComponent(symbol)}`,
      signal,
    );
    const info = parseSymbolInfo(body);
    if (!info)
      throw new ApiError('internal_error', 'The gateway sent malformed symbol information');
    return info;
  },

  async getBars(symbol, resolution, to, countBack, signal) {
    const params = new URLSearchParams({ symbol, resolution, countBack: String(countBack) });
    if (to !== null) params.set('to', String(to));
    const body = await getJson(`${API_PREFIX}/bars?${params}`, signal);
    const bars = parseBarsResponse(body);
    if (!bars) throw new ApiError('internal_error', 'The gateway sent malformed bars');
    return bars;
  },
};

export interface SearchRequest {
  query: string;
  /** Only this exchange's pairs. */
  exchange: string | null;
  /** Only this tab's symbols: stocks, funds or crypto. */
  category?: SearchCategory | null;
  offset: number;
}

/** Symbol search across every exchange's pairs, ranked by the gateway (docs/SPEC.md §5.4). */
export const searchApi = {
  async search(request: SearchRequest, signal?: AbortSignal): Promise<SymbolSearchResponse> {
    const params = new URLSearchParams({ query: request.query, offset: String(request.offset) });
    if (request.exchange) params.set('exchange', request.exchange);
    if (request.category) params.set('category', request.category);
    const body = await getJson(`${API_PREFIX}/symbols/search?${params}`, signal);
    const results = parseSymbolSearchResponse(body);
    if (!results) throw new ApiError('internal_error', 'The gateway sent malformed search results');
    return results;
  },

  async exchanges(signal?: AbortSignal): Promise<ExchangeSummary[]> {
    const list = parseExchangeList(await getJson(`${API_PREFIX}/exchanges`, signal));
    if (!list) throw new ApiError('internal_error', 'The gateway sent a malformed exchange list');
    return list.exchanges;
  },
};

export type SearchApi = typeof searchApi;

/** The watchlist the gateway keeps in data/watchlist.json. */
export const watchlistApi = {
  async load(signal?: AbortSignal): Promise<Watchlist> {
    const list = parseWatchlist(await getJson(`${API_PREFIX}/watchlist`, signal));
    if (!list) throw new ApiError('internal_error', 'The gateway sent a malformed watchlist');
    return list;
  },

  async save(list: Watchlist): Promise<Watchlist> {
    const saved = parseWatchlist(
      await getJson(`${API_PREFIX}/watchlist`, undefined, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(list),
      }),
    );
    if (!saved) throw new ApiError('internal_error', 'The gateway sent a malformed watchlist');
    return saved;
  },
};

/** Flagged symbols, kept by the gateway in data/flags.json. */
export const flagsApi = {
  async load(signal?: AbortSignal): Promise<FlagState> {
    const state = parseFlagState(await getJson(`${API_PREFIX}/flags`, signal));
    if (!state) throw new ApiError('internal_error', 'The gateway sent malformed flags');
    return state;
  },

  async save(state: FlagState): Promise<FlagState> {
    const saved = parseFlagState(
      await getJson(`${API_PREFIX}/flags`, undefined, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      }),
    );
    if (!saved) throw new ApiError('internal_error', 'The gateway sent malformed flags');
    return saved;
  },
};

async function logoStatus(path: string, init: RequestInit = {}): Promise<LogoStatus> {
  const status = parseLogoStatus(await getJson(`${API_PREFIX}/logos${path}`, undefined, init));
  if (!status) throw new ApiError('internal_error', 'The gateway sent a malformed logo status');
  return status;
}

/** Coin logos: the CoinGecko key lives in the gateway; the browser only ever sees it masked. */
export const logosApi = {
  status: () => logoStatus('/status'),
  saveKey: (key: string) =>
    logoStatus('/key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }),
  removeKey: () => logoStatus('/key', { method: 'DELETE' }),
  dismissPrompt: () => logoStatus('/prompt-dismissed', { method: 'POST' }),
};

export type LogosApi = typeof logosApi;

async function stockKey(init: RequestInit = {}): Promise<StockKeyStatus> {
  const status = parseStockKeyStatus(await getJson(`${API_PREFIX}/stocks/key`, undefined, init));
  if (!status) throw new ApiError('internal_error', 'The gateway sent a malformed key status');
  return status;
}

/** US stocks' Alpaca key: it lives in the gateway; the browser only ever sees the ID masked. */
export const stocksApi = {
  status: () => stockKey(),
  saveKey: (keyId: string, secret: string) =>
    stockKey({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyId, secret }),
    }),
  removeKey: () => stockKey({ method: 'DELETE' }),
};

export type StocksApi = typeof stocksApi;
