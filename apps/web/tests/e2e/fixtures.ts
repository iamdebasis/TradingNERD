import { test as base, expect, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import {
  type Bar,
  barOpenTime,
  type CatalogEntry,
  DEFAULT_WATCHLIST,
  type ExchangeSummary,
  type LogoStatus,
  PROTOCOL_VERSION,
  parseResolution,
  parseWatchlist,
  SEARCH_PAGE_SIZE,
  type SymbolInfo,
  searchCatalog,
  type Watchlist,
} from '@tradingnerd/core';

export { expect };

/**
 * Browser tests run against a mock gateway (REST routes plus a routed WebSocket), so they're
 * deterministic and never touch the network. The clock is pinned to 16:09:54 UTC, 7 h 50 min
 * 06 s before the daily close, which is the countdown in docs/reference/01-chart-layout.png.
 */
export const NOW = Date.parse('2026-10-18T16:09:54Z');
export const DAY = 86_400;
/** Open time (UTC seconds) of today's daily bar. */
export const LAST_DAY = Date.UTC(2026, 9, 18) / 1000;

/** The CoinGecko key the mock gateway accepts. */
export const MOCK_KEY = 'CG-demo-key-3f9a';
/** A 1×1 PNG, standing in for a coin logo. */
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const XRP_INFO: SymbolInfo = {
  id: 'BINANCE:XRPUSDT',
  exchange: 'BINANCE',
  exchangeName: 'Binance',
  ticker: 'XRPUSDT',
  base: 'XRP',
  quote: 'USDT',
  description: 'XRP / TetherUS',
  type: 'spot',
  tickSize: 0.0001,
  pricePrecision: 4,
  resolutions: ['1', '60', '1D'],
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Price decimals of the default watchlist's coins on Binance (others: 4). */
const PRECISION: Record<string, number> = {
  LINK: 3,
  ZAMA: 5,
  DASH: 2,
  POL: 5,
  STRK: 5,
  VET: 6,
  SHIB: 8,
  RUNE: 3,
  PEPE: 8,
  KSM: 2,
};

/** Coins Binance doesn't list: XCH is the reference's unavailable row. */
const UNLISTED = new Set(['XCH']);

/** The exchanges the mock's symbol catalog covers, all with live data as in the gateway. */
export const MOCK_EXCHANGES: ExchangeSummary[] = [
  { id: 'BINANCE', name: 'Binance', live: true },
  { id: 'BYBIT', name: 'Bybit', live: true },
  { id: 'OKX', name: 'OKX', live: true },
  { id: 'COINBASE', name: 'Coinbase', live: true },
  { id: 'KRAKEN', name: 'Kraken', live: true },
];
const EXCHANGE_NAMES = new Map(MOCK_EXCHANGES.map((exchange) => [exchange.id, exchange.name]));

const listing = (
  exchange: string,
  ticker: string,
  base: string,
  quote: string,
  description: string,
  volumeUsd: number,
): CatalogEntry => ({
  exchange,
  ticker,
  base,
  quote,
  description,
  volumeUsd,
  live: true,
});

/**
 * What the mock's symbol search searches (with the gateway's own ranking): XRP across the five
 * exchanges as on 2026-10-19, the default watchlist's coins on Binance, and 60 quiet pairs so
 * an empty search has a second page.
 */
export const MOCK_CATALOG: CatalogEntry[] = [
  listing('BINANCE', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 150e6),
  listing('OKX', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 22e6),
  listing('BYBIT', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 20e6),
  listing('KRAKEN', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 1e6),
  listing('COINBASE', 'XRPUSDT', 'XRP', 'USDT', 'XRP / TetherUS', 0.2e6),
  listing('COINBASE', 'XRPUSD', 'XRP', 'USD', 'XRP / US Dollar', 66e6),
  listing('KRAKEN', 'XRPUSD', 'XRP', 'USD', 'XRP / US Dollar', 22e6),
  listing('BINANCE', 'XRPUSDC', 'XRP', 'USDC', 'XRP / USDC', 30e6),
  listing('BYBIT', 'XRPUSDC', 'XRP', 'USDC', 'XRP / USDC', 2e6),
  listing('BINANCE', 'XRPEUR', 'XRP', 'EUR', 'XRP / Euro', 5e6),
  listing('COINBASE', 'XRPEUR', 'XRP', 'EUR', 'XRP / Euro', 0.8e6),
  listing('BINANCE', 'XRPTRY', 'XRP', 'TRY', 'XRP / Turkish Lira', 3.2e6),
  listing('BINANCE', 'XRPBTC', 'XRP', 'BTC', 'XRP / Bitcoin', 3e6),
  listing('BINANCE', 'XRPU', 'XRP', 'U', 'XRP / United Stables', 0.5e6),
  listing('BINANCE', 'BTCUSDT', 'BTC', 'USDT', 'Bitcoin / TetherUS', 900e6),
  listing('KRAKEN', 'XBTUSD', 'BTC', 'USD', 'Bitcoin / US Dollar', 117e6),
  listing('OKX', 'XCHUSDT', 'XCH', 'USDT', 'Chia / TetherUS', 1e6),
  ...(DEFAULT_WATCHLIST.sections[0]?.symbols ?? [])
    .filter((symbol) => symbol !== XRP_INFO.id)
    .map((symbol, i) => {
      const base = symbol.slice('BINANCE:'.length, -'USDT'.length);
      return listing('BINANCE', `${base}USDT`, base, 'USDT', `${base} / TetherUS`, 50e6 - i * 1e6);
    }),
  ...Array.from({ length: 60 }, (_, i) =>
    listing('BINANCE', `QQ${i}USDT`, `QQ${i}`, 'USDT', `Quiet ${i} / TetherUS`, 1_000 - i),
  ),
];

/** SymbolInfo for any pair in the mock catalog, or any BINANCE:…USDT but the unlisted. */
export function infoFor(symbol: string): SymbolInfo | null {
  if (symbol === XRP_INFO.id) return XRP_INFO;
  const listed = MOCK_CATALOG.find((entry) => `${entry.exchange}:${entry.ticker}` === symbol);
  const match = /^BINANCE:([A-Z0-9]+)USDT$/.exec(symbol);
  const base = listed?.base ?? match?.[1];
  const quote = listed?.quote ?? 'USDT';
  if (!base || UNLISTED.has(base)) return null;
  const exchange = listed?.exchange ?? 'BINANCE';
  const pricePrecision = PRECISION[base] ?? 4;
  return {
    ...XRP_INFO,
    id: symbol,
    exchange,
    exchangeName: EXCHANGE_NAMES.get(exchange) ?? exchange,
    ticker: listed?.ticker ?? `${base}${quote}`,
    base,
    quote,
    description: listed?.description ?? `${base} / TetherUS`,
    tickSize: 10 ** -pricePrecision,
    pricePrecision,
  };
}

/**
 * A watchlist quote for any symbol: LINK matches the reference's row (11.947, −0.403, −3.26%);
 * the rest are made up from the symbol's name.
 */
export function quoteFor(symbol: string): { last: number; prevClose: number } {
  if (symbol === 'BINANCE:LINKUSDT') return { last: 11.947, prevClose: 12.35 };
  if (symbol === 'BINANCE:VETUSDT') return { last: 0.006731, prevClose: 0.006979 };
  if (symbol === XRP_INFO.id) return { last: 1.2955, prevClose: 1.3115 };
  const seed = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const last = 0.5 + (seed % 97) / 10;
  return { last, prevClose: last * (1 + ((seed % 7) - 3) / 100) };
}

/** Seeded PRNG, so every run draws the same chart. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * `count` daily bars ending today: a random walk around 1.0–1.6 whose final bar matches the
 * reference screenshot's last candle (O 1.3115 H 1.3126 L 1.2902 C 1.2955, a red bar).
 */
export function makeBars(count = 2_500): Bar[] {
  const random = mulberry32(42);
  const bars: Bar[] = [];
  let close = 1.25;
  for (let i = 0; i < count - 1; i++) {
    const open = close;
    close = Math.min(1.6, Math.max(0.95, open * (1 + (random() - 0.5) * 0.06)));
    const high = Math.max(open, close) * (1 + random() * 0.02);
    const low = Math.min(open, close) * (1 - random() * 0.02);
    bars.push({
      time: LAST_DAY - (count - 1 - i) * DAY,
      open: round4(open),
      high: round4(high),
      low: round4(low),
      close: round4(close),
      volume: Math.round(1e7 + random() * 1e7),
    });
  }
  const previous = bars.at(-1);
  if (previous) previous.close = 1.3115;
  bars.push({
    time: LAST_DAY,
    open: 1.3115,
    high: 1.3126,
    low: 1.2902,
    close: 1.2955,
    volume: 2e7,
  });
  return bars;
}

/**
 * `count` bars of any time-based interval ending with the bar that is live at NOW, on the
 * interval's real boundaries: a random walk around 1.3.
 */
export function makeIntervalBars(resolution: string, count = 1_500): Bar[] {
  const parsed = parseResolution(resolution);
  if (!parsed || parsed.unit === 'tick') throw new Error(`No mock bars for ${resolution}`);
  const times: number[] = [];
  for (let t = barOpenTime(parsed, NOW); times.length < count; t = barOpenTime(parsed, t - 1)) {
    times.unshift(t / 1000);
  }
  const random = mulberry32(7);
  let close = 1.3;
  return times.map((time) => {
    const open = close;
    close = round4(Math.min(1.6, Math.max(1, open * (1 + (random() - 0.5) * 0.01))));
    return {
      time,
      open,
      high: round4(Math.max(open, close) * (1 + random() * 0.003)),
      low: round4(Math.min(open, close) * (1 - random() * 0.003)),
      close,
      volume: 1_000,
    };
  });
}

/** The number of the first mock tick bar (tick bars are numbered by trade, see Bar.time). */
export const FIRST_TICK_BAR = 17_369_000;

/** `count` tick bars, numbered from FIRST_TICK_BAR, their first trades 0.6 s apart up to NOW. */
export function makeTickBars(count = 1_500): Bar[] {
  const random = mulberry32(11);
  let close = 1.3;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    close = round4(Math.min(1.6, Math.max(1, open * (1 + (random() - 0.5) * 0.002))));
    return {
      time: FIRST_TICK_BAR + i,
      open,
      high: round4(Math.max(open, close) * 1.0005),
      low: round4(Math.min(open, close) * 0.9995),
      close,
      volume: 100,
      start: NOW - (count - 1 - i) * 600,
    };
  });
}

export interface MockMarket {
  /** Daily history served by GET /api/bars (other intervals get makeIntervalBars). */
  bars: Bar[];
  /** The watchlist GET /api/watchlist serves; PUTs replace it. */
  watchlist: Watchlist;
  /** Every watchlist the page saved, in order. */
  readonly watchlistSaves: Watchlist[];
  /** While true, watchlist loads fail as if the gateway were unreachable. */
  failWatchlistLoads(failing: boolean): void;
  /** How many watchlist loads were refused. */
  refusedWatchlistLoads(): number;
  /** Sends a quote for a symbol the page has subscribed to. */
  sendQuote(symbol: string, last: number, prevClose: number | null): Promise<void>;
  /** Quote subscription ids by symbol, for streaming quotes in bulk. */
  quoteIds(): Map<string, string>;
  /** Sends a quote on a known subscription id, without waiting. */
  sendQuoteNow(id: string, last: number, prevClose: number | null): void;
  /** What GET /api/logos/status answers; by default the first-launch prompt was skipped. */
  logoStatus: LogoStatus;
  /** Every body the page sent to PUT /api/logos/key. */
  readonly savedKeys: string[];
  /** Query of every symbol search, in order. */
  readonly searchRequests: URLSearchParams[];
  /** Exchanges the mock says have live data (all five, unless a test takes one away). */
  readonly liveExchanges: Set<string>;
  /** Every bars subscription the page has made: [id, resolution], in order. */
  readonly barSubscriptions: [string, string][];
  /** Ids of subscriptions the page still holds. */
  activeSubscriptions(): string[];
  /** Query of every /api/bars request, in order. */
  readonly barRequests: URLSearchParams[];
  /** How many WebSocket connections the page has opened. */
  connections(): number;
  /** Resolves with the id once the page has subscribed to a channel. */
  subscribed(channel: 'bars' | 'book'): Promise<string>;
  sendBar(bar: Bar, historical?: boolean): Promise<void>;
  sendBook(bid: number, ask: number): Promise<void>;
  /** Reports the chart's bars subscription as reconnecting or live, as during an exchange outage. */
  sendBarsState(state: 'live' | 'reconnecting'): Promise<void>;
  /** Drops the page's WebSocket, like a gateway restart. */
  drop(): Promise<void>;
}

class MockGateway implements MockMarket {
  bars: Bar[] = makeBars();
  watchlist: Watchlist = structuredClone(DEFAULT_WATCHLIST);
  logoStatus: LogoStatus = {
    key: null,
    promptDismissed: true,
    syncedAt: null,
    syncing: false,
    syncError: null,
  };
  readonly savedKeys: string[] = [];
  readonly searchRequests: URLSearchParams[] = [];
  readonly liveExchanges = new Set(MOCK_EXCHANGES.map((exchange) => exchange.id));
  readonly watchlistSaves: Watchlist[] = [];
  readonly barRequests: URLSearchParams[] = [];
  readonly barSubscriptions: [string, string][] = [];
  private readonly page: Page;
  private socket: WebSocketRoute | null = null;
  private openCount = 0;
  private failingLoads = false;
  private refusedLoads = 0;
  private readonly subscriptions = new Map<string, { channel: string; symbol: string }>();
  private readonly series = new Map<string, Bar[]>();

  constructor(page: Page) {
    this.page = page;
  }

  async install(pinClock: boolean): Promise<void> {
    if (pinClock) await this.page.clock.setFixedTime(NOW);
    await this.page.route(/\/api\/symbols\/resolve\?/, (route) => {
      const symbol = new URL(route.request().url()).searchParams.get('symbol') ?? '';
      const info = infoFor(symbol);
      return info
        ? route.fulfill({ json: info })
        : route.fulfill({
            status: 404,
            json: { error: 'unknown_symbol', message: 'Binance does not list this symbol' },
          });
    });
    await this.page.route(/\/api\/logos\//, (route) => this.logos(route));
    await this.page.route(/\/api\/symbols\/search\?/, (route) => {
      const params = new URL(route.request().url()).searchParams;
      this.searchRequests.push(params);
      return route.fulfill({
        json: searchCatalog(
          MOCK_CATALOG.map((entry) => ({ ...entry, live: this.liveExchanges.has(entry.exchange) })),
          {
            query: params.get('query') ?? '',
            exchange: params.get('exchange'),
            offset: Number(params.get('offset') ?? 0),
            limit: Number(params.get('limit') ?? SEARCH_PAGE_SIZE),
          },
        ),
      });
    });
    await this.page.route(/\/api\/exchanges$/, (route) =>
      route.fulfill({
        json: {
          exchanges: MOCK_EXCHANGES.map((exchange) => ({
            ...exchange,
            live: this.liveExchanges.has(exchange.id),
          })),
        },
      }),
    );
    await this.page.route(/\/api\/watchlist$/, (route) => {
      if (route.request().method() === 'PUT') {
        const saved = parseWatchlist(route.request().postDataJSON());
        if (!saved)
          return route.fulfill({ status: 400, json: { error: 'bad_request', message: 'x' } });
        this.watchlist = saved;
        this.watchlistSaves.push(saved);
        return route.fulfill({ json: saved });
      }
      if (this.failingLoads) {
        this.refusedLoads++;
        return route.abort('connectionrefused');
      }
      return route.fulfill({ json: this.watchlist });
    });
    await this.page.route(/\/api\/bars\?/, (route) => {
      const params = new URL(route.request().url()).searchParams;
      this.barRequests.push(params);
      const to = params.get('to');
      const countBack = Number(params.get('countBack') ?? 300);
      const bars = this.barsFor(params.get('resolution') ?? '1D');
      const eligible = bars.filter((bar) => to === null || bar.time < Number(to));
      return route.fulfill({
        json: { bars: eligible.slice(-countBack), hasMore: eligible.length > countBack },
      });
    });
    await this.page.routeWebSocket(/\/ws$/, (socket) => this.accept(socket));
  }

  /** The history this mock serves for an interval. */
  barsFor(resolution: string): Bar[] {
    if (resolution === '1D') return this.bars;
    let bars = this.series.get(resolution);
    if (!bars) {
      bars = resolution.endsWith('T') ? makeTickBars() : makeIntervalBars(resolution);
      this.series.set(resolution, bars);
    }
    return bars;
  }

  activeSubscriptions(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** The gateway's logo routes: MOCK_KEY works; XRP and LINK have logos once synced. */
  private logos(route: Route) {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/logos/exchange/')) {
      return this.logoStatus.syncedAt
        ? route.fulfill({ body: LOGO_PNG, contentType: 'image/png' })
        : route.fulfill({ status: 204 });
    }
    if (path.startsWith('/api/logos/coin/')) {
      const base = path.split('/').at(-1);
      return this.logoStatus.syncedAt && (base === 'XRP' || base === 'LINK')
        ? route.fulfill({ body: LOGO_PNG, contentType: 'image/png' })
        : route.fulfill({ status: 204 });
    }
    if (path === '/api/logos/key' && request.method() === 'PUT') {
      const key = String((request.postDataJSON() as { key?: unknown }).key ?? '');
      this.savedKeys.push(key);
      if (key.trim() !== MOCK_KEY) {
        return route.fulfill({
          status: 400,
          json: { error: 'bad_request', message: 'CoinGecko rejected this key' },
        });
      }
      this.logoStatus = {
        ...this.logoStatus,
        key: { masked: '••••3f9a', plan: 'demo', source: 'file' },
        syncedAt: NOW,
      };
    } else if (path === '/api/logos/key' && request.method() === 'DELETE') {
      this.logoStatus = { ...this.logoStatus, key: null };
    } else if (path === '/api/logos/prompt-dismissed') {
      this.logoStatus = { ...this.logoStatus, promptDismissed: true };
    }
    return route.fulfill({ json: this.logoStatus });
  }

  quoteIds(): Map<string, string> {
    const ids = new Map<string, string>();
    for (const [id, sub] of this.subscriptions)
      if (sub.channel === 'quotes') ids.set(sub.symbol, id);
    return ids;
  }

  sendQuoteNow(id: string, last: number, prevClose: number | null): void {
    this.socket?.send(JSON.stringify({ type: 'quote', id, last, prevClose }));
  }

  failWatchlistLoads(failing: boolean): void {
    this.failingLoads = failing;
  }

  refusedWatchlistLoads(): number {
    return this.refusedLoads;
  }

  async sendQuote(symbol: string, last: number, prevClose: number | null): Promise<void> {
    let id: string | undefined;
    await expect
      .poll(() => {
        id = [...this.subscriptions].find(
          ([, sub]) => sub.channel === 'quotes' && sub.symbol === symbol,
        )?.[0];
        return id;
      })
      .toBeTruthy();
    this.socket?.send(JSON.stringify({ type: 'quote', id, last, prevClose }));
  }

  connections(): number {
    return this.openCount;
  }

  async subscribed(channel: 'bars' | 'book'): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(() => {
        id = [...this.subscriptions].find(([, sub]) => sub.channel === channel)?.[0];
        return id;
      })
      .toBeTruthy();
    return id as string;
  }

  async sendBar(bar: Bar, historical = false): Promise<void> {
    const id = await this.subscribed('bars');
    this.socket?.send(JSON.stringify({ type: 'bar', id, bar, historical }));
  }

  async sendBook(bid: number, ask: number): Promise<void> {
    const id = await this.subscribed('book');
    this.socket?.send(JSON.stringify({ type: 'book', id, bid, ask }));
  }

  async sendBarsState(state: 'live' | 'reconnecting'): Promise<void> {
    const id = await this.subscribed('bars');
    this.socket?.send(JSON.stringify({ type: 'status', id, state }));
  }

  async drop(): Promise<void> {
    this.subscriptions.clear();
    await this.socket?.close();
  }

  private accept(socket: WebSocketRoute): void {
    this.socket = socket;
    this.openCount++;
    socket.send(
      JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, serverTime: NOW }),
    );
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        id: string;
        channel: string;
        symbol: string;
        resolution?: string;
      };
      if (message.type === 'subscribe') {
        this.subscriptions.set(message.id, { channel: message.channel, symbol: message.symbol });
        if (message.channel === 'quotes' && !infoFor(message.symbol)) {
          socket.send(
            JSON.stringify({
              type: 'error',
              id: message.id,
              code: 'unknown_symbol',
              message: 'Binance does not list this symbol',
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ type: 'status', id: message.id, state: 'live' }));
        if (message.channel === 'quotes') {
          const { last, prevClose } = quoteFor(message.symbol);
          socket.send(JSON.stringify({ type: 'quote', id: message.id, last, prevClose }));
          return;
        }
        const resolution = message.resolution ?? '1D';
        if (message.channel === 'bars') this.barSubscriptions.push([message.id, resolution]);
        const last = this.barsFor(resolution).at(-1);
        if (message.channel === 'bars' && last) {
          socket.send(
            JSON.stringify({ type: 'bar', id: message.id, bar: last, historical: false }),
          );
        }
      } else if (message.type === 'unsubscribe') {
        this.subscriptions.delete(message.id);
      }
    });
  }
}

export interface ConsoleGuard {
  /** Console errors and warnings seen so far. */
  readonly problems: string[];
  /** Lets this test log messages matching `pattern` (e.g. an expected 404). */
  allow(pattern: RegExp): void;
}

export const test = base.extend<{
  market: MockMarket;
  consoleGuard: ConsoleGuard;
  /**
   * Leaves the page's clock alone. The pinned clock stands in for requestAnimationFrame and
   * performance.now with timer-driven, whole-millisecond versions, so frame timing needs this.
   */
  realClock: boolean;
}>({
  realClock: [false, { option: true }],
  consoleGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const allowed: RegExp[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning')
          problems.push(message.text());
      });
      page.on('pageerror', (error) => problems.push(error.message));
      await use({ problems, allow: (pattern) => allowed.push(pattern) });
      // Every test fails on an unexpected console error or warning.
      expect(problems.filter((text) => !allowed.some((pattern) => pattern.test(text)))).toEqual([]);
    },
    { auto: true },
  ],
  market: [
    async ({ page, realClock }, use) => {
      const gateway = new MockGateway(page);
      await gateway.install(!realClock);
      await use(gateway);
    },
    { auto: true },
  ],
});

// ---- reading the chart (window.__tradingNerd is installed in dev builds) ----

export interface ChartState {
  logicalRange: { from: number; to: number } | null;
  scrollPosition: number;
  width: number;
  priceRange: { from: number; to: number } | null;
  autoScale: boolean;
  barCount: number;
  firstBarTime: number | null;
  lastBar: Bar | null;
  paneWidth: number;
  paneHeight: number;
  lastPriceLabel: { text: string; countdown: string | null; color: string } | null;
  priceAxisWidth: number;
}

/** The chart's gesture constants (packages/chart/src/tuning.ts). */
export interface GestureTuning {
  zoomStep: number;
  pinchStep: number;
  panFactor: number;
  priceStep: number;
  priceAnchor: 'center' | 'pointer' | 'lastPrice';
  priceReversed: boolean;
}

interface DebugChart {
  debugState(): ChartState;
  barX(index: number): number | null;
  priceToY(price: number): number | null;
  yToPrice(y: number): number | null;
  scrollBars(bars: number): void;
  gestureTuning(): GestureTuning;
  timeLabel(time: number): string;
}

type DebugWindow = { __tradingNerd?: { chart: DebugChart | null } };

export async function chartState(page: Page): Promise<ChartState> {
  const state = await page.evaluate(
    () => (window as unknown as DebugWindow).__tradingNerd?.chart?.debugState() ?? null,
  );
  if (!state) throw new Error('The chart is not mounted');
  return state;
}

/** The gesture constants the chart is using right now. */
export async function chartTuning(page: Page): Promise<GestureTuning> {
  const tuning = await page.evaluate(
    () => (window as unknown as DebugWindow).__tradingNerd?.chart?.gestureTuning() ?? null,
  );
  if (!tuning) throw new Error('The chart is not mounted');
  return tuning;
}

/** The crosshair's time label for a bar time, as the chart draws it. */
export async function chartTimeLabel(page: Page, time: number): Promise<string> {
  return page.evaluate((value) => {
    const chart = (window as unknown as DebugWindow).__tradingNerd?.chart;
    if (!chart) throw new Error('The chart is not mounted');
    return chart.timeLabel(value);
  }, time);
}

/** Waits until the chart shows data, then returns its state. */
export async function openChart(page: Page, url = '/'): Promise<ChartState> {
  await page.goto(url);
  await expect
    .poll(async () => {
      const state = await page.evaluate(
        () => (window as unknown as DebugWindow).__tradingNerd?.chart?.debugState() ?? null,
      );
      return state?.barCount ?? 0;
    })
    .toBeGreaterThan(0);
  return chartState(page);
}

export async function chartCall<T>(
  page: Page,
  method: 'barX' | 'priceToY' | 'yToPrice' | 'scrollBars',
  arg: number,
): Promise<T> {
  return page.evaluate(
    ([name, value]) => {
      const chart = (window as unknown as DebugWindow).__tradingNerd?.chart;
      if (!chart) throw new Error('The chart is not mounted');
      return (chart[name as 'barX'] as (v: number) => unknown)(value as number);
    },
    [method, arg] as const,
  ) as Promise<T>;
}

/** Bar spacing of a visible logical range, as Lightweight Charts defines it. */
export const spacingOf = (range: { from: number; to: number }, width: number) =>
  width / (range.to - range.from + 1);

/** Fractional bar index under pane x, as Lightweight Charts maps it. */
export const indexAtX = (range: { from: number; to: number }, width: number, x: number) =>
  range.to + 0.5 - (width - 1 - x) / spacingOf(range, width);

/** Page coordinates of the chart pane's top-left corner. */
export async function paneOrigin(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByRole('main', { name: 'Chart' }).boundingBox();
  if (!box) throw new Error('Chart panel not visible');
  return { x: box.x, y: box.y };
}

/**
 * Waits for the chart to apply pending view changes. Lightweight Charts applies range and
 * scroll changes on its next animation frame; two frames make sure that has happened.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

export interface WheelInit {
  deltaX?: number;
  deltaY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Fires wheel events at a chart position (pane px; past the pane's right edge is the price
 * axis), all within one frame, with exact deltas, at whatever element is there, as real input
 * would be. (Playwright's mouse.wheel goes through Chromium, which halves synthetic deltas at
 * 2× device scale.)
 */
export async function dispatchWheel(
  page: Page,
  x: number,
  y: number,
  events: readonly WheelInit[],
): Promise<void> {
  await page.evaluate(
    ([px, py, list]) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('Chart panel not found');
      const box = main.getBoundingClientRect();
      const clientX = box.left + (px as number);
      const clientY = box.top + (py as number);
      const target = document.elementFromPoint(clientX, clientY);
      if (!(target instanceof HTMLCanvasElement)) throw new Error(`No chart canvas at ${px},${py}`);
      for (const init of list as WheelInit[]) {
        target.dispatchEvent(
          new WheelEvent('wheel', {
            ...init,
            clientX,
            clientY,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    [x, y, events] as const,
  );
}
