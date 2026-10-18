import { test as base, expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { Bar, SymbolInfo } from '@tradingnerd/core';

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

export interface MockMarket {
  /** History served by GET /api/bars. */
  bars: Bar[];
  /** Query of every /api/bars request, in order. */
  readonly barRequests: URLSearchParams[];
  /** How many WebSocket connections the page has opened. */
  connections(): number;
  /** Resolves with the id once the page has subscribed to a channel. */
  subscribed(channel: 'bars' | 'book'): Promise<string>;
  sendBar(bar: Bar, historical?: boolean): Promise<void>;
  sendBook(bid: number, ask: number): Promise<void>;
  /** Drops the page's WebSocket, like a gateway restart. */
  drop(): Promise<void>;
}

class MockGateway implements MockMarket {
  bars: Bar[] = makeBars();
  readonly barRequests: URLSearchParams[] = [];
  private readonly page: Page;
  private socket: WebSocketRoute | null = null;
  private openCount = 0;
  private readonly subscriptions = new Map<string, { channel: string }>();

  constructor(page: Page) {
    this.page = page;
  }

  async install(): Promise<void> {
    await this.page.clock.setFixedTime(NOW);
    await this.page.route(/\/api\/symbols\/resolve\?/, (route) => {
      const symbol = new URL(route.request().url()).searchParams.get('symbol');
      return symbol === XRP_INFO.id
        ? route.fulfill({ json: XRP_INFO })
        : route.fulfill({
            status: 404,
            json: { error: 'unknown_symbol', message: 'Binance does not list this symbol' },
          });
    });
    await this.page.route(/\/api\/bars\?/, (route) => {
      const params = new URL(route.request().url()).searchParams;
      this.barRequests.push(params);
      const to = params.get('to');
      const countBack = Number(params.get('countBack') ?? 300);
      const eligible = this.bars.filter((bar) => to === null || bar.time < Number(to));
      return route.fulfill({
        json: { bars: eligible.slice(-countBack), hasMore: eligible.length > countBack },
      });
    });
    await this.page.routeWebSocket(/\/ws$/, (socket) => this.accept(socket));
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

  async drop(): Promise<void> {
    this.subscriptions.clear();
    await this.socket?.close();
  }

  private accept(socket: WebSocketRoute): void {
    this.socket = socket;
    this.openCount++;
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, serverTime: NOW }));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; id: string; channel: string };
      if (message.type === 'subscribe') {
        this.subscriptions.set(message.id, { channel: message.channel });
        socket.send(JSON.stringify({ type: 'status', id: message.id, state: 'live' }));
        const last = this.bars.at(-1);
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

export const test = base.extend<{ market: MockMarket; consoleGuard: ConsoleGuard }>({
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
    async ({ page }, use) => {
      const gateway = new MockGateway(page);
      await gateway.install();
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
