import { type Bar, DELAYED_SIP_MS, type SipAccess } from '@tradingnerd/core';
import { MarketError } from '../market/types.ts';

/**
 * Alpaca's REST APIs, with the user's key: market data (bars of the whole US market, the SIP
 * feed) from data.alpaca.markets, and the trading calendar and asset list from the trading
 * API. The free plan serves the whole market 15 minutes late (docs/SPEC.md §5.7), so requests
 * end at least that far back unless the key has real-time access.
 */

export interface AlpacaKey {
  keyId: string;
  secret: string;
}

export type AlpacaTimeframe = '1Min' | '5Min' | '15Min' | '30Min' | '1Day';

export interface BarsQuery {
  timeframe: AlpacaTimeframe;
  /** Bars timed from `start` to `end` (ms, both inclusive). */
  start: number;
  end: number;
  /** Most bars over all the symbols. */
  limit: number;
  /** Ascending, or newest first (so a limit keeps the latest). */
  sort: 'asc' | 'desc';
}

/** One trading day as Alpaca's calendar lists it: "2026-11-27", "09:30", "13:00". */
export interface AlpacaCalendarDay {
  date: string;
  open: string;
  close: string;
}

export interface AlpacaAsset {
  symbol: string;
  exchange: string;
  name: string;
  status: string;
}

export interface AlpacaClientOptions {
  /** The user's key, read for every request (it can change while running). */
  key: () => Promise<AlpacaKey | null>;
  /** How the key's plan serves the whole market (delayed until known). */
  sip?: () => SipAccess | null;
  dataUrl?: string | undefined;
  /** Trading API hosts, tried in order: paper accounts' keys work only on the paper host. */
  tradingUrls?: readonly string[] | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** Alpaca allows 200 a minute on the free plan; a little under it leaves room. */
  requestsPerMinute?: number;
  /** Waits (ms): tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
}

const DATA_URL = 'https://data.alpaca.markets';
const TRADING_URLS = ['https://paper-api.alpaca.markets', 'https://api.alpaca.markets'];
/** Most bars Alpaca returns per page. */
export const ALPACA_PAGE_LIMIT = 10_000;
const TIMEOUT_MS = 15_000;
/** A second more than the delay, so a request never asks for data the plan withholds. */
const DELAY_MARGIN_MS = 1_000;
const RETRIES = 3;

/** Whether a 403 was the plan refusing recent whole-market data, not the key. */
const isSubscriptionRefusal = (message: string) => /subscription/i.test(message);

export class AlpacaClient {
  private readonly key: () => Promise<AlpacaKey | null>;
  private readonly sip: () => SipAccess | null;
  private readonly dataUrl: string;
  private readonly tradingUrls: readonly string[];
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly perMinute: number;
  /** When recent requests went out, for the rate limit. */
  private readonly sent: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  /** The trading host that last accepted the key. */
  private tradingUrl: string | null = null;

  constructor(options: AlpacaClientOptions) {
    this.key = options.key;
    this.sip = options.sip ?? (() => null);
    this.dataUrl = options.dataUrl ?? DATA_URL;
    this.tradingUrls = options.tradingUrls ?? TRADING_URLS;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.perMinute = options.requestsPerMinute ?? 190;
  }

  /** The latest moment the plan serves the whole market for. */
  latestAvailable(): number {
    const delayed = this.sip() !== 'realtime';
    return this.now() - (delayed ? DELAYED_SIP_MS + DELAY_MARGIN_MS : 0);
  }

  /**
   * Bars of the whole market (SIP), split-adjusted as TradingView shows them, by symbol. Pages
   * are followed until `limit` bars have come or there are no more.
   */
  async bars(symbols: readonly string[], query: BarsQuery): Promise<Map<string, Bar[]>> {
    const out = new Map<string, Bar[]>(symbols.map((symbol) => [symbol, []]));
    const end = Math.min(query.end, this.latestAvailable());
    if (symbols.length === 0 || query.start > end || query.limit < 1) return out;
    const key = await this.requireKey();
    let pageToken: string | null = null;
    let remaining = query.limit;
    do {
      const url = new URL('/v2/stocks/bars', this.dataUrl);
      url.searchParams.set('symbols', symbols.join(','));
      url.searchParams.set('timeframe', query.timeframe);
      url.searchParams.set('start', new Date(query.start).toISOString());
      url.searchParams.set('end', new Date(end).toISOString());
      url.searchParams.set('limit', String(Math.min(remaining, ALPACA_PAGE_LIMIT)));
      url.searchParams.set('sort', query.sort);
      url.searchParams.set('feed', 'sip');
      url.searchParams.set('adjustment', 'split');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const body = await this.request(url, key);
      const page = parseBarsPage(body);
      for (const [symbol, bars] of page.bars) {
        const list = out.get(symbol);
        if (!list) continue;
        list.push(...bars);
        remaining -= bars.length;
      }
      pageToken = page.nextPageToken;
    } while (pageToken && remaining > 0);
    return out;
  }

  /** Trading days from `start` to `end` ("2026-01-01"), with their regular hours. */
  async calendar(start: string, end: string): Promise<AlpacaCalendarDay[]> {
    const body = await this.trading('/v2/calendar', { start, end });
    if (!Array.isArray(body)) throw upstream('calendar');
    return body.flatMap((day: unknown) => {
      if (typeof day !== 'object' || day === null) return [];
      const { date, open, close } = day as Record<string, unknown>;
      return typeof date === 'string' && typeof open === 'string' && typeof close === 'string'
        ? [{ date, open, close }]
        : [];
    });
  }

  /** Every active US equity Alpaca has data for. */
  async assets(): Promise<AlpacaAsset[]> {
    const body = await this.trading('/v2/assets', { status: 'active', asset_class: 'us_equity' });
    if (!Array.isArray(body)) throw upstream('asset list');
    return body.flatMap((asset: unknown) => {
      if (typeof asset !== 'object' || asset === null) return [];
      const { symbol, exchange, name, status } = asset as Record<string, unknown>;
      return typeof symbol === 'string' && typeof exchange === 'string'
        ? [{ symbol, exchange, name: typeof name === 'string' ? name : '', status: String(status) }]
        : [];
    });
  }

  /**
   * Checks a key, and how its plan serves the whole market: a request for the last minutes
   * succeeds with real-time access and is refused, as a matter of subscription, without it.
   * Rejects with `needs_key` when Alpaca doesn't accept the key.
   */
  async checkKey(key: AlpacaKey): Promise<SipAccess> {
    const now = this.now();
    const url = new URL('/v2/stocks/bars', this.dataUrl);
    url.searchParams.set('symbols', 'SPY');
    url.searchParams.set('timeframe', '1Min');
    url.searchParams.set('start', new Date(now - 10 * 60_000).toISOString());
    url.searchParams.set('end', new Date(now).toISOString());
    url.searchParams.set('limit', '1');
    url.searchParams.set('feed', 'sip');
    try {
      await this.request(url, key);
      return 'realtime';
    } catch (error) {
      if (error instanceof SubscriptionRefusal) return 'delayed';
      throw error;
    }
  }

  private async trading(path: string, params: Record<string, string>): Promise<unknown> {
    const key = await this.requireKey();
    const hosts = this.tradingUrl
      ? [this.tradingUrl, ...this.tradingUrls.filter((url) => url !== this.tradingUrl)]
      : this.tradingUrls;
    let refusal: unknown = null;
    for (const host of hosts) {
      const url = new URL(path, host);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      try {
        const body = await this.request(url, key);
        this.tradingUrl = host;
        return body;
      } catch (error) {
        // A key from the other kind of account: try the next host.
        if (error instanceof MarketError && error.code === 'needs_key') {
          refusal = error;
          continue;
        }
        throw error;
      }
    }
    throw refusal ?? upstream('trading API');
  }

  private async requireKey(): Promise<AlpacaKey> {
    const key = await this.key();
    if (!key) throw new MarketError('needs_key', 'US stock data needs your Alpaca key');
    return key;
  }

  private async request(url: URL, key: AlpacaKey): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.takeTurn();
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          headers: {
            accept: 'application/json',
            'APCA-API-KEY-ID': key.keyId,
            'APCA-API-SECRET-KEY': key.secret,
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt + 1 < RETRIES) {
          await this.sleep(1_000 * 2 ** attempt);
          continue;
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new MarketError('upstream_error', `Alpaca didn't answer (${detail})`);
      }
      if (response.ok) return response.json();
      const message = await messageOf(response);
      if (response.status === 429 || response.status >= 500) {
        if (attempt + 1 < RETRIES) {
          await this.sleep(retryWait(response, this.now(), attempt));
          continue;
        }
        throw response.status === 429
          ? new MarketError('rate_limited', 'Alpaca is limiting requests; try again shortly')
          : new MarketError('upstream_error', `Alpaca failed (HTTP ${response.status})`);
      }
      if (response.status === 403 && isSubscriptionRefusal(message)) {
        throw new SubscriptionRefusal(message);
      }
      if (response.status === 401 || response.status === 403) {
        throw new MarketError(
          'needs_key',
          "Alpaca didn't accept the key; check it and enter it again",
        );
      }
      if (response.status === 404 || response.status === 422) {
        throw new MarketError('unknown_symbol', `Alpaca: ${message || 'not found'}`);
      }
      throw new MarketError(
        'upstream_error',
        `Alpaca refused the request (HTTP ${response.status})`,
      );
    }
  }

  /** Waits until a request fits in the last minute's allowance; one at a time. */
  private takeTurn(): Promise<void> {
    const turn = this.queue.then(async () => {
      const windowStart = this.now() - 60_000;
      while (this.sent.length > 0 && (this.sent[0] ?? 0) <= windowStart) this.sent.shift();
      if (this.sent.length >= this.perMinute) {
        await this.sleep((this.sent[0] ?? 0) + 60_000 - this.now());
        this.sent.shift();
      }
      this.sent.push(this.now());
    });
    this.queue = turn.catch(() => {});
    return turn;
  }
}

/** The plan doesn't include what was asked for (recent whole-market data, on the free plan). */
export class SubscriptionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionRefusal';
  }
}

const upstream = (what: string) =>
  new MarketError('upstream_error', `Alpaca sent an unreadable ${what}`);

async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body?.message === 'string' ? body.message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

/** How long to wait before retrying: until Alpaca's limit resets, or a growing pause. */
function retryWait(response: Response, now: number, attempt: number): number {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (response.status === 429 && Number.isFinite(reset) && reset > 0) {
    return Math.min(60_000, Math.max(250, reset * 1000 - now));
  }
  return 1_000 * 2 ** attempt;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A page of /v2/stocks/bars: bars by symbol, each `t` an RFC 3339 time. */
function parseBarsPage(body: unknown): { bars: Map<string, Bar[]>; nextPageToken: string | null } {
  if (typeof body !== 'object' || body === null) throw upstream('bars page');
  const { bars, next_page_token: token } = body as Record<string, unknown>;
  const out = new Map<string, Bar[]>();
  if (bars !== null && bars !== undefined) {
    if (typeof bars !== 'object' || Array.isArray(bars)) throw upstream('bars page');
    for (const [symbol, list] of Object.entries(bars)) {
      if (!Array.isArray(list)) throw upstream('bars page');
      const parsed: Bar[] = [];
      for (const item of list) {
        const { t, o, h, l, c, v } = (item ?? {}) as Record<string, unknown>;
        const time = typeof t === 'string' ? Date.parse(t) : Number.NaN;
        if (!Number.isFinite(time) || ![o, h, l, c, v].every(isNumber)) continue;
        parsed.push({
          time: Math.floor(time / 1000),
          open: o as number,
          high: h as number,
          low: l as number,
          close: c as number,
          volume: v as number,
        });
      }
      out.set(symbol, parsed);
    }
  }
  return { bars: out, nextPageToken: typeof token === 'string' && token !== '' ? token : null };
}
