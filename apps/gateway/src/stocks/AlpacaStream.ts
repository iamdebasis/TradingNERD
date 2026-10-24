import type { SipAccess } from '@tradingnerd/core';
import WebSocket, { type RawData } from 'ws';
import type { BookTop, Trade, Unsubscribe } from '../market/types.ts';
import type { AlpacaKey } from './alpaca.ts';

/** Alpaca's market data stream; the free plan's feed is the whole market 15 minutes late. */
export const ALPACA_STREAM_URL = 'wss://stream.data.alpaca.markets';
/** Symbols a free plan may stream at once (trades and quotes together). */
export const FREE_PLAN_SYMBOLS = 30;

/**
 * Trades that don't count toward a bar's price, by Alpaca's own rules for its bars (its "Stock
 * Minute Bars" article, after the SIPs' CTS and UTP specifications): average-price trades (B on
 * tapes A and B, W on tape C), odd lots (I), and the trades every tape leaves out: derivatively
 * priced, qualified contingent, corrected closes, cash, bunched sold, opening and closing
 * prints, next day, prior reference price, market center opens and closes, seller,
 * extended-hours sold out of sequence, stopped and sold out of sequence. Form T trades count
 * outside regular hours: they are the pre- and post-market's trades.
 */
const NOT_IN_BARS = new Set([
  '4',
  '7',
  '9',
  'C',
  'G',
  'H',
  'I',
  'M',
  'N',
  'P',
  'Q',
  'R',
  'U',
  'V',
  'Z',
]);

/** Whether a trade with these conditions, on this tape, moves a bar's price. */
export function countsInBars(conditions: readonly string[], tape: string): boolean {
  for (const condition of conditions) {
    if (NOT_IN_BARS.has(condition)) return false;
    if (condition === 'B' && tape !== 'C') return false;
    if (condition === 'W' && tape === 'C') return false;
  }
  return true;
}

export interface AlpacaStreamOptions {
  /** Where the stream is: Alpaca's, or a stand-in for tests. */
  url?: string | undefined;
  /** The user's key, read at each connection. */
  key: () => Promise<AlpacaKey | null>;
  /** The key's plan: the free one streams the delayed feed. */
  sip: () => SipAccess | null;
  /** Symbols streamed at once; the rest stay on minute bars. */
  maxSymbols?: number;
  reconnectDelayMs?: (attempt: number) => number;
  /** After an Alpaca error that won't pass by itself soon (another app on the key), wait this. */
  retryAfterRefusalMs?: number;
  /** With nothing to stream for this long, the connection closes. */
  idleCloseMs?: number;
  onWarning?: (message: string) => void;
}

interface SymbolWanted {
  trades: Set<(trade: Trade) => void>;
  quotes: Set<(top: BookTop) => void>;
  /** When it was first asked for: earlier symbols keep their place in the stream. */
  since: number;
}

type Upstream = { trades: Set<string>; quotes: Set<string> };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const copy = (upstream: Upstream): Upstream => ({
  trades: new Set(upstream.trades),
  quotes: new Set(upstream.quotes),
});

/**
 * Trades and quotes of US stocks from Alpaca's stream, on the user's key: the free plan's feed
 * is the whole market 15 minutes late, like its bars. One connection (all the free plan has),
 * at most 30 symbols on it: a chart's symbols first (they also want quotes, for the legend's
 * Sell and Buy), then the watchlist's in the order they came; the others keep their minute
 * bars. It connects when something is wanted, signs in, keeps Alpaca's subscriptions to what
 * is wanted, and reconnects after a drop.
 */
export class AlpacaStream {
  private readonly url: string;
  private readonly key: () => Promise<AlpacaKey | null>;
  private readonly sip: () => SipAccess | null;
  private maxSymbols: number;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly retryAfterRefusalMs: number;
  private readonly idleCloseMs: number;
  private readonly warn: (message: string) => void;
  private readonly wanted = new Map<string, SymbolWanted>();
  /** What was asked of Alpaca, and what its last subscription message confirmed. */
  private upstream: Upstream = { trades: new Set(), quotes: new Set() };
  private confirmed: Upstream = { trades: new Set(), quotes: new Set() };
  private socket: WebSocket | null = null;
  private ready = false;
  private attempt = 0;
  private order = 0;
  /** Not until the key changes (it was refused). */
  private stopped = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AlpacaStreamOptions) {
    this.url = options.url ?? ALPACA_STREAM_URL;
    this.key = options.key;
    this.sip = options.sip;
    this.maxSymbols = options.maxSymbols ?? FREE_PLAN_SYMBOLS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? ((n) => Math.min(1_000 * 2 ** n, 60_000));
    this.retryAfterRefusalMs = options.retryAfterRefusalMs ?? 5 * 60_000;
    this.idleCloseMs = options.idleCloseMs ?? 60_000;
    this.warn = options.onWarning ?? (() => {});
  }

  /** Trades of `symbol` (Alpaca's name for it) that count toward bars. */
  subscribeTrades(symbol: string, onTrade: (trade: Trade) => void): Unsubscribe {
    return this.want(symbol, (entry) => {
      entry.trades.add(onTrade);
      return () => entry.trades.delete(onTrade);
    });
  }

  /** The best bid and ask of `symbol` across the market. */
  subscribeQuotes(symbol: string, onQuote: (top: BookTop) => void): Unsubscribe {
    return this.want(symbol, (entry) => {
      entry.quotes.add(onQuote);
      return () => entry.quotes.delete(onQuote);
    });
  }

  /** What's streamed now: for diagnostics and tests. */
  streaming(): { connected: boolean; trades: string[]; quotes: string[] } {
    return {
      connected: this.ready,
      trades: [...this.upstream.trades],
      quotes: [...this.upstream.quotes],
    };
  }

  /** A new key or plan: sign in again (or stop, without a key). */
  restart(): void {
    this.stopped = false;
    this.attempt = 0;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.drop();
    if (this.wanted.size > 0) this.connect();
  }

  close(): void {
    this.closed = true;
    this.wanted.clear();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    this.drop();
  }

  /** Adds a listener to `symbol` with `attach`, which returns how to take it off again. */
  private want(symbol: string, attach: (entry: SymbolWanted) => () => void): Unsubscribe {
    let entry = this.wanted.get(symbol);
    if (!entry) {
      entry = { trades: new Set(), quotes: new Set(), since: this.order++ };
      this.wanted.set(symbol, entry);
    }
    const detach = attach(entry);
    const added = entry;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.socket && !this.reconnectTimer) this.connect();
    else this.sync();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      detach();
      if (this.wanted.get(symbol) !== added) return;
      if (added.trades.size === 0 && added.quotes.size === 0) this.wanted.delete(symbol);
      this.sync();
      if (this.wanted.size === 0) this.scheduleIdleClose();
    };
  }

  /** The symbols to stream: those with quote listeners (charts) first, then by age. */
  private desired(): Upstream {
    const symbols = [...this.wanted.entries()]
      .sort(
        ([, a], [, b]) =>
          Number(b.quotes.size > 0) - Number(a.quotes.size > 0) || a.since - b.since,
      )
      .slice(0, this.maxSymbols);
    const desired: Upstream = { trades: new Set(), quotes: new Set() };
    for (const [symbol, entry] of symbols) {
      if (entry.trades.size > 0) desired.trades.add(symbol);
      if (entry.quotes.size > 0) desired.quotes.add(symbol);
    }
    return desired;
  }

  /** Brings Alpaca's subscriptions in line with what's wanted: drops first, then adds. */
  private sync(): void {
    if (!this.ready || !this.socket) return;
    const desired = this.desired();
    const drop = {
      trades: [...this.upstream.trades].filter((symbol) => !desired.trades.has(symbol)),
      quotes: [...this.upstream.quotes].filter((symbol) => !desired.quotes.has(symbol)),
    };
    const add = {
      trades: [...desired.trades].filter((symbol) => !this.upstream.trades.has(symbol)),
      quotes: [...desired.quotes].filter((symbol) => !this.upstream.quotes.has(symbol)),
    };
    if (drop.trades.length > 0 || drop.quotes.length > 0) {
      this.send({ action: 'unsubscribe', ...drop });
    }
    if (add.trades.length > 0 || add.quotes.length > 0) {
      this.send({ action: 'subscribe', ...add });
    }
    // Alpaca's subscription message confirms; until then, what was asked for stands.
    this.upstream = desired;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.stopped || this.socket) return;
    const key = await this.key();
    if (!key || this.closed || this.socket) return;
    const feed = this.sip() === 'realtime' ? 'sip' : 'delayed_sip';
    const socket = new WebSocket(`${this.url}/v2/${feed}`);
    this.socket = socket;
    this.ready = false;
    socket.on('open', () => this.startHeartbeat(socket));
    socket.on('message', (raw) => this.onMessage(socket, raw, key));
    socket.on('pong', () => {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    });
    socket.on('error', (error) => this.warn(`Alpaca stream error: ${error.message}`));
    socket.on('close', () => this.onClose(socket));
  }

  private onMessage(socket: WebSocket, raw: RawData, key: AlpacaKey): void {
    if (socket !== this.socket) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    let messages: unknown;
    try {
      messages = JSON.parse(raw.toString());
    } catch {
      this.warn('Alpaca stream sent a message that is not JSON');
      return;
    }
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      if (!isObject(message)) continue;
      switch (message.T) {
        case 't':
          this.onTrade(message);
          break;
        case 'q':
          this.onQuote(message);
          break;
        case 'success':
          if (message.msg === 'connected') {
            socket.send(JSON.stringify({ action: 'auth', key: key.keyId, secret: key.secret }));
          } else if (message.msg === 'authenticated') {
            this.ready = true;
            this.attempt = 0;
            this.upstream = { trades: new Set(), quotes: new Set() };
            this.confirmed = { trades: new Set(), quotes: new Set() };
            this.sync();
          }
          break;
        case 'subscription':
          // Alpaca's word on everything subscribed now.
          this.confirmed = {
            trades: new Set(Array.isArray(message.trades) ? message.trades.map(String) : []),
            quotes: new Set(Array.isArray(message.quotes) ? message.quotes.map(String) : []),
          };
          this.upstream = copy(this.confirmed);
          break;
        case 'error':
          this.onError(Number(message.code), String(message.msg ?? ''));
          break;
      }
    }
  }

  private onTrade(message: Record<string, unknown>): void {
    const { S: symbol, p: price, s: size, t: at, c: conditions, z: tape } = message;
    if (typeof symbol !== 'string' || typeof price !== 'number' || typeof size !== 'number') return;
    const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(time) || !(price > 0)) return;
    const codes = Array.isArray(conditions) ? conditions.map(String) : [];
    if (!countsInBars(codes, typeof tape === 'string' ? tape : '')) return;
    const handlers = this.wanted.get(symbol)?.trades;
    if (!handlers) return;
    const trade: Trade = { price, quantity: size, time };
    for (const handler of [...handlers]) handler(trade);
  }

  private onQuote(message: Record<string, unknown>): void {
    const { S: symbol, bp: bid, ap: ask } = message;
    if (typeof symbol !== 'string' || typeof bid !== 'number' || typeof ask !== 'number') return;
    // A side with no orders, or a crossed market for a moment, isn't a quote to show.
    if (!(bid > 0) || !(ask > 0) || ask < bid) return;
    const handlers = this.wanted.get(symbol)?.quotes;
    if (!handlers) return;
    for (const handler of [...handlers]) handler({ bid, ask });
  }

  private onError(code: number, text: string): void {
    switch (code) {
      case 405: {
        // The plan's symbol limit: Alpaca refused the whole request and kept what it had.
        // Stream as many as it took; the rest stay on minute bars.
        const streaming = new Set([...this.confirmed.trades, ...this.confirmed.quotes]).size;
        this.maxSymbols = Math.max(1, Math.min(this.maxSymbols - 1, streaming));
        this.warn(`Alpaca streams at most ${this.maxSymbols} symbols on this plan`);
        this.upstream = copy(this.confirmed);
        this.sync();
        return;
      }
      case 402:
      case 409:
        // A refused key or a feed the plan lacks: not until the key changes.
        this.warn(`Alpaca's stream refused the key (${code} ${text}); prices update each minute`);
        this.stopped = true;
        this.drop();
        return;
      case 406:
        // Another app is using the key's one connection: try again later.
        this.warn("Alpaca's stream is in use by another app on this key; trying again later");
        this.drop(this.retryAfterRefusalMs);
        return;
      default:
        this.warn(`Alpaca stream error ${code}: ${text}`);
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.ready = false;
    this.upstream = { trades: new Set(), quotes: new Set() };
    this.stopHeartbeat();
    this.scheduleReconnect(this.reconnectDelayMs(this.attempt++));
  }

  /** Closes the connection; a reconnect follows after `retryMs` unless none is wanted. */
  private drop(retryMs?: number): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.upstream = { trades: new Set(), quotes: new Set() };
    this.stopHeartbeat();
    if (socket) {
      socket.removeAllListeners('close');
      socket.on('error', () => {});
      socket.terminate();
    }
    if (retryMs !== undefined) this.scheduleReconnect(retryMs);
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.closed || this.stopped || this.wanted.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private scheduleIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.wanted.size === 0) this.drop();
    }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }

  /** Pings now and then; a link that stays silent after one is replaced. */
  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.pongTimer) return;
      socket.ping();
      this.pongTimer = setTimeout(() => {
        this.warn('Alpaca stream went silent; reconnecting');
        socket.terminate();
      }, 10_000);
    }, 20_000);
    this.pingTimer.unref?.();
  }

  private stopHeartbeat(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }
}
