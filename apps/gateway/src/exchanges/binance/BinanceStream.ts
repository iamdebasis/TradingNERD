import {
  parseFrame,
  StreamClient,
  type StreamClientOptions,
  type StreamProtocol,
} from '../../stream/StreamClient.ts';

export interface BinanceStreamOptions extends StreamClientOptions {
  /** Combined-stream endpoint, e.g. wss://stream.binance.com:9443/stream */
  url: string;
  /** Streams per SUBSCRIBE / UNSUBSCRIBE message. */
  maxStreamsPerMessage?: number;
}

/** Binance's combined streams: SUBSCRIBE / UNSUBSCRIBE by stream name; WebSocket pings. */
function binanceProtocol(maxStreamsPerMessage: number): StreamProtocol {
  return {
    name: 'Binance',
    maxTopicsPerMessage: maxStreamsPerMessage,
    subscribe: (params, id) => [JSON.stringify({ method: 'SUBSCRIBE', params, id })],
    unsubscribe: (params, id) => [JSON.stringify({ method: 'UNSUBSCRIBE', params, id })],
    pingMessage: null,
    route(text, warn) {
      const message = parseFrame(text, 'Binance', warn);
      if (!message) return [];
      if (typeof message.stream === 'string')
        return [{ topic: message.stream, data: message.data }];
      if (message.error !== undefined) {
        warn(`Binance rejected a request: ${JSON.stringify(message.error)}`);
      }
      return [];
    },
  };
}

/**
 * One multiplexed connection to Binance's combined-stream endpoint. Binance allows 5 incoming
 * messages a second, hence a 250 ms gap between control messages; it also drops every
 * connection after 24 hours, which the reconnect covers.
 */
export class BinanceStream extends StreamClient {
  constructor(options: BinanceStreamOptions) {
    super(binanceProtocol(options.maxStreamsPerMessage ?? 200), {
      ...options,
      pingIntervalMs: options.pingIntervalMs ?? 30_000,
    });
  }

  /** Active upstream streams; exposed for tests and diagnostics. */
  streams(): string[] {
    return this.topics();
  }
}
