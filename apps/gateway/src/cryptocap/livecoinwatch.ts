/**
 * Live Coin Watch's API (https://livecoinwatch.github.io/lcw-api-docs/), with the user's free
 * key: the whole market's market cap and Bitcoin's share of it over time, and a coin's market
 * cap over time, from May 2013 on. A request returns about 100 points, spaced to fit its time
 * span: 4 days come an hour apart. 10,000 requests a day, renewed at UTC midnight; asked faster
 * than about one every 2½ seconds for long, it answers 429 (measured 2026-10-25: about 30 at
 * once, then about 0.4 a second), as it does, presumably, once the day's are used up.
 */

export const LIVECOINWATCH_URL = 'https://api.livecoinwatch.com';
/** Where Live Coin Watch hands out free keys. */
export const LIVECOINWATCH_KEYS_URL = 'https://www.livecoinwatch.com/tools/api';

/** The whole market at one moment: its market cap and Bitcoin's share of it (0–1). */
export interface MarketPoint {
  /** Epoch ms. */
  date: number;
  cap: number;
  btcDominance: number;
}

/** One coin's market cap at one moment. */
export interface CoinPoint {
  date: number;
  cap: number;
}

export class LiveCoinWatchError extends Error {
  /** `rejected`: the key; `limited`: too many requests (too fast, or the day's are used up); `unreachable`: anything else. */
  readonly kind: 'rejected' | 'limited' | 'unreachable';

  constructor(kind: LiveCoinWatchError['kind'], message: string) {
    super(message);
    this.name = 'LiveCoinWatchError';
    this.kind = kind;
  }
}

export interface LiveCoinWatchOptions {
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export class LiveCoinWatchClient {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LiveCoinWatchOptions = {}) {
    this.url = (options.url ?? LIVECOINWATCH_URL).replace(/\/$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** The requests `key` has left today; a key Live Coin Watch doesn't know is `rejected`. */
  async credits(key: string): Promise<number> {
    const body = await this.post(key, '/credits', {});
    const left = (body as Record<string, unknown> | null)?.dailyCreditsRemaining;
    if (!isFiniteNumber(left))
      throw new LiveCoinWatchError('unreachable', 'Live Coin Watch sent unexpected credits');
    return left;
  }

  /** The whole market from `start` to `end` (epoch ms, both included), ascending. */
  async market(key: string, start: number, end: number): Promise<MarketPoint[]> {
    const body = await this.post(key, '/overview/history', { currency: 'USD', start, end });
    if (!Array.isArray(body))
      throw new LiveCoinWatchError('unreachable', 'Live Coin Watch sent unexpected history');
    const points: MarketPoint[] = [];
    for (const item of body) {
      const { date, cap, btcDominance } = (item ?? {}) as Record<string, unknown>;
      if (!isFiniteNumber(date) || !isFiniteNumber(cap) || !(cap > 0)) continue;
      if (!isFiniteNumber(btcDominance) || btcDominance < 0 || btcDominance > 1) continue;
      points.push({ date, cap, btcDominance });
    }
    return points.sort((a, b) => a.date - b.date);
  }

  /** A coin's market cap from `start` to `end` (epoch ms, both included), ascending. */
  async coin(key: string, code: string, start: number, end: number): Promise<CoinPoint[]> {
    const body = await this.post(key, '/coins/single/history', {
      currency: 'USD',
      code,
      start,
      end,
      meta: false,
    });
    const history = (body as Record<string, unknown> | null)?.history;
    if (!Array.isArray(history))
      throw new LiveCoinWatchError('unreachable', 'Live Coin Watch sent unexpected history');
    const points: CoinPoint[] = [];
    for (const item of history) {
      const { date, cap } = (item ?? {}) as Record<string, unknown>;
      if (isFiniteNumber(date) && isFiniteNumber(cap) && cap > 0) points.push({ date, cap });
    }
    return points.sort((a, b) => a.date - b.date);
  }

  private async post(key: string, path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new LiveCoinWatchError('unreachable', 'Live Coin Watch is unreachable');
    }
    if (response.status === 401 || response.status === 403) {
      throw new LiveCoinWatchError('rejected', 'Live Coin Watch rejected this key');
    }
    if (response.status === 429) {
      throw new LiveCoinWatchError('limited', 'Live Coin Watch asked to slow down');
    }
    if (!response.ok) {
      throw new LiveCoinWatchError(
        'unreachable',
        `Live Coin Watch answered HTTP ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new LiveCoinWatchError(
        'unreachable',
        'Live Coin Watch sent something that is not JSON',
      );
    }
  }
}
