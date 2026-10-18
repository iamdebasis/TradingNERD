import WebSocket, { type RawData } from 'ws';
import type { FeedState, Unsubscribe } from '../../market/types.ts';

export interface BinanceStreamOptions {
  /** Combined-stream endpoint, e.g. wss://stream.binance.com:9443/stream */
  url: string;
  /** Wait before reconnect attempt n (0-based). */
  reconnectDelayMs?: (attempt: number) => number;
  /** Close the connection after this long with no subscriptions. */
  idleCloseMs?: number;
  /** How often to ping; the connection is dropped if no pong arrives within `pongTimeoutMs`. */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Gap between control messages; Binance allows 5 incoming messages per second. */
  controlIntervalMs?: number;
  /** Streams per SUBSCRIBE / UNSUBSCRIBE message. */
  maxStreamsPerMessage?: number;
  onWarning?: (message: string) => void;
}

type Handler = (data: unknown) => void;

/**
 * One multiplexed connection to Binance's combined-stream endpoint.
 *
 * Streams are reference-counted: the first handler subscribes upstream, the last one
 * unsubscribes. After any drop (including Binance's forced 24-hour disconnect) it reconnects
 * with backoff and resubscribes everything, then reports `up` again.
 */
export class BinanceStream {
  private readonly url: string;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly idleCloseMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly controlIntervalMs: number;
  private readonly maxStreamsPerMessage: number;
  private readonly warn: (message: string) => void;

  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly stateListeners = new Set<(state: FeedState) => void>();
  /** Streams to add or drop upstream at the next control window. */
  private readonly toSubscribe = new Set<string>();
  private readonly toUnsubscribe = new Set<string>();

  private socket: WebSocket | null = null;
  private connected = false;
  private shutDown = false;
  private attempt = 0;
  private nextRequestId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private controlTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BinanceStreamOptions) {
    this.url = options.url;
    this.reconnectDelayMs = options.reconnectDelayMs ?? ((n) => Math.min(500 * 2 ** n, 30_000));
    this.idleCloseMs = options.idleCloseMs ?? 30_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.controlIntervalMs = options.controlIntervalMs ?? 250;
    this.maxStreamsPerMessage = options.maxStreamsPerMessage ?? 200;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Listens to one stream, e.g. "xrpusdt@aggTrade". */
  subscribe(stream: string, handler: Handler): Unsubscribe {
    if (this.shutDown) throw new Error('BinanceStream has been closed');
    let set = this.handlers.get(stream);
    if (!set) {
      set = new Set();
      this.handlers.set(stream, set);
      // If an UNSUBSCRIBE is still queued, Binance never dropped the stream: just cancel it.
      if (!this.toUnsubscribe.delete(stream) && this.connected) this.toSubscribe.add(stream);
      this.scheduleControl();
    }
    set.add(handler);
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.ensureConnection();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.handlers.get(stream);
      if (!current?.delete(handler) || current.size > 0) return;
      this.handlers.delete(stream);
      // If the SUBSCRIBE was never sent, there's nothing to undo upstream.
      if (!this.toSubscribe.delete(stream) && this.connected) this.toUnsubscribe.add(stream);
      this.scheduleControl();
      if (this.handlers.size === 0) this.scheduleIdleClose();
    };
  }

  isUp(): boolean {
    return this.connected;
  }

  onState(listener: (state: FeedState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Active upstream streams; exposed for tests and diagnostics. */
  streams(): string[] {
    return [...this.handlers.keys()];
  }

  async close(): Promise<void> {
    this.shutDown = true;
    this.handlers.clear();
    for (const timer of [this.reconnectTimer, this.controlTimer, this.idleTimer, this.pongTimer]) {
      clearTimeout(timer);
    }
    clearInterval(this.pingTimer);
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.terminate();
    });
  }

  private ensureConnection(): void {
    if (this.socket || this.reconnectTimer || this.shutDown) return;
    this.connect();
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on('open', () => {
      this.connected = true;
      this.attempt = 0;
      this.toUnsubscribe.clear();
      this.toSubscribe.clear();
      for (const stream of this.handlers.keys()) this.toSubscribe.add(stream);
      this.sendControl();
      this.startHeartbeat(socket);
      this.emitState('up');
    });
    socket.on('message', (raw) => this.onMessage(raw));
    socket.on('pong', () => {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    });
    socket.on('error', (error) => this.warn(`Binance stream error: ${error.message}`));
    socket.on('close', () => this.onClose(socket));
  }

  private onClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    const wasConnected = this.connected;
    this.socket = null;
    this.connected = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    clearTimeout(this.controlTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
    this.controlTimer = undefined;
    if (wasConnected) this.emitState('down');
    if (this.shutDown || this.handlers.size === 0) return;
    const delay = this.reconnectDelayMs(this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.shutDown && this.handlers.size > 0) this.connect();
    }, delay);
  }

  private onMessage(raw: RawData): void {
    let message: unknown;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.warn('Binance stream sent a message that is not JSON');
      return;
    }
    if (typeof message !== 'object' || message === null) return;
    const { stream, data, error } = message as {
      stream?: unknown;
      data?: unknown;
      error?: unknown;
    };
    if (typeof stream === 'string') {
      const set = this.handlers.get(stream);
      if (set) for (const handler of [...set]) handler(data);
      return;
    }
    if (error !== undefined) this.warn(`Binance rejected a request: ${JSON.stringify(error)}`);
  }

  private scheduleControl(): void {
    if (this.controlTimer || !this.connected) return;
    if (this.toSubscribe.size === 0 && this.toUnsubscribe.size === 0) return;
    this.controlTimer = setTimeout(() => {
      this.controlTimer = undefined;
      this.sendControl();
    }, this.controlIntervalMs);
  }

  /** Sends one SUBSCRIBE or UNSUBSCRIBE batch; anything left waits for the next window. */
  private sendControl(): void {
    if (!this.socket || !this.connected) return;
    const [method, queue] =
      this.toUnsubscribe.size > 0
        ? (['UNSUBSCRIBE', this.toUnsubscribe] as const)
        : (['SUBSCRIBE', this.toSubscribe] as const);
    const params = [...queue].slice(0, this.maxStreamsPerMessage);
    if (params.length > 0) {
      for (const stream of params) queue.delete(stream);
      this.socket.send(JSON.stringify({ method, params, id: this.nextRequestId++ }));
    }
    this.scheduleControl();
  }

  private startHeartbeat(socket: WebSocket): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.pongTimer) return; // still waiting for the previous pong
      socket.ping();
      this.pongTimer = setTimeout(() => {
        this.warn('Binance stream stopped answering pings; reconnecting');
        socket.terminate();
      }, this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  private scheduleIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.handlers.size === 0) this.socket?.close();
    }, this.idleCloseMs);
  }

  private emitState(state: FeedState): void {
    for (const listener of [...this.stateListeners]) listener(state);
  }
}
