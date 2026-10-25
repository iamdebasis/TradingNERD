import type { Bar } from '@tradingnerd/core';
import { getJson } from '../../catalog/http.ts';
import { type BitstampInstrument, parseBitstampInstruments, parseBitstampOhlc } from './parse.ts';

/**
 * Bitstamp's front door turns some requests away with HTTP 503 (an HTML page, not the API's
 * answer): overlapping ones, and about one in four of a quick run of them, well under its
 * published limit (measured 2026-10-25). Asked again a moment later, it answers.
 */
const TURNED_AWAY = 503;
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];
/** A breath after each request before the next one goes. */
export const REQUEST_GAP_MS = 250;
/** Saying who's asking turns fewer requests away than a bare client's name. */
const HEADERS = {
  'User-Agent': 'tradingNerd (local market data viewer)',
  Accept: 'application/json',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fetch that says who's asking, and asks again when Bitstamp's front door turns it away. */
export function patientFetch(
  base: typeof fetch,
  delays: readonly number[] = RETRY_DELAYS_MS,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      const response = await base(input, { ...init, headers: HEADERS });
      const delay = delays[attempt];
      if (response.status !== TURNED_AWAY || delay === undefined) return response;
      await response.body?.cancel().catch(() => {});
      await sleep(delay);
    }
  }) as typeof fetch;
}

export interface BitstampRestOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Waits before asking again after a 503 (tests use none). */
  retryDelaysMs?: readonly number[];
  gapMs?: number;
}

/**
 * Bitstamp's public market data, API v2 (no key). Requests go one at a time, a breath apart,
 * since Bitstamp's front door turns overlapping ones away.
 */
export class BitstampRest {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly gapMs: number;
  /** Settles when the last request queued has finished and its breath is over. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BitstampRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchFn = patientFetch(options.fetch ?? fetch, options.retryDelaysMs);
    this.gapMs = options.gapMs ?? REQUEST_GAP_MS;
  }

  /** Every market, spot and perpetual, with its decimals and description. */
  markets(): Promise<unknown> {
    return this.get('/api/v2/markets/');
  }

  /** Every market's last price and 24 h volume. */
  tickers(): Promise<unknown> {
    return this.get('/api/v2/ticker/');
  }

  async instruments(): Promise<BitstampInstrument[]> {
    return parseBitstampInstruments(await this.markets());
  }

  /**
   * Up to `limit` (at most 1,000) bars of `step` seconds, the last one opening at or before
   * `endSec`; without it, the latest ones, the bar in progress last.
   */
  async barsBefore(pair: string, step: string, limit: number, endSec: number | null) {
    const params = new URLSearchParams({ step, limit: String(limit) });
    if (endSec !== null) params.set('end', String(endSec));
    return this.ohlc(pair, params);
  }

  /** Up to `limit` (at most 1,000) bars of `step` seconds, from the one holding `startSec` on. */
  async barsFrom(pair: string, step: string, limit: number, startSec: number) {
    const params = new URLSearchParams({ step, limit: String(limit), start: String(startSec) });
    return this.ohlc(pair, params);
  }

  private async ohlc(pair: string, params: URLSearchParams): Promise<Bar[]> {
    const path = `/api/v2/ohlc/${encodeURIComponent(pair)}/`;
    return parseBitstampOhlc(await this.get(`${path}?${params}`));
  }

  private get(path: string): Promise<unknown> {
    const run = () => getJson(`${this.baseUrl}${path}`, 'Bitstamp', { fetch: this.fetchFn });
    const result = this.queue.then(run, run);
    const breathe = () => sleep(this.gapMs);
    this.queue = result.then(breathe, breathe);
    return result;
  }
}
