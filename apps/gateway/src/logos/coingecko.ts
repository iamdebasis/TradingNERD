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

export interface ExchangeLogo {
  /** CoinGecko's exchange id, e.g. "gdax" for Coinbase. */
  id: string;
  /** The exchange's logo, or null when it has none. */
  image: string | null;
}

/** A coin's market data, from /coins/markets. */
export interface MarketCoin {
  id: string;
  /** Upper case, e.g. "XRP". */
  symbol: string;
  name: string;
  /** CoinGecko's market cap rank; null for coins it doesn't rank. */
  rank: number | null;
  /** US dollars. */
  price: number;
  cap: number;
  /** Circulating supply. */
  supply: number;
  /** Traded over 24 h, US dollars. */
  volume: number;
}

/** A coin's history from /coins/{id}/market_chart: [epoch ms, US dollars] points. */
export interface MarketChart {
  prices: [number, number][];
  caps: [number, number][];
  volumes: [number, number][];
}

export interface CoinGeckoOptions {
  fetch?: typeof fetch;
  demoUrl?: string;
  proUrl?: string;
  timeoutMs?: number;
  /** Told of every API call (the monthly allowance counts them all); image downloads are free. */
  onCall?: () => void;
}

/** CoinGecko's coin ids: lower case letters, digits and dashes. */
const COIN_ID = /^[a-z0-9-]{1,96}$/;

/** Most tickers CoinGecko returns per page of /exchanges/{id}/tickers. */
export const TICKERS_PER_PAGE = 100;
/** Most coins per page of /coins/markets. */
export const COINS_PER_PAGE = 250;

/**
 * The few CoinGecko endpoints the gateway needs: logos, and CRYPTOCAP's market caps. The key
 * travels only in its header, never in a URL, so it can't end up in logs or history.
 */
export class CoinGeckoClient {
  private readonly fetchFn: typeof fetch;
  private readonly urls: Record<CoinGeckoPlan, string>;
  private readonly timeoutMs: number;
  private readonly onCall: () => void;

  constructor(options: CoinGeckoOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.urls = {
      demo: options.demoUrl ?? 'https://api.coingecko.com/api/v3',
      pro: options.proUrl ?? 'https://pro-api.coingecko.com/api/v3',
    };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.onCall = options.onCall ?? (() => {});
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

  /**
   * One page (1-based) of coins with their prices, market caps and circulating supply, by
   * market cap: all coins, those of a category ("stablecoins"), or the ones in `ids`.
   */
  async markets(
    key: CoinGeckoKey,
    { page = 1, category, ids }: { page?: number; category?: string; ids?: readonly string[] },
  ): Promise<MarketCoin[]> {
    const params = new URLSearchParams({
      vs_currency: 'usd',
      order: 'market_cap_desc',
      per_page: String(COINS_PER_PAGE),
      page: String(page),
    });
    if (category) params.set('category', category);
    if (ids) params.set('ids', ids.join(','));
    const body = await this.get(key, `/coins/markets?${params}`);
    if (!Array.isArray(body)) throw new CoinGeckoError('unreachable', 'Unexpected coin list');
    return body.flatMap((row): MarketCoin[] => {
      const { id, symbol, name, market_cap_rank: rank } = row as Record<string, unknown>;
      const { current_price: price, market_cap: cap } = row as Record<string, unknown>;
      const { circulating_supply: supply, total_volume: volume } = row as Record<string, unknown>;
      if (typeof id !== 'string' || !COIN_ID.test(id) || typeof symbol !== 'string') return [];
      if (!isPositive(price) || !isPositive(cap)) return [];
      return [
        {
          id,
          symbol: symbol.toUpperCase(),
          name: typeof name === 'string' ? name : symbol.toUpperCase(),
          rank: typeof rank === 'number' && rank > 0 ? rank : null,
          price,
          cap,
          supply: isPositive(supply) ? supply : cap / price,
          volume: isPositive(volume) ? volume : 0,
        },
      ];
    });
  }

  /**
   * A coin's prices, market caps and volumes over the last `days` days: daily points at
   * 00:00 UTC beyond 90 days (the free plan reaches back 365 days at most).
   */
  async marketChart(key: CoinGeckoKey, id: string, days: number): Promise<MarketChart> {
    if (!COIN_ID.test(id)) throw new CoinGeckoError('unreachable', 'Not a CoinGecko coin id');
    const params = new URLSearchParams({ vs_currency: 'usd', days: String(days) });
    if (days > 90) params.set('interval', 'daily');
    const body = await this.get(key, `/coins/${id}/market_chart?${params}`);
    const { prices, market_caps: caps, total_volumes: volumes } = body as Record<string, unknown>;
    if (!Array.isArray(prices) || !Array.isArray(caps)) {
      throw new CoinGeckoError('unreachable', 'Unexpected market chart');
    }
    return {
      prices: points(prices),
      caps: points(caps),
      volumes: Array.isArray(volumes) ? points(volumes) : [],
    };
  }

  /** The 250 most traded exchanges and their logos. */
  async exchanges(key: CoinGeckoKey): Promise<ExchangeLogo[]> {
    const body = await this.get(key, '/exchanges?per_page=250&page=1');
    if (!Array.isArray(body)) throw new CoinGeckoError('unreachable', 'Unexpected exchange list');
    return body.flatMap((exchange): ExchangeLogo[] => {
      const { id, image } = exchange as Record<string, unknown>;
      if (typeof id !== 'string') return [];
      const https = typeof image === 'string' && image.startsWith('https://') ? image : null;
      return [{ id, image: https }];
    });
  }

  private async get(key: CoinGeckoKey, path: string): Promise<unknown> {
    const header = key.plan === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
    this.onCall();
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

const isPositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** [time, value] pairs with finite numbers, ascending by time; anything else is dropped. */
function points(list: readonly unknown[]): [number, number][] {
  const out: [number, number][] = [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [time, value] = item as unknown[];
    if (typeof time !== 'number' || !Number.isFinite(time) || !isPositive(value)) continue;
    if (out.length > 0 && time <= (out.at(-1) as [number, number])[0]) continue;
    out.push([time, value]);
  }
  return out;
}

/** CoinGecko's image URLs point at the 250 px "large" file; the 50 px one sits next to it. */
function smallImage(image: unknown): string | null {
  if (typeof image !== 'string' || !image.startsWith('https://')) return null;
  return image.replace('/large/', '/small/');
}
