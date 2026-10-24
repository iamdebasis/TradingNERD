import {
  type Bar,
  type ClientMessage,
  type ErrorCode,
  parseServerMessage,
  type SessionHours,
  type StreamState,
} from '@tradingnerd/core';
import { reconnectDelay } from './reconnect';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface StreamHandlers {
  /** `reconnecting` also fires when the connection to the gateway itself drops. */
  onState(state: StreamState): void;
  /** The subscription is over; the gateway has already dropped it. */
  onError(code: ErrorCode, message: string): void;
}

export interface BarHandlers extends StreamHandlers {
  onBar(bar: Bar, historical: boolean): void;
}

export interface BookHandlers extends StreamHandlers {
  onBook(bid: number, ask: number): void;
}

export interface QuoteHandlers extends StreamHandlers {
  /** `prevClose`: the previous daily close that Chg is measured against, or null if unknown. */
  onQuote(last: number, prevClose: number | null): void;
}

/** The live-data half of the gateway, as the chart session needs it. */
export interface LiveFeed {
  /** `session` as for MarketApi.getBars. */
  subscribeBars(
    symbol: string,
    resolution: string,
    handlers: BarHandlers,
    session?: SessionHours,
  ): () => void;
  subscribeBook(symbol: string, handlers: BookHandlers): () => void;
}

/** Live watchlist quotes, as the watchlist needs them. */
export interface QuoteSource {
  subscribeQuotes(symbol: string, handlers: QuoteHandlers): () => void;
}

type SubscribeMessage = Extract<ClientMessage, { type: 'subscribe' }>;

type Subscription =
  | { kind: 'bars'; request: SubscribeMessage; handlers: BarHandlers }
  | { kind: 'book'; request: SubscribeMessage; handlers: BookHandlers }
  | { kind: 'quotes'; request: SubscribeMessage; handlers: QuoteHandlers };

/**
 * The UI's single WebSocket to the local gateway. Subscriptions survive reconnects: they're
 * re-sent after every hello, and each one hears `reconnecting` while the link is down.
 */
export class GatewayConnection implements LiveFeed, QuoteSource {
  private readonly url: string;
  private readonly statusListeners = new Set<() => void>();
  private readonly subscriptions = new Map<string, Subscription>();
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'connecting';
  private nextId = 1;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private disposed = false;

  constructor(url: string) {
    this.url = url;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.subscriptions.clear();
    this.socket?.close();
    this.socket = null;
  }

  /** For useSyncExternalStore. */
  readonly getStatus = (): ConnectionStatus => this.status;

  /** For useSyncExternalStore. */
  readonly subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  subscribeBars(
    symbol: string,
    resolution: string,
    handlers: BarHandlers,
    session?: SessionHours,
  ): () => void {
    const id = this.newId();
    return this.add(id, {
      kind: 'bars',
      request: {
        type: 'subscribe',
        id,
        channel: 'bars',
        symbol,
        resolution,
        ...(session === 'extended' ? { session } : {}),
      },
      handlers,
    });
  }

  subscribeBook(symbol: string, handlers: BookHandlers): () => void {
    const id = this.newId();
    return this.add(id, {
      kind: 'book',
      request: { type: 'subscribe', id, channel: 'book', symbol },
      handlers,
    });
  }

  subscribeQuotes(symbol: string, handlers: QuoteHandlers): () => void {
    const id = this.newId();
    return this.add(id, {
      kind: 'quotes',
      request: { type: 'subscribe', id, channel: 'quotes', symbol },
      handlers,
    });
  }

  private newId(): string {
    return `s${this.nextId++}`;
  }

  private add(id: string, subscription: Subscription): () => void {
    this.subscriptions.set(id, subscription);
    this.send(subscription.request);
    return () => {
      if (this.subscriptions.delete(id)) this.send({ type: 'unsubscribe', id });
    };
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.disposed) return;
      this.socket = null;
      this.setStatus('disconnected');
      for (const subscription of this.subscriptions.values()) {
        subscription.handlers.onState('reconnecting');
      }
      this.timer = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    });
  }

  private onMessage(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'hello':
        this.attempt = 0;
        this.setStatus('connected');
        // First connection or a reconnect: (re)send every live subscription.
        for (const subscription of this.subscriptions.values()) this.send(subscription.request);
        return;
      case 'bar': {
        const subscription = this.subscriptions.get(message.id);
        if (subscription?.kind === 'bars')
          subscription.handlers.onBar(message.bar, message.historical);
        return;
      }
      case 'book': {
        const subscription = this.subscriptions.get(message.id);
        if (subscription?.kind === 'book') subscription.handlers.onBook(message.bid, message.ask);
        return;
      }
      case 'quote': {
        const subscription = this.subscriptions.get(message.id);
        if (subscription?.kind === 'quotes') {
          subscription.handlers.onQuote(message.last, message.prevClose);
        }
        return;
      }
      case 'status':
        this.subscriptions.get(message.id)?.handlers.onState(message.state);
        return;
      case 'error': {
        if (message.id === null) return;
        const subscription = this.subscriptions.get(message.id);
        if (!subscription) return;
        this.subscriptions.delete(message.id);
        subscription.handlers.onError(message.code, message.message);
        return;
      }
      case 'pong':
        return;
    }
  }

  /** Sends now if connected; otherwise subscriptions go out with the next hello. */
  private send(message: ClientMessage): void {
    if (this.status !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) listener();
  }
}

/** ws://host/ws for the page's own origin (the Vite dev server proxies it to the gateway). */
export function gatewaySocketUrl(location: Location, path: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${path}`;
}
