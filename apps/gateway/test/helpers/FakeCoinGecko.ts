/** A tiny valid PNG (1×1, transparent). */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A coin as /coins/markets describes it, for market caps. */
export interface FakeMarketRow {
  id: string;
  symbol: string;
  name?: string;
  rank?: number | null;
  price: number;
  cap: number;
  supply?: number;
  volume?: number;
}

export interface FakeCoinGeckoOptions {
  /** Keys CoinGecko accepts, by plan. */
  keys?: Record<string, 'demo' | 'pro'>;
  /** Binance tickers, most traded first: [base, coin id or null]. */
  tickers?: [string, string | null][];
  /** Coins by market cap: [id, symbol]. */
  coins?: [string, string][];
  /** Answer every API call with this status (e.g. 429). */
  status?: number;
  /** Fail like an unreachable network. */
  offline?: boolean;
  /** Override an image's bytes, by coin id. */
  imageBytes?: Record<string, Buffer>;
  /** Exchanges with logos, most traded first: CoinGecko ids (default: our five). */
  exchanges?: string[];
  /** Coins with market data, largest first; /coins/markets answers with these when given. */
  markets?: FakeMarketRow[];
  /** Ids in CoinGecko's "stablecoins" category. */
  stablecoins?: string[];
  /** A coin's history for /coins/{id}/market_chart: [ms, price] and [ms, cap] points. */
  charts?: Record<string, { prices: [number, number][]; caps: [number, number][] }>;
}

/** A fetch that answers like CoinGecko's API and image CDN, recording every request. */
export function fakeCoinGecko(options: FakeCoinGeckoOptions = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const keys = options.keys ?? { 'CG-demo-key-3f9a': 'demo' };
  const tickers = options.tickers ?? [];
  const coins = options.coins ?? [];
  const image = (id: string) => `https://coin-images.coingecko.com/coins/images/1/large/${id}.png`;

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url: url.toString(), headers });
    if (options.offline) throw new TypeError('fetch failed');

    if (url.hostname === 'coin-images.coingecko.com') {
      const id = url.pathname.split('/').at(-1)?.replace('.png', '') ?? '';
      return new Response(options.imageBytes?.[id] ?? PNG_BYTES, {
        headers: { 'content-type': 'image/png' },
      });
    }
    if (options.status) return Response.json({}, { status: options.status });
    const plan = url.hostname.startsWith('pro-api') ? 'pro' : 'demo';
    const key = headers[plan === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'];
    if (!key || keys[key] !== plan)
      return Response.json({ status: { error_code: 10002 } }, { status: 401 });

    const path = url.pathname.replace('/api/v3', '');
    if (path === '/ping') return Response.json({ gecko_says: '(V3) To the Moon!' });
    if (path === '/exchanges/binance/tickers') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const slice = tickers.slice((page - 1) * 100, page * 100);
      return Response.json({
        tickers: slice.map(([base, coinId]) => ({ base, target: 'USDT', coin_id: coinId })),
      });
    }
    if (path === '/exchanges') {
      const ids = options.exchanges ?? ['binance', 'bybit_spot', 'okex', 'gdax', 'kraken'];
      return Response.json(
        ids.map((id) => ({
          id,
          name: id,
          image: `https://coin-images.coingecko.com/markets/images/9/small/${id}.png`,
        })),
      );
    }
    if (path === '/coins/markets' && options.markets) {
      const ids = url.searchParams.get('ids')?.split(',');
      const category = url.searchParams.get('category');
      const page = Number(url.searchParams.get('page') ?? 1);
      let rows = options.markets;
      if (category === 'stablecoins') {
        rows = rows.filter((row) => options.stablecoins?.includes(row.id));
      }
      if (ids) rows = rows.filter((row) => ids.includes(row.id));
      return Response.json(
        rows.slice((page - 1) * 250, page * 250).map((row) => ({
          id: row.id,
          symbol: row.symbol.toLowerCase(),
          name: row.name ?? row.symbol,
          image: image(row.id),
          market_cap_rank:
            row.rank === undefined ? (options.markets ?? rows).indexOf(row) + 1 : row.rank,
          current_price: row.price,
          market_cap: row.cap,
          circulating_supply: row.supply ?? row.cap / row.price,
          total_volume: row.volume ?? 1_000_000,
        })),
      );
    }
    const chart = /^\/coins\/([a-z0-9-]+)\/market_chart$/.exec(path);
    if (chart?.[1]) {
      const history = options.charts?.[chart[1]];
      if (!history) return Response.json({ error: 'coin not found' }, { status: 404 });
      return Response.json({
        prices: history.prices,
        market_caps: history.caps,
        total_volumes: history.prices.map(([ms]) => [ms, 1_000_000]),
      });
    }
    if (path === '/coins/markets') {
      const ids = url.searchParams.get('ids');
      const page = Number(url.searchParams.get('page') ?? 1);
      const list = ids
        ? coins.filter(([id]) => ids.split(',').includes(id))
        : coins.slice((page - 1) * 250, page * 250);
      return Response.json(list.map(([id, symbol]) => ({ id, symbol, image: image(id) })));
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;

  return { fetch: fetchFn, calls };
}
