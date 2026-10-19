import WebSocket, { type RawData } from 'ws';
import type { FeedState, Unsubscribe } from '../market/types.ts';

/** One update for one topic, from a frame the exchange sent. */
export interface StreamUpdate {
  topic: string;
  data: unknown;
}

/**
 * How one exchange's WebSocket API speaks. Topics are the client's own keys ("kline.1.XRPUSDT",
 * "trades:XRP-USDT"); the protocol turns them into subscribe messages and routes what comes
 * back to them.
 */
export interface StreamProtocol {
  /** For warnings: "Bybit". */
  readonly name: string;
  /** Most topics handed to `subscribe` or `unsubscribe` at once. */
  readonly maxTopicsPerMessage: number;
  /** Text frames that start (or stop) updates for these topics. */
  subscribe(topics: readonly string[], requestId: number): string[];
  unsubscribe(topics: readonly string[], requestId: number): string[];
  /** The updates a frame carries, one per topic; none for replies, pongs and heartbeats. */
  route(text: string, warn: (message: string) => void): StreamUpdate[];
  /** The keep-alive text the exchange wants; null to use WebSocket ping frames. */
  readonly pingMessage: string | null;
  /** Frames to send as soon as a connection opens (e.g. a heartbeat channel). */
  onOpen?(): string[];
}

export interface StreamClientOptions {
  url: string;
  /** Wait before reconnect attempt n (0-based). */
  reconnectDelayMs?: (attempt: number) => number;
  /** Close the connection after this long with no subscriptions (10 min: coming back is instant). */
  idleCloseMs?: number;
  /** How often to ping; with nothing received for `pongTimeoutMs` after, the link is dropped. */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Least gap between subscribe and unsubscribe messages; the first after a pause goes at once. */
  controlIntervalMs?: number;
  onWarning?: (message: string) => void;
}

type Handler = (data: unknown) => void;

/**
 * One multiplexed WebSocket connection to an exchange.
 *
 * Topics are reference-counted: the first handler subscribes upstream, the last one
 * unsubscribes. After any drop it reconnects with backoff and resubscribes everything, then
 * reports `up` again. A ping goes out regularly, and a link that then stays silent is replaced.
 */
export class StreamClient {
  protected readonly protocol: StreamProtocol;
  private readonly url: string;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly idleCloseMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly controlIntervalMs: number;
  private readonly warn: (message: string) => void;

  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly stateListeners = new Set<(state: FeedState) => void>();
  /** Topics to add or drop upstream at the next control window. */
  private readonly toSubscribe = new Set<string>();
  private readonly toUnsubscribe = new Set<string>();

  private socket: WebSocket | null = null;
  private connected = false;
  private shutDown = false;
  private attempt = 0;
  private nextRequestId = 1;
  /** When the last subscribe or unsubscribe message went out. */
  private lastControlAt = Number.NEGATIVE_INFINITY;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private controlTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(protocol: StreamProtocol, options: StreamClientOptions) {
    this.protocol = protocol;
    this.url = options.url;
    this.reconnectDelayMs = options.reconnectDelayMs ?? ((n) => Math.min(500 * 2 ** n, 30_000));
    this.idleCloseMs = options.idleCloseMs ?? 600_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 20_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.controlIntervalMs = options.controlIntervalMs ?? 250;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Listens to one topic until the returned function is called. */
  subscribe(topic: string, handler: Handler): Unsubscribe {
    if (this.shutDown) throw new Error(`${this.protocol.name} stream has been closed`);
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
      // If an unsubscribe is still queued, the exchange never dropped the topic: just cancel it.
      if (!this.toUnsubscribe.delete(topic) && this.connected) this.toSubscribe.add(topic);
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
      const current = this.handlers.get(topic);
      if (!current?.delete(handler) || current.size > 0) return;
      this.handlers.delete(topic);
      // If the subscribe was never sent, there's nothing to undo upstream.
      if (!this.toSubscribe.delete(topic) && this.connected) this.toUnsubscribe.add(topic);
      this.scheduleControl();
      if (this.handlers.size === 0) this.scheduleIdleClose();
    };
  }

  isUp(): boolean {
    return this.connected;
  }

  /** Whether any topic is subscribed: an idle client's `down` is no outage. */
  isInUse(): boolean {
    return this.handlers.size > 0;
  }

  onState(listener: (state: FeedState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Active topics; exposed for tests and diagnostics. */
  topics(): string[] {
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
      for (const frame of this.protocol.onOpen?.() ?? []) socket.send(frame);
      for (const topic of this.handlers.keys()) this.toSubscribe.add(topic);
      this.sendControl();
      this.startHeartbeat(socket);
      this.emitState('up');
    });
    socket.on('message', (raw) => this.onMessage(raw));
    socket.on('pong', () => this.alive());
    socket.on('error', (error) =>
      this.warn(`${this.protocol.name} stream error: ${error.message}`),
    );
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
    this.alive();
    for (const { topic, data } of this.protocol.route(raw.toString(), this.warn)) {
      const set = this.handlers.get(topic);
      if (set) for (const handler of [...set]) handler(data);
    }
  }

  /** Anything from the exchange shows the link works. */
  private alive(): void {
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
  }

  /**
   * The first change after a pause goes out at once (with the others made in the same turn);
   * later ones wait for the window, so the exchange sees at most one message per window.
   */
  private scheduleControl(): void {
    if (this.controlTimer || !this.connected) return;
    if (this.toSubscribe.size === 0 && this.toUnsubscribe.size === 0) return;
    const wait = Math.max(0, this.lastControlAt + this.controlIntervalMs - Date.now());
    this.controlTimer = setTimeout(() => {
      this.controlTimer = undefined;
      this.sendControl();
    }, wait);
  }

  /**
   * Sends one subscribe or unsubscribe batch; anything left waits for the next window.
   * Subscribes go first: on a switch between two pairs, the new one's data shouldn't wait.
   */
  private sendControl(): void {
    if (!this.socket || !this.connected) return;
    const unsubscribing = this.toSubscribe.size === 0;
    const queue = unsubscribing ? this.toUnsubscribe : this.toSubscribe;
    const topics = [...queue].slice(0, this.protocol.maxTopicsPerMessage);
    if (topics.length > 0) {
      for (const topic of topics) queue.delete(topic);
      const id = this.nextRequestId++;
      const frames = unsubscribing
        ? this.protocol.unsubscribe(topics, id)
        : this.protocol.subscribe(topics, id);
      for (const frame of frames) this.socket.send(frame);
      this.lastControlAt = Date.now();
    }
    this.scheduleControl();
  }

  private startHeartbeat(socket: WebSocket): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.pongTimer) return; // still waiting to hear back
      if (this.protocol.pingMessage === null) socket.ping();
      else socket.send(this.protocol.pingMessage);
      this.pongTimer = setTimeout(() => {
        this.warn(`${this.protocol.name} stream went silent; reconnecting`);
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
    this.idleTimer.unref?.(); // an idle link never keeps the process running
  }

  private emitState(state: FeedState): void {
    for (const listener of [...this.stateListeners]) listener(state);
  }
}

/** Parses a text frame as a JSON object; null (with a warning) for anything else. */
export function parseFrame(
  text: string,
  exchange: string,
  warn: (message: string) => void,
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    warn(`${exchange} stream sent a message that is not JSON`);
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
