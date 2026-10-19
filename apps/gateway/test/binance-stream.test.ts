import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { BinanceStream } from '../src/exchanges/binance/BinanceStream.ts';
import type { FeedState } from '../src/market/types.ts';

interface Control {
  method: string;
  params: string[];
  id: number;
}

/** A stand-in for Binance's combined-stream endpoint. */
async function mockBinance(options: { autoPong?: boolean } = {}) {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    autoPong: options.autoPong ?? true,
  });
  await once(wss, 'listening');
  const connections: WebSocket[] = [];
  const control: Control[] = [];
  wss.on('connection', (socket) => {
    connections.push(socket);
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as Control;
      control.push(message);
      socket.send(JSON.stringify({ result: null, id: message.id }));
    });
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/stream`,
    connections,
    control,
    push(stream: string, data: unknown) {
      for (const socket of connections) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ stream, data }));
      }
    },
    dropAll() {
      for (const socket of connections) socket.terminate();
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(serverOptions: { autoPong?: boolean } = {}, streamOptions = {}) {
  const server = await mockBinance(serverOptions);
  const stream = new BinanceStream({
    url: server.url,
    controlIntervalMs: 20,
    reconnectDelayMs: () => 20,
    idleCloseMs: 60,
    pingIntervalMs: 60_000,
    ...streamOptions,
  });
  const states: FeedState[] = [];
  stream.onState((state) => states.push(state));
  cleanups.push(
    () => server.close(),
    () => stream.close(),
  );
  return { server, stream, states };
}

const subscribed = (control: Control[]) =>
  control.filter((c) => c.method === 'SUBSCRIBE').flatMap((c) => c.params);
const unsubscribed = (control: Control[]) =>
  control.filter((c) => c.method === 'UNSUBSCRIBE').flatMap((c) => c.params);

describe('BinanceStream', () => {
  it('connects on the first subscription, subscribes upstream and reports up', async () => {
    const { server, stream, states } = await setup();
    expect(stream.isUp()).toBe(false);
    stream.subscribe('xrpusdt@aggTrade', () => {});
    await vi.waitFor(() => expect(subscribed(server.control)).toEqual(['xrpusdt@aggTrade']));
    expect(states).toEqual(['up']);
    expect(stream.isUp()).toBe(true);
  });

  it('routes each message only to handlers of its stream', async () => {
    const { server, stream } = await setup();
    const trades: unknown[] = [];
    const books: unknown[] = [];
    stream.subscribe('xrpusdt@aggTrade', (data) => trades.push(data));
    stream.subscribe('xrpusdt@bookTicker', (data) => books.push(data));
    await vi.waitFor(() => expect(subscribed(server.control)).toHaveLength(2));
    server.push('xrpusdt@aggTrade', { p: '1' });
    await vi.waitFor(() => expect(trades).toEqual([{ p: '1' }]));
    expect(books).toEqual([]);
  });

  it('subscribes upstream once per stream and unsubscribes after the last handler leaves', async () => {
    const { server, stream } = await setup();
    const first = stream.subscribe('xrpusdt@aggTrade', () => {});
    const second = stream.subscribe('xrpusdt@aggTrade', () => {});
    await vi.waitFor(() => expect(subscribed(server.control)).toEqual(['xrpusdt@aggTrade']));
    first();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(unsubscribed(server.control)).toEqual([]);
    second();
    await vi.waitFor(() => expect(unsubscribed(server.control)).toEqual(['xrpusdt@aggTrade']));
  });

  it('batches subscriptions made in the same window into one message', async () => {
    const { server, stream } = await setup();
    stream.subscribe('a@aggTrade', () => {});
    await vi.waitFor(() => expect(server.control).toHaveLength(1));
    stream.subscribe('b@aggTrade', () => {});
    stream.subscribe('c@aggTrade', () => {});
    stream.subscribe('d@aggTrade', () => {});
    await vi.waitFor(() => expect(subscribed(server.control)).toHaveLength(4));
    expect(server.control).toHaveLength(2);
    expect(server.control[1]?.params).toEqual(['b@aggTrade', 'c@aggTrade', 'd@aggTrade']);
  });

  it('sends a subscription made after a pause at once, and the next one a window later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { server, stream } = await setup({}, { controlIntervalMs: 5_000 });
    stream.subscribe('a@aggTrade', () => {});
    await vi.waitFor(() => expect(server.control).toHaveLength(1));
    vi.setSystemTime(Date.now() + 6_000); // a pause longer than the window
    stream.subscribe('b@aggTrade', () => {});
    await vi.waitFor(() => expect(server.control).toHaveLength(2), { timeout: 1_000 });
    stream.subscribe('c@aggTrade', () => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.control).toHaveLength(2);
  });

  it("sends waiting subscribes before waiting unsubscribes: a new pair needn't wait", async () => {
    const { server, stream } = await setup();
    const old = stream.subscribe('a@aggTrade', () => {});
    await vi.waitFor(() => expect(server.control).toHaveLength(1));
    old();
    stream.subscribe('b@aggTrade', () => {});
    await vi.waitFor(() => expect(server.control).toHaveLength(3));
    expect(server.control.slice(1).map((c) => [c.method, c.params])).toEqual([
      ['SUBSCRIBE', ['b@aggTrade']],
      ['UNSUBSCRIBE', ['a@aggTrade']],
    ]);
  });

  it('never sends an UNSUBSCRIBE for a stream that was dropped before it was subscribed', async () => {
    const { server, stream } = await setup();
    stream.subscribe('a@aggTrade', () => {});
    await vi.waitFor(() => expect(server.control).toHaveLength(1));
    const quick = stream.subscribe('b@aggTrade', () => {});
    quick();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.control).toHaveLength(1);
  });

  it('reconnects after a drop and resubscribes every active stream', async () => {
    const { server, stream, states } = await setup();
    stream.subscribe('a@aggTrade', () => {});
    stream.subscribe('b@kline_1m', () => {});
    await vi.waitFor(() => expect(subscribed(server.control)).toHaveLength(2));
    server.dropAll();
    await vi.waitFor(() => expect(server.connections).toHaveLength(2));
    await vi.waitFor(() => expect(subscribed(server.control)).toHaveLength(4));
    expect(subscribed(server.control).slice(2).sort()).toEqual(['a@aggTrade', 'b@kline_1m']);
    expect(states).toEqual(['up', 'down', 'up']);
  });

  it('closes the connection when idle and does not reconnect', async () => {
    const { server, stream, states } = await setup();
    const unsubscribe = stream.subscribe('a@aggTrade', () => {});
    await vi.waitFor(() => expect(stream.isUp()).toBe(true));
    unsubscribe();
    await vi.waitFor(() => expect(states).toEqual(['up', 'down']));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.connections).toHaveLength(1);
  });

  it('drops and replaces a connection that stops answering pings', async () => {
    const { server, stream, states } = await setup(
      { autoPong: false },
      { pingIntervalMs: 30, pongTimeoutMs: 30 },
    );
    stream.subscribe('a@aggTrade', () => {});
    await vi.waitFor(() => expect(states).toEqual(['up', 'down', 'up']), { timeout: 2_000 });
    expect(server.connections.length).toBeGreaterThanOrEqual(2);
  });

  it('stops for good after close()', async () => {
    const { server, stream } = await setup();
    stream.subscribe('a@aggTrade', () => {});
    await vi.waitFor(() => expect(stream.isUp()).toBe(true));
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.connections).toHaveLength(1);
    expect(() => stream.subscribe('b@aggTrade', () => {})).toThrow(/closed/);
  });
});
