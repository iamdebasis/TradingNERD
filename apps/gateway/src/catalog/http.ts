import { MarketError } from '../market/types.ts';

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Tickers and asset codes kept from exchange lists; anything else is skipped. */
const TICKER = /^[A-Z0-9]{2,30}$/;
const ASSET = /^[A-Z0-9]{1,20}$/;
export const isTicker = (value: unknown): value is string =>
  typeof value === 'string' && TICKER.test(value);
export const isAsset = (value: unknown): value is string =>
  typeof value === 'string' && ASSET.test(value);

/** A positive amount from a decimal string or number; 0 when missing or not one. */
export function amount(value: unknown): number {
  const n =
    typeof value === 'string' && value !== ''
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface FetchOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** GETs JSON from an exchange's public API; a failure becomes a MarketError naming it. */
export async function getJson(
  url: string,
  exchange: string,
  options: FetchOptions = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MarketError('upstream_error', `${exchange} is unreachable (${detail})`);
  }
  if (response.status === 429) {
    throw new MarketError('rate_limited', `${exchange} is rate-limiting requests`);
  }
  if (!response.ok) {
    throw new MarketError('upstream_error', `${exchange} answered HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new MarketError('upstream_error', `${exchange} sent a response that isn't JSON`);
  }
}

export function unexpected(exchange: string, what: string): MarketError {
  return new MarketError('upstream_error', `${exchange} sent unexpected ${what}`);
}
