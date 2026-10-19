import type { CoinGeckoPlan } from '@tradingnerd/core';

/** Why a key or request didn't work. */
export type CoinGeckoProblem = 'rejected' | 'rate_limited' | 'unreachable';

export class CoinGeckoError extends Error {
  readonly problem: CoinGeckoProblem;

  constructor(problem: CoinGeckoProblem, message: string) {
    super(message);
    this.name = 'CoinGeckoError';
    this.problem = problem;
  }
}

export interface CoinGeckoKey {
  key: string;
  plan: CoinGeckoPlan;
}

export interface Ticker {
  /** Exchange's base asset, e.g. "LINK". */
  base: string;
  /** CoinGecko's coin id, e.g. "chainlink", or null when it has none. */
  coinId: string | null;
}

export interface Coin {
  id: string;
  /** Lower case, e.g. "link". */
  symbol: string;
  /** The 50 px image. */
  image: string | null;
}

export interface CoinGeckoOptions {
  fetch?: typeof fetch;
  demoUrl?: string;
  proUrl?: string;
  timeoutMs?: number;
}

/** Most tickers CoinGecko returns per page of /exchanges/{id}/tickers. */
export const TICKERS_PER_PAGE = 100;
/** Most coins per page of /coins/markets. */
export const COINS_PER_PAGE = 250;

/**
 * The few CoinGecko endpoints the logo pipeline needs. The key travels only in its header,
 * never in a URL, so it can't end up in logs or history.
 */
export class CoinGeckoClient {
  private readonly fetchFn: typeof fetch;
  private readonly urls: Record<CoinGeckoPlan, string>;
  private readonly timeoutMs: number;

  constructor(options: CoinGeckoOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.urls = {
      demo: options.demoUrl ?? 'https://api.coingecko.com/api/v3',
      pro: options.proUrl ?? 'https://pro-api.coingecko.com/api/v3',
    };
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Which plan a key belongs to: /ping is the one endpoint that refuses a bad key (data
   * endpoints quietly fall back to keyless access). Demo is tried first, then Pro.
   */
  async check(key: string): Promise<CoinGeckoPlan> {
    try {
      await this.get({ key, plan: 'demo' }, '/ping');
      return 'demo';
    } catch (error) {
      if (!(error instanceof CoinGeckoError) || error.problem !== 'rejected') throw error;
    }
    await this.get({ key, plan: 'pro' }, '/ping');
    return 'pro';
  }

  /** One page (1-based) of an exchange's tickers, most traded first. */
  async exchangeTickers(key: CoinGeckoKey, exchangeId: string, page: number): Promise<Ticker[]> {
    const body = await this.get(
      key,
      `/exchanges/${encodeURIComponent(exchangeId)}/tickers?page=${page}&order=volume_desc`,
    );
    const tickers = (body as { tickers?: unknown }).tickers;
    if (!Array.isArray(tickers)) throw new CoinGeckoError('unreachable', 'Unexpected tickers');
    return tickers.flatMap((ticker): Ticker[] => {
      const { base, coin_id: coinId } = ticker as Record<string, unknown>;
      if (typeof base !== 'string') return [];
      return [{ base: base.toUpperCase(), coinId: typeof coinId === 'string' ? coinId : null }];
    });
  }

  /** Coins by id, or the top ones by market cap when `ids` is null (page is 1-based). */
  async coins(key: CoinGeckoKey, ids: readonly string[] | null, page = 1): Promise<Coin[]> {
    const params = new URLSearchParams({
      vs_currency: 'usd',
      per_page: String(COINS_PER_PAGE),
      page: String(page),
      order: 'market_cap_desc',
    });
    if (ids) params.set('ids', ids.join(','));
    const body = await this.get(key, `/coins/markets?${params}`);
    if (!Array.isArray(body)) throw new CoinGeckoError('unreachable', 'Unexpected coin list');
    return body.flatMap((coin): Coin[] => {
      const { id, symbol, image } = coin as Record<string, unknown>;
      if (typeof id !== 'string' || typeof symbol !== 'string') return [];
      return [{ id, symbol: symbol.toLowerCase(), image: smallImage(image) }];
    });
  }

  private async get(key: CoinGeckoKey, path: string): Promise<unknown> {
    const header = key.plan === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
    let response: Response;
    try {
      response = await this.fetchFn(`${this.urls[key.plan]}${path}`, {
        headers: { [header]: key.key, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CoinGeckoError('unreachable', 'CoinGecko is unreachable');
    }
    if (response.status === 401 || response.status === 403) {
      throw new CoinGeckoError('rejected', 'CoinGecko rejected this key');
    }
    if (response.status === 429) {
      throw new CoinGeckoError('rate_limited', 'CoinGecko is rate-limiting requests');
    }
    if (!response.ok) {
      throw new CoinGeckoError('unreachable', `CoinGecko answered HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new CoinGeckoError('unreachable', 'CoinGecko sent something that is not JSON');
    }
  }
}

/** CoinGecko's image URLs point at the 250 px "large" file; the 50 px one sits next to it. */
function smallImage(image: unknown): string | null {
  if (typeof image !== 'string' || !image.startsWith('https://')) return null;
  return image.replace('/large/', '/small/');
}
