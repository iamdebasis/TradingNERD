import {
  API_PREFIX,
  type BarsResponse,
  type ErrorCode,
  parseApiError,
  parseBarsResponse,
  parseSymbolInfo,
  type SymbolInfo,
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

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, signal ? { signal } : {});
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
