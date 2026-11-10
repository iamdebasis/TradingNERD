import type { Bar } from '@tradingnerd/core';
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

/** A non-negative decimal from a string or number; null when missing or not one. */
export function decimal(value: unknown): number | null {
  const n =
    typeof value === 'string' && value !== ''
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A bar from open time (ms) and decimal fields; null when any field is malformed. */
export function toBar(
  openMs: number,
  open: unknown,
  high: unknown,
  low: unknown,
  close: unknown,
  volume: unknown,
): Bar | null {
  const [o, h, l, c, v] = [
    decimal(open),
    decimal(high),
    decimal(low),
    decimal(close),
    decimal(volume),
  ];
  if (!Number.isSafeInteger(openMs) || openMs < 0 || o === null || h === null || l === null) {
    return null;
  }
  if (c === null || v === null) return null;
  return { time: Math.floor(openMs / 1000), open: o, high: h, low: l, close: c, volume: v };
}

/**
 * When a request's connection fails (refused, reset or dropped: Node's "fetch failed"), it goes
 * again this long after, twice, before the exchange counts as unreachable. A passing network
 * hiccup failed two live tests on the Mac (2026-11-10: Kraken and Bitstamp, once each), and would
 * put an error on a chart. A timeout isn't asked again: it has waited long enough already.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [500, 1_500];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a fetch failed on its connection, rather than timing out or being stopped. */
export function droppedConnection(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'fetch failed';
}

/**
 * A GET asked again after a dropped connection (RECONNECT_DELAYS_MS), each time with a fresh
 * timeout. Any answer, an error one included, comes back as it is.
 */
export async function fetchAgainOnDrop(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  delays: readonly number[] = RECONNECT_DELAYS_MS,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !droppedConnection(error)) throw error;
      await sleep(delay);
    }
  }
}

export interface FetchOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Waits before asking again after a dropped connection (RECONNECT_DELAYS_MS by default). */
  retryDelaysMs?: readonly number[];
}

/** GETs JSON from an exchange's public API; a failure becomes a MarketError naming it. */
export async function getJson(
  url: string,
  exchange: string,
  options: FetchOptions = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchAgainOnDrop(
      options.fetch ?? fetch,
      url,
      options.timeoutMs ?? 20_000,
      options.retryDelaysMs,
    );
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
