import { afterEach, describe, expect, it } from 'vitest';
import type { BookTop, Trade } from '../src/market/types.ts';
import { AlpacaStream, countsInBars } from '../src/stocks/AlpacaStream.ts';
import { type MockStreamServer, mockStreamServer } from './helpers/MockStreamServer.ts';

const KEY = { keyId: 'PKTESTKEYID123456789', secret: 'testsecret0000000000000000000000000000000' };

interface Frame {
  action?: string;
  trades?: string[];
  quotes?: string[];
}

/** Alpaca's stream as the free plan meets it: greets, signs in, confirms subscriptions. */
async function alpacaServer(answer: (frame: Frame) => unknown = () => undefined) {
  const subscribed = { trades: new Set<string>(), quotes: new Set<string>() };
  const server = await mockStreamServer(
    (raw, send) => {
      const frame = raw as Frame;
      const custom = answer(frame);
      if (custom !== undefined) {
        send(custom);
        return;
      }
      if (frame.action === 'auth') send([{ T: 'success', msg: 'authenticated' }]);
      if (frame.action === 'subscribe' || frame.action === 'unsubscribe') {
        for (const kind of ['trades', 'quotes'] as const) {
          for (const symbol of frame[kind] ?? []) {
            if (frame.action === 'subscribe') subscribed[kind].add(symbol);
            else subscribed[kind].delete(symbol);
          }
        }
        send([
          {
            T: 'subscription',
            trades: [...subscribed.trades],
            quotes: [...subscribed.quotes],
            bars: [],
          },
        ]);
      }
    },
    [{ T: 'success', msg: 'connected' }],
  );
  return { server, subscribed };
}

const servers: MockStreamServer[] = [];
const streams: AlpacaStream[] = [];

function stream(server: MockStreamServer, options: Partial<{ maxSymbols: number }> = {}) {
  const warnings: string[] = [];
  const created = new AlpacaStream({
    url: server.url,
    key: async () => KEY,
    sip: () => 'delayed',
    reconnectDelayMs: () => 20,
    retryAfterRefusalMs: 100,
    ...options,
    onWarning: (message) => warnings.push(message),
  });
  streams.push(created);
  return { stream: created, warnings };
}

const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const trade = (symbol: string, price: number, conditions = ['@'], tape = 'C') => ({
  T: 't',
  S: symbol,
  i: 1,
  x: 'V',
  p: price,
  s: 100,
  c: conditions,
  t: '2026-10-19T14:30:05.123456789Z',
  z: tape,
});

afterEach(async () => {
  for (const created of streams.splice(0)) created.close();
  for (const server of servers.splice(0)) await server.close();
});

describe("Alpaca's stream", () => {
  it('signs in, then streams the delayed feed of what is wanted', async () => {
    const { server, subscribed } = await alpacaServer();
    servers.push(server);
    const { stream: alpaca } = stream(server);
    const trades: Trade[] = [];
    alpaca.subscribeTrades('AAPL', (t) => trades.push(t));
    await until(() => subscribed.trades.has('AAPL'));
    expect(server.paths).toEqual(['/v2/delayed_sip']);
    expect(server.received[0]).toEqual({ action: 'auth', key: KEY.keyId, secret: KEY.secret });

    server.push([trade('AAPL', 231.45), trade('MSFT', 10)]);
    await until(() => trades.length === 1);
    expect(trades[0]).toEqual({
      price: 231.45,
      quantity: 100,
      time: Date.parse('2026-10-19T14:30:05.123Z'),
    });
  });

  it("leaves out trades Alpaca's bars leave out", async () => {
    const { server, subscribed } = await alpacaServer();
    servers.push(server);
    const { stream: alpaca } = stream(server);
    const prices: number[] = [];
    alpaca.subscribeTrades('AAPL', (t) => prices.push(t.price));
    await until(() => subscribed.trades.has('AAPL'));
    server.push([
      trade('AAPL', 1, ['@', 'I']), // an odd lot
      trade('AAPL', 2, ['@', 'W'], 'C'), // average price, tape C
      trade('AAPL', 3, ['@', 'W'], 'A'), // W is no average price on tape A
      trade('AAPL', 4, ['@', 'T']), // pre- or post-market
      trade('AAPL', 5, ['@', 'F']), // an intermarket sweep
    ]);
    await until(() => prices.length === 3);
    expect(prices).toEqual([3, 4, 5]);
    expect(countsInBars(['B'], 'A')).toBe(false);
    expect(countsInBars(['B'], 'C')).toBe(true);
  });

  it('gives quotes as the best bid and ask, skipping an empty side', async () => {
    const { server, subscribed } = await alpacaServer();
    servers.push(server);
    const { stream: alpaca } = stream(server);
    const tops: BookTop[] = [];
    alpaca.subscribeQuotes('AAPL', (top) => tops.push(top));
    await until(() => subscribed.quotes.has('AAPL'));
    server.push([
      { T: 'q', S: 'AAPL', bp: 0, ap: 231.5, t: '2026-10-19T14:30:05Z' },
      { T: 'q', S: 'AAPL', bp: 231.4, ap: 231.5, t: '2026-10-19T14:30:06Z' },
    ]);
    await until(() => tops.length === 1);
    expect(tops).toEqual([{ bid: 231.4, ask: 231.5 }]);
  });

  it("streams at most the plan's symbols: a chart's first, then by age", async () => {
    const { server, subscribed } = await alpacaServer();
    servers.push(server);
    const { stream: alpaca } = stream(server, { maxSymbols: 2 });
    alpaca.subscribeTrades('SPY', () => {});
    alpaca.subscribeTrades('QQQ', () => {});
    await until(() => subscribed.trades.size === 2);
    // A chart opens AAPL (trades and quotes): it takes QQQ's place.
    alpaca.subscribeTrades('AAPL', () => {});
    alpaca.subscribeQuotes('AAPL', () => {});
    await until(() => subscribed.trades.has('AAPL') && !subscribed.trades.has('QQQ'));
    expect([...subscribed.trades].sort()).toEqual(['AAPL', 'SPY']);
    expect([...subscribed.quotes]).toEqual(['AAPL']);
  });

  it('stops streaming a symbol nobody wants', async () => {
    const { server, subscribed } = await alpacaServer();
    servers.push(server);
    const { stream: alpaca } = stream(server);
    const stop = alpaca.subscribeTrades('AAPL', () => {});
    await until(() => subscribed.trades.has('AAPL'));
    stop();
    await until(() => !subscribed.trades.has('AAPL'));
  });

  it('waits and tries again while another app holds the connection', async () => {
    let refuse = true;
    const { server, subscribed } = await alpacaServer((frame) =>
      frame.action === 'auth' && refuse
        ? [{ T: 'error', code: 406, msg: 'connection limit exceeded' }]
        : undefined,
    );
    servers.push(server);
    const { stream: alpaca, warnings } = stream(server);
    alpaca.subscribeTrades('AAPL', () => {});
    await until(() => warnings.some((w) => w.includes('another app')));
    refuse = false;
    await until(() => subscribed.trades.has('AAPL'));
    expect(server.paths.length).toBeGreaterThanOrEqual(2);
  });

  it('stops after a refused key, until a new one', async () => {
    let refuse = true;
    const { server, subscribed } = await alpacaServer((frame) =>
      frame.action === 'auth' && refuse
        ? [{ T: 'error', code: 402, msg: 'auth failed' }]
        : undefined,
    );
    servers.push(server);
    const { stream: alpaca, warnings } = stream(server);
    alpaca.subscribeTrades('AAPL', () => {});
    await until(() => warnings.some((w) => w.includes('refused the key')));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.paths).toHaveLength(1);
    refuse = false;
    alpaca.restart();
    await until(() => subscribed.trades.has('AAPL'));
  });

  it('keeps to the symbols Alpaca took after a symbol-limit refusal', async () => {
    const { server, subscribed } = await alpacaServer((frame) =>
      frame.action === 'subscribe' && (frame.trades?.length ?? 0) + subscribedCount() > 1
        ? [{ T: 'error', code: 405, msg: 'symbol limit exceeded' }]
        : undefined,
    );
    function subscribedCount() {
      return subscribed.trades.size;
    }
    servers.push(server);
    const { stream: alpaca, warnings } = stream(server, { maxSymbols: 5 });
    alpaca.subscribeTrades('SPY', () => {});
    await until(() => subscribed.trades.has('SPY'));
    alpaca.subscribeTrades('QQQ', () => {});
    await until(() => warnings.some((w) => w.includes('at most 1 symbols')));
    expect([...subscribed.trades]).toEqual(['SPY']);
    expect(alpaca.streaming().trades).toEqual(['SPY']);
  });
});
