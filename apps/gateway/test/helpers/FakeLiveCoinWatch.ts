const HOUR_MS = 3_600_000;

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
}

/**
 * A fetch that answers like Live Coin Watch's API: a point an hour from `start` to `end`, both
 * included, and every request recorded with its body.
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
    const hours: number[] = [];
    for (let ms = Number(body.start); ms <= Number(body.end); ms += HOUR_MS) {
      if (!options.skip?.(ms)) hours.push(ms);
    }
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
