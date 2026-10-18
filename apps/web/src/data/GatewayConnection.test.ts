import { PROTOCOL_VERSION } from '@tradingnerd/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BarHandlers, GatewayConnection } from './GatewayConnection';

type Listener = (event: { data?: unknown }) => void;

/** A WebSocket stand-in driven by the test. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.drop();
  }

  // ---- test controls ----
  open() {
    this.readyState = 1;
  }

  receive(message: unknown) {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(message) });
    }
  }

  hello() {
    this.open();
    this.receive({ type: 'hello', protocolVersion: PROTOCOL_VERSION, serverTime: 0 });
  }

  drop() {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) listener({});
  }
}

const latestSocket = () => {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error('no socket');
  return socket;
};

function barHandlers() {
  const events: string[] = [];
  const handlers: BarHandlers = {
    onBar: (bar, historical) =>
      events.push(`bar ${bar.time} ${bar.close}${historical ? ' h' : ''}`),
    onState: (state) => events.push(`state ${state}`),
    onError: (code) => events.push(`error ${code}`),
  };
  return { handlers, events };
}

const bar = { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GatewayConnection', () => {
  it('waits for hello, then sends every pending subscription', () => {
    const gateway = new GatewayConnection('ws://test/ws');
    gateway.start();
    gateway.subscribeBars('BINANCE:XRPUSDT', '1D', barHandlers().handlers);
    expect(latestSocket().sent).toEqual([]);
    expect(gateway.getStatus()).toBe('connecting');

    latestSocket().hello();
    expect(gateway.getStatus()).toBe('connected');
    expect(latestSocket().sent).toEqual([
      { type: 'subscribe', id: 's1', channel: 'bars', symbol: 'BINANCE:XRPUSDT', resolution: '1D' },
    ]);
  });

  it('sends new subscriptions immediately once connected', () => {
    const gateway = new GatewayConnection('ws://test/ws');
    gateway.start();
    latestSocket().hello();
    gateway.subscribeBook('BINANCE:XRPUSDT', {
      onBook: () => {},
      onState: () => {},
      onError: () => {},
    });
    expect(latestSocket().sent).toEqual([
      { type: 'subscribe', id: 's1', channel: 'book', symbol: 'BINANCE:XRPUSDT' },
    ]);
  });

  it('routes messages to the right subscription', () => {
    const gateway = new GatewayConnection('ws://test/ws');
    gateway.start();
    const bars = barHandlers();
    const books: string[] = [];
    gateway.subscribeBars('BINANCE:XRPUSDT', '1D', bars.handlers);
    gateway.subscribeBook('BINANCE:XRPUSDT', {
      onBook: (bid, ask) => books.push(`${bid}/${ask}`),
      onState: () => {},
      onError: () => {},
    });
    const socket = latestSocket();
    socket.hello();
    socket.receive({ type: 'status', id: 's1', state: 'live' });
    socket.receive({ type: 'bar', id: 's1', bar, historical: false });
    socket.receive({ type: 'bar', id: 's1', bar: { ...bar, time: 50 }, historical: true });
    socket.receive({ type: 'book', id: 's2', bid: 1.2955, ask: 1.2956 });
    socket.receive({ type: 'bar', id: 's2', bar, historical: false }); // wrong kind: ignored
    socket.receive({ type: 'bar', id: 'zzz', bar, historical: false }); // unknown id: ignored
    socket.receive('garbage');
    expect(bars.events).toEqual(['state live', 'bar 100 1.5', 'bar 50 1.5 h']);
    expect(books).toEqual(['1.2955/1.2956']);
  });

  it('ends a subscription on its error and forgets it', () => {
    const gateway = new GatewayConnection('ws://test/ws');
    gateway.start();
    const { handlers, events } = barHandlers();
    gateway.subscribeBars('BINANCE:NOPE', '1D', handlers);
    const socket = latestSocket();
    socket.hello();
    socket.receive({ type: 'error', id: 's1', code: 'unknown_symbol', message: 'Not listed' });
    socket.receive({ type: 'bar', id: 's1', bar, historical: false });
    expect(events).toEqual(['error unknown_symbol']);
  });

  it('unsubscribes once', () => {
    const gateway = new GatewayConnection('ws://test/ws');
    gateway.start();
    latestSocket().hello();
    const unsubscribe = gateway.subscribeBars('BINANCE:XRPUSDT', '1D', barHandlers().handlers);
    unsubscribe();
    unsubscribe();
    expect(latestSocket().sent.slice(1)).toEqual([{ type: 'unsubscribe', id: 's1' }]);
  });

  it('reconnects with backoff and resubscribes after a drop', () => {
    vi.useFakeTimers();
    const gateway = new GatewayConnection('ws://test/ws');
    const statuses: string[] = [];
    gateway.subscribeStatus(() => statuses.push(gateway.getStatus()));
    gateway.start();
    const { handlers, events } = barHandlers();
    gateway.subscribeBars('BINANCE:XRPUSDT', '1D', handlers);
    latestSocket().hello();

    latestSocket().drop();
    expect(statuses).toEqual(['connected', 'disconnected']);
    expect(events).toEqual(['state reconnecting']);
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    latestSocket().hello();
    expect(statuses.at(-1)).toBe('connected');
    expect(latestSocket().sent).toEqual([
      { type: 'subscribe', id: 's1', channel: 'bars', symbol: 'BINANCE:XRPUSDT', resolution: '1D' },
    ]);
  });

  it('stops for good when disposed', () => {
    vi.useFakeTimers();
    const gateway = new GatewayConnection('ws://test/ws');
    gateway.start();
    latestSocket().hello();
    gateway.dispose();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
