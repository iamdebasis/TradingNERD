const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A coin on the fake's list, with its market cap and price over time. */
export interface FakeListedCoin {
  code: string;
  name?: string;
  /** Its highest price ever and supply, as the list gives them now. */
  ath?: number;
  supply?: number;
  categories?: string[];
  /** Its price now, as the list gives it. */
  rate?: number;
  /** The markets it trades on now (1 by default). */
  markets?: number;
  /** Its market cap and price at a moment (epoch ms); null before it existed. */
  at: (ms: number) => { cap: number; rate: number } | null;
}

export interface FakeLiveCoinWatchOptions {
  /** The whole market's market cap at a moment (epoch ms). */
  cap: (ms: number) => number;
  /** Bitcoin's share of it, 0–1 (60% by default). */
  dominance?: (ms: number) => number;
  /** Ethereum's market cap. */
  ethereum?: (ms: number) => number;
  /** Moments without a point, as in days Live Coin Watch has no data for. */
  skip?: (ms: number) => boolean;
  /** The keys it knows (any by default); others get 401. */
  keys?: string[];
  /** Answer a path with this HTTP status instead (401: a key it rejects, 429: too many). */
  status?: (path: string) => number | null;
  /** The day's requests left, as /credits tells (9,999 by default). */
  credits?: () => number;
  /** Its coin list (empty by default), each with its history. */
  coins?: FakeListedCoin[];
  /** Called with each request before it's answered. */
  onRequest?: (path: string, body: Record<string, unknown>) => void;
}

/**
 * Moments a history request returns, as Live Coin Watch spaces them: an hour apart over up to 4
 * days, else about 100 spread over the span, whole days apart at 00:00 UTC.
 */
function moments(start: number, end: number): number[] {
  const out: number[] = [];
  if (end - start <= 4 * DAY_MS) {
    for (let ms = start; ms <= end; ms += HOUR_MS) out.push(ms);
    return out;
  }
  const step = Math.max(1, Math.ceil((end - start) / 100 / DAY_MS)) * DAY_MS;
  for (let ms = Math.ceil(start / DAY_MS) * DAY_MS; ms <= end; ms += step) out.push(ms);
  return out;
}

/**
 * A fetch that answers like Live Coin Watch's API: a point an hour from `start` to `end`, both
 * included (about 100 a day apart over longer spans), and every request recorded with its body.
 */
export function fakeLiveCoinWatch(options: FakeLiveCoinWatchOptions) {
  const requests: { path: string; key: string | null; body: Record<string, unknown> }[] = [];
  const dominance = options.dominance ?? (() => 0.6);
  const ethereum = options.ethereum ?? (() => 0);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const key = headers['x-api-key'] ?? null;
    requests.push({ path, key, body });
    options.onRequest?.(path, body);
    if (options.keys && !options.keys.includes(key ?? ''))
      return new Response('{}', { status: 401 });
    const status = options.status?.(path) ?? null;
    if (status !== null) return new Response('{"error":{}}', { status });
    if (path === '/credits') {
      return json({
        dailyCreditsRemaining: options.credits?.() ?? 9_999,
        dailyCreditsLimit: 10_000,
      });
    }
    if (path === '/coins/list') {
      const offset = Number(body.offset ?? 0);
      const limit = Number(body.limit ?? 10);
      const listed = [...(options.coins ?? [])].sort((a, b) => (a.code < b.code ? -1 : 1));
      return json(
        listed.slice(offset, offset + limit).map((coin) => ({
          code: coin.code,
          name: coin.name ?? coin.code,
          rate: coin.rate ?? 1,
          cap: 0,
          allTimeHighUSD: coin.ath ?? 0,
          circulatingSupply: coin.supply ?? 0,
          totalSupply: null,
          maxSupply: null,
          categories: coin.categories ?? [],
          markets: coin.markets ?? 1,
        })),
      );
    }
    const hours = moments(Number(body.start), Number(body.end)).filter((ms) => !options.skip?.(ms));
    if (path === '/overview/history') {
      return json(
        hours.map((date) => ({
          date,
          cap: options.cap(date),
          volume: 1,
          liquidity: 1,
          btcDominance: dominance(date),
        })),
      );
    }
    const listed = options.coins?.find((coin) => coin.code === body.code);
    if (path === '/coins/single/history' && listed) {
      const history = hours.flatMap((date) => {
        const point = listed.at(date);
        return point ? [{ date, rate: point.rate, volume: 1, cap: point.cap }] : [];
      });
      return json({ code: body.code, history });
    }
    if (path === '/coins/single/history' && options.coins && body.code !== 'ETH') {
      return new Response(
        '{"error":{"code":400,"description":"Specified coin does not exist or is inactive."}}',
        { status: 400 },
      );
    }
    if (path === '/coins/single/history') {
      return json({
        code: body.code,
        history: hours.map((date) => ({ date, rate: 1, volume: 1, cap: ethereum(date) })),
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  return { fetch: fetchFn, requests };
}
