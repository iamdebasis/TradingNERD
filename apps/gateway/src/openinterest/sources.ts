import { isObject } from '../catalog/http.ts';
import { RequestPacer } from '../exchanges/shared.ts';
import { MarketError } from '../market/types.ts';
import { dayOf, dayStart, type OiPoint, STEP_MS } from './series.ts';
import type { OiContract, OiExchange } from './symbols.ts';
import { unzipSingle } from './zip.ts';

/**
 * Where each exchange's open interest comes from (docs/SPEC.md §4, measured 2026-11-07): their
 * official public APIs and Binance's own archive, free and without keys.
 * - Binance: its API keeps 5-minute points for 30 days; data.binance.vision keeps them by day
 *   from 2020-09-01 (BTCUSDT; COIN-M BTCUSD from 2021-07-08, most others from 2021-12-01 or
 *   their listing), a day behind.
 * - Bybit: 5-minute, hourly and daily points, paged back by cursor (not measured from the cloud,
 *   which Bybit turns away).
 * - OKX: its last 1,440 points at 5 minutes and at an hour, and days from 2024-01-01.
 */
export interface OiSource {
  readonly exchange: OiExchange;
  /** How far back `recent` reaches, ms. */
  readonly recentWindowMs: number;
  /** Rejects with MarketError('unknown_symbol') when the exchange has no such perpetual. */
  check(contract: OiContract): Promise<void>;
  /** The open interest now. */
  current(contract: OiContract): Promise<OiPoint>;
  /** Its own 5-minute points from `sinceMs` on, as far back as it keeps them. */
  recent(contract: OiContract, sinceMs: number): Promise<OiPoint[]>;
  /** Its history before what `recent` keeps, newest first, into `into`. */
  backfill(contract: OiContract, into: Backfill, signal: AbortSignal): Promise<void>;
}

export interface Backfill {
  put(points: readonly OiPoint[]): void;
  /** Everything from `ms` to now is in. */
  reached(ms: number): void;
  /** Binance's archive: the days already in, kept between runs, and its first day once found. */
  readonly archive: {
    first(): string | null;
    setFirst(day: string): void;
    has(day: string): boolean;
    mark(day: string): void;
  };
}

interface SourceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Waits between requests to one exchange, ms (tests pass 0). */
  paceMs?: number;
  /** Retries after a failed download (tests pass none). */
  retryDelaysMs?: readonly number[];
}

interface Reply {
  status: number;
  body: unknown;
}

const TIMEOUT_MS = 20_000;

/** A GET whose status and JSON body both come back, so each exchange can read its own errors. */
async function getReply(url: string, name: string, fetchFn: typeof fetch): Promise<Reply> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MarketError('upstream_error', `${name} is unreachable (${detail})`);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function httpError(name: string, status: number): MarketError {
  if (status === 429 || status === 418) {
    return new MarketError('rate_limited', `${name} is rate-limiting requests`);
  }
  // Binance's 451 and Bybit's CloudFront 403: the exchange turns this location away.
  if (status === 451 || status === 403) {
    return new MarketError('upstream_error', `${name} refuses requests from here (HTTP ${status})`);
  }
  return new MarketError('upstream_error', `${name} answered HTTP ${status}`);
}

/** A non-negative number from a decimal string or number; NaN otherwise. */
function num(value: unknown): number {
  const n = typeof value === 'string' && value !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

/**
 * An open interest of exactly 0 is a reading that failed, not a value: Binance's archive has
 * eight on 2026-10-15 between 13:40 and 14:40 UTC ("0E-16"), with about 93,000 BTC either side
 * (measured 2026-11-07). They're left out, as missing.
 */
const reading = (v: number): boolean => !Number.isNaN(v) && v > 0;

const point = (time: unknown, value: unknown): OiPoint | null => {
  const t = num(time);
  const v = num(value);
  return Number.isSafeInteger(t) && reading(v) ? { time: t, value: v } : null;
};

const isPoint = (p: OiPoint | null): p is OiPoint => p !== null;

// ---- Binance ----

export interface BinanceOiOptions extends SourceOptions {
  /** USDⓈ-M futures: https://fapi.binance.com */
  futuresUrl?: string | undefined;
  /** COIN-M futures: https://dapi.binance.com */
  coinmUrl?: string | undefined;
  /** The archive: https://data.binance.vision */
  archiveUrl?: string | undefined;
}

/** USDⓈ-M futures opened in September 2019, COIN-M in August 2020; the archive starts later. */
const ARCHIVE_FLOOR = '2019-09-01';
/** Archive days fetched at once. */
const ARCHIVE_CONCURRENCY = 8;
/** Days so recent the archive may not have them yet: missing then isn't missing for good. */
const ARCHIVE_LAG_DAYS = 3;

export class BinanceOiSource implements OiSource {
  readonly exchange = 'BINANCE' as const;
  readonly recentWindowMs = 30 * 86_400_000 - 10 * 60_000;
  private readonly futuresUrl: string;
  private readonly coinmUrl: string;
  private readonly archiveUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly pacer: RequestPacer;
  private readonly retryDelaysMs: readonly number[];

  constructor(options: BinanceOiOptions = {}) {
    this.futuresUrl = (options.futuresUrl ?? 'https://fapi.binance.com').replace(/\/$/, '');
    this.coinmUrl = (options.coinmUrl ?? 'https://dapi.binance.com').replace(/\/$/, '');
    this.archiveUrl = (options.archiveUrl ?? 'https://data.binance.vision').replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    // Its futures data endpoints allow 1,000 requests in 5 minutes from one address.
    this.pacer = new RequestPacer(options.paceMs ?? 300);
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 3_000];
  }

  async check(contract: OiContract): Promise<void> {
    try {
      await this.current(contract);
    } catch (error) {
      if (error instanceof MarketError && error.code === 'unknown_symbol') throw error;
      // Its API unreachable or refusing this place: the archive's recent days say instead.
      for (let back = 1; back <= ARCHIVE_LAG_DAYS; back++) {
        const day = dayOf(this.now() - back * 86_400_000);
        if (await this.archiveHas(contract, day)) return;
      }
      throw error;
    }
  }

  async current(contract: OiContract): Promise<OiPoint> {
    const url =
      contract.margin === 'linear'
        ? `${this.futuresUrl}/fapi/v1/openInterest?symbol=${contract.providerId}`
        : `${this.coinmUrl}/dapi/v1/openInterest?symbol=${contract.providerId}`;
    const body = await this.get(url);
    const found = isObject(body) ? point(body.time, body.openInterest) : null;
    if (!found) throw new MarketError('upstream_error', 'Binance sent unexpected open interest');
    return found;
  }

  async recent(contract: OiContract, sinceMs: number): Promise<OiPoint[]> {
    const now = this.now();
    let from = Math.floor(Math.max(sinceMs, now - this.recentWindowMs) / STEP_MS) * STEP_MS;
    const out: OiPoint[] = [];
    while (from <= now) {
      const end = Math.min(from + 499 * STEP_MS, now);
      const params =
        contract.margin === 'linear'
          ? `symbol=${contract.providerId}`
          : `pair=${contract.base}USD&contractType=PERPETUAL`;
      const base = contract.margin === 'linear' ? this.futuresUrl : this.coinmUrl;
      const body = await this.get(
        `${base}/futures/data/openInterestHist?${params}&period=5m&limit=500&startTime=${from}&endTime=${end}`,
      );
      const rows = Array.isArray(body) ? body : [];
      const points = rows
        .map((row) => (isObject(row) ? point(row.timestamp, row.sumOpenInterest) : null))
        .filter(isPoint)
        .sort((a, b) => a.time - b.time);
      out.push(...points);
      const last = points.at(-1);
      from = last && last.time >= from ? last.time + STEP_MS : end + STEP_MS;
    }
    return out;
  }

  async backfill(contract: OiContract, into: Backfill, signal: AbortSignal): Promise<void> {
    if (!into.archive.first()) {
      const first = await this.archiveFirstDay(contract, signal);
      if (!first) return;
      into.archive.setFirst(first);
    }
    const first = into.archive.first() as string;
    const days: string[] = [];
    for (let day = dayOf(this.now() - 86_400_000); day >= first; ) {
      days.push(day);
      day = dayOf(dayStart(day) - 86_400_000);
    }
    const settled = dayOf(this.now() - ARCHIVE_LAG_DAYS * 86_400_000);
    for (let i = 0; i < days.length; i += ARCHIVE_CONCURRENCY) {
      if (signal.aborted) return;
      const batch = days.slice(i, i + ARCHIVE_CONCURRENCY);
      await Promise.all(
        batch.map(async (day) => {
          if (into.archive.has(day)) return;
          const points = await this.archiveDay(contract, day, signal);
          if (points === null) {
            // Not there: not yet published, or missing from the archive for good.
            if (day < settled) into.archive.mark(day);
            return;
          }
          into.put(points);
          into.archive.mark(day);
        }),
      );
      into.reached(dayStart(batch.at(-1) as string));
    }
  }

  /** The archive's first day for a perpetual, by bisection: its days run unbroken (measured). */
  private async archiveFirstDay(contract: OiContract, signal: AbortSignal): Promise<string | null> {
    let high: string | null = null;
    for (let back = 1; back <= ARCHIVE_LAG_DAYS + 1 && !high; back++) {
      const day = dayOf(this.now() - back * 86_400_000);
      if (await this.archiveHas(contract, day)) high = day;
    }
    if (!high) return null;
    let lo = dayStart(ARCHIVE_FLOOR) / 86_400_000;
    let hi = dayStart(high) / 86_400_000;
    while (lo < hi && !signal.aborted) {
      const mid = Math.floor((lo + hi) / 2);
      if (await this.archiveHas(contract, dayOf(mid * 86_400_000))) hi = mid;
      else lo = mid + 1;
    }
    return dayOf(lo * 86_400_000);
  }

  private archivePath(contract: OiContract, day: string): string {
    const market = contract.margin === 'linear' ? 'um' : 'cm';
    const id = contract.providerId;
    return `${this.archiveUrl}/data/futures/${market}/daily/metrics/${id}/${id}-metrics-${day}.zip`;
  }

  private async archiveHas(contract: OiContract, day: string): Promise<boolean> {
    const response = await this.download(this.archivePath(contract, day), 'HEAD');
    return response !== null;
  }

  /**
   * One archive day's points: every 5 minutes from 00:00, the open interest in the exchange's
   * unit (`sum_open_interest`: coins for USDⓈ-M, contracts for COIN-M). Its 2020 files hold each
   * row twice and its recent ones aren't in time order (measured): both are put right here.
   */
  private async archiveDay(
    contract: OiContract,
    day: string,
    signal: AbortSignal,
  ): Promise<OiPoint[] | null> {
    const response = await this.download(this.archivePath(contract, day), 'GET', signal);
    if (!response) return null;
    const text = unzipSingle(new Uint8Array(await response.arrayBuffer()));
    const byTime = new Map<number, number>();
    for (const line of text.split(/\r?\n/)) {
      const [stamp, symbol, sum] = line.split(',');
      if (!stamp || symbol !== contract.providerId) continue;
      const time = Date.parse(`${stamp.trim().replace(' ', 'T')}Z`);
      const value = num(sum);
      if (Number.isFinite(time) && reading(value)) byTime.set(time, value);
    }
    return [...byTime].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }

  /** A response for a file that's there, null for one that isn't (404); tries again on errors. */
  private async download(
    url: string,
    method: 'GET' | 'HEAD',
    signal?: AbortSignal,
  ): Promise<Response | null> {
    for (let attempt = 0; ; attempt++) {
      let failure: MarketError;
      try {
        const response = await this.fetchFn(url, {
          method,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
            : AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status === 404 || response.status === 403) {
          // S3 answers a key it doesn't have with 403 or 404.
          if (method === 'GET') await response.body?.cancel();
          return null;
        }
        if (response.ok) return response;
        if (method === 'GET') await response.body?.cancel();
        failure = httpError('Binance', response.status);
      } catch (error) {
        if (signal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        failure = new MarketError('upstream_error', `Binance is unreachable (${detail})`);
      }
      const wait = this.retryDelaysMs[attempt];
      if (wait === undefined) throw failure;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private async get(url: string): Promise<unknown> {
    await this.pacer.wait();
    const { status, body } = await getReply(url, 'Binance', this.fetchFn);
    if (status === 400 && isObject(body) && body.code === -1121) {
      throw new MarketError('unknown_symbol', 'Binance has no such perpetual');
    }
    if (status < 200 || status >= 300) throw httpError('Binance', status);
    return body;
  }
}

// ---- Bybit ----

export interface RestSourceOptions extends SourceOptions {
  restUrl?: string | undefined;
}

/** Points kept from each of Bybit's coarser steps, beyond its 5-minute ones. */
const BYBIT_HOURS_MS = 30 * 86_400_000;
const BYBIT_PAGES = 400;

export class BybitOiSource implements OiSource {
  readonly exchange = 'BYBIT' as const;
  readonly recentWindowMs = 7 * 86_400_000;
  private readonly restUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly pacer: RequestPacer;

  constructor(options: RestSourceOptions = {}) {
    this.restUrl = (options.restUrl ?? 'https://api.bybit.com').replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.pacer = new RequestPacer(options.paceMs ?? 120);
  }

  async check(contract: OiContract): Promise<void> {
    await this.current(contract);
  }

  async current(contract: OiContract): Promise<OiPoint> {
    const body = await this.get(
      `/v5/market/tickers?category=${contract.margin}&symbol=${contract.providerId}`,
    );
    const result = isObject(body) && isObject(body.result) ? body.result : null;
    const row = Array.isArray(result?.list) ? result.list[0] : undefined;
    if (!isObject(row)) throw new MarketError('unknown_symbol', 'Bybit has no such perpetual');
    const found = point(isObject(body) ? body.time : null, row.openInterest);
    if (!found) throw new MarketError('upstream_error', 'Bybit sent unexpected open interest');
    return found;
  }

  recent(contract: OiContract, sinceMs: number): Promise<OiPoint[]> {
    return this.history(contract, '5min', Math.max(sinceMs, this.now() - this.recentWindowMs));
  }

  async backfill(contract: OiContract, into: Backfill): Promise<void> {
    const hoursFrom = this.now() - BYBIT_HOURS_MS;
    into.put(await this.history(contract, '1h', hoursFrom));
    into.reached(hoursFrom);
    into.put(await this.history(contract, '1d', Number.NEGATIVE_INFINITY));
  }

  /** Its points at one step back to `sinceMs`, newest page first, in time order. */
  private async history(contract: OiContract, step: string, sinceMs: number): Promise<OiPoint[]> {
    const out: OiPoint[] = [];
    let cursor = '';
    for (let page = 0; page < BYBIT_PAGES; page++) {
      const params = new URLSearchParams({
        category: contract.margin,
        symbol: contract.providerId,
        intervalTime: step,
        limit: '200',
      });
      if (cursor) params.set('cursor', cursor);
      const body = await this.get(`/v5/market/open-interest?${params}`);
      const result = isObject(body) && isObject(body.result) ? body.result : null;
      const rows = Array.isArray(result?.list) ? result.list : [];
      const points = rows
        .map((row) => (isObject(row) ? point(row.timestamp, row.openInterest) : null))
        .filter(isPoint);
      out.push(...points.filter((p) => p.time >= sinceMs));
      cursor = typeof result?.nextPageCursor === 'string' ? result.nextPageCursor : '';
      const oldest = Math.min(...points.map((p) => p.time));
      if (!cursor || points.length === 0 || oldest < sinceMs) break;
    }
    return out.sort((a, b) => a.time - b.time);
  }

  private async get(path: string): Promise<unknown> {
    await this.pacer.wait();
    const { status, body } = await getReply(`${this.restUrl}${path}`, 'Bybit', this.fetchFn);
    if (status < 200 || status >= 300) throw httpError('Bybit', status);
    if (isObject(body) && body.retCode !== 0) {
      // 10001: "params error", which is what an unknown symbol gets.
      if (body.retCode === 10001) {
        throw new MarketError('unknown_symbol', 'Bybit has no such perpetual');
      }
      throw new MarketError(
        'upstream_error',
        `Bybit error: ${String(body.retMsg ?? body.retCode)}`,
      );
    }
    return body;
  }
}

// ---- OKX ----

const OKX_PAGES = 40;

export class OkxOiSource implements OiSource {
  readonly exchange = 'OKX' as const;
  /** Its last 1,440 points at 5 minutes: five days. */
  readonly recentWindowMs = 1_440 * STEP_MS;
  private readonly restUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pacer: RequestPacer;

  constructor(options: RestSourceOptions = {}) {
    this.restUrl = (options.restUrl ?? 'https://www.okx.com').replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
    // Its trading-statistics endpoints allow 5 requests in 2 seconds.
    this.pacer = new RequestPacer(options.paceMs ?? 450);
  }

  async check(contract: OiContract): Promise<void> {
    await this.current(contract);
  }

  async current(contract: OiContract): Promise<OiPoint> {
    const body = await this.get(
      `/api/v5/public/open-interest?instType=SWAP&instId=${contract.providerId}`,
    );
    const row = isObject(body) && Array.isArray(body.data) ? body.data[0] : undefined;
    if (!isObject(row)) throw new MarketError('unknown_symbol', 'OKX has no such perpetual');
    const found = point(row.ts, row.oi);
    if (!found) throw new MarketError('upstream_error', 'OKX sent unexpected open interest');
    return found;
  }

  recent(contract: OiContract, sinceMs: number): Promise<OiPoint[]> {
    return this.history(contract, '5m', sinceMs);
  }

  async backfill(contract: OiContract, into: Backfill): Promise<void> {
    const hours = await this.history(contract, '1H', Number.NEGATIVE_INFINITY);
    into.put(hours);
    if (hours[0]) into.reached(hours[0].time);
    into.put(await this.history(contract, '1D', Number.NEGATIVE_INFINITY));
  }

  /** Its points at one step back to `sinceMs` (as far as it keeps them), in time order. */
  private async history(contract: OiContract, period: string, sinceMs: number): Promise<OiPoint[]> {
    const out: OiPoint[] = [];
    let end: number | null = null;
    for (let page = 0; page < OKX_PAGES; page++) {
      const params = new URLSearchParams({ instId: contract.providerId, period, limit: '100' });
      if (end !== null) params.set('end', String(end));
      const body = await this.get(`/api/v5/rubik/stat/contracts/open-interest-history?${params}`);
      const rows = isObject(body) && Array.isArray(body.data) ? body.data : [];
      // [ts, oi (contracts), oiCcy, oiUsd], newest first.
      const points = rows
        .map((row) => (Array.isArray(row) ? point(row[0], row[1]) : null))
        .filter(isPoint);
      out.push(...points.filter((p) => p.time >= sinceMs));
      if (points.length === 0) break;
      const oldest = Math.min(...points.map((p) => p.time));
      if (oldest < sinceMs || (end !== null && oldest >= end)) break;
      end = oldest;
    }
    const byTime = new Map(out.map((p) => [p.time, p.value]));
    return [...byTime].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }

  private async get(path: string): Promise<unknown> {
    await this.pacer.wait();
    const { status, body } = await getReply(`${this.restUrl}${path}`, 'OKX', this.fetchFn);
    if (isObject(body) && typeof body.code === 'string' && body.code !== '0') {
      if (body.code === '51001')
        throw new MarketError('unknown_symbol', 'OKX has no such perpetual');
      if (body.code === '50011') {
        throw new MarketError('rate_limited', 'OKX is rate-limiting requests');
      }
      throw new MarketError('upstream_error', `OKX error: ${String(body.msg || body.code)}`);
    }
    if (status < 200 || status >= 300) throw httpError('OKX', status);
    return body;
  }
}
